// Package memory serves the hub's Memory page: Hermes's built-in memory
// (MEMORY.md and USER.md, through the talaria device plugin's memory routes)
// plus the project-memory plugin's projects.
package memory

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// Access says which backends a user may use. *service.Service is one.
type Access interface {
	Allowed(ctx context.Context, user, backendID string) error
	Backends(ctx context.Context, user string) ([]hub.Backend, error)
}

// Options are the dependencies of a Service.
type Options struct {
	Access   Access
	Backends []config.Backend
	// Requesters reach each backend's dashboard with the hub's session.
	Requesters map[string]device.Requester
	// ListTimeout bounds each backend's answer to MemoryBackends. Default
	// 5s.
	ListTimeout time.Duration
}

type backend struct {
	notes *notes
}

// Service implements hub.Memory.
type Service struct {
	access      Access
	backends    map[string]*backend
	listTimeout time.Duration
}

var _ hub.Memory = (*Service)(nil)

var (
	pendingIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	projectIDPattern = regexp.MustCompile(`^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,254}$`)
)

// New returns a Service.
func New(opts Options) (*Service, error) {
	if opts.ListTimeout == 0 {
		opts.ListTimeout = 5 * time.Second
	}
	s := &Service{access: opts.Access, backends: map[string]*backend{}, listTimeout: opts.ListTimeout}
	for _, b := range opts.Backends {
		mb := &backend{}
		if r := opts.Requesters[b.ID]; r != nil {
			mb.notes = &notes{r: r}
		}
		s.backends[b.ID] = mb
	}
	return s, nil
}

func (s *Service) backend(ctx context.Context, user, id string) (*backend, error) {
	if err := s.access.Allowed(ctx, user, id); err != nil {
		return nil, err
	}
	b, ok := s.backends[id]
	if !ok {
		return nil, hub.ErrUnknownBackend
	}
	return b, nil
}

func (s *Service) notes(ctx context.Context, user, id string) (*notes, error) {
	b, err := s.backend(ctx, user, id)
	if err != nil {
		return nil, err
	}
	if b.notes == nil {
		return nil, hub.ErrNoMemory
	}
	return b.notes, nil
}

// MemoryBackends lists the user's backends that have notes, with the number of memory writes waiting for approval. A backend
// whose Hermes cannot be asked shows with Error.
func (s *Service) MemoryBackends(ctx context.Context, user string) ([]hub.MemoryBackend, error) {
	bs, err := s.access.Backends(ctx, user)
	if err != nil {
		return nil, err
	}
	out := make([]hub.MemoryBackend, len(bs))
	keep := make([]bool, len(bs))
	var wg sync.WaitGroup
	for i, hb := range bs {
		b := s.backends[hb.ID]
		if b == nil {
			continue
		}
		out[i] = hub.MemoryBackend{ID: hb.ID, Name: hb.Name}
		if b.notes == nil {
			continue
		}
		wg.Go(func() {
			cctx, cancel := context.WithTimeout(ctx, s.listTimeout)
			defer cancel()
			n, err := b.notes.get(cctx)
			switch {
			case err == nil:
				out[i].Notes, out[i].Pending, keep[i] = true, len(n.Pending), true
			case errors.Is(err, hub.ErrNoMemory):
			default:
				out[i].Error, keep[i] = err.Error(), true
			}
		})
	}
	wg.Wait()
	list := []hub.MemoryBackend{}
	for i := range out {
		if keep[i] {
			list = append(list, out[i])
		}
	}
	return list, nil
}

// Notes reads the backend's MEMORY.md, USER.md and pending writes.
func (s *Service) Notes(ctx context.Context, user, backendID string) (hub.Notes, error) {
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return hub.Notes{}, err
	}
	out, err := n.get(ctx)
	return n.tagProjects(ctx, out, err)
}

// ChangeNote applies one change to MEMORY.md or USER.md.
func (s *Service) ChangeNote(ctx context.Context, user, backendID, target, op, entry, content string, base []string) (hub.Notes, error) {
	if target != hub.TargetMemory && target != hub.TargetUser {
		return hub.Notes{}, &hub.MemoryError{Status: http.StatusNotFound, Message: "unknown memory file"}
	}
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return hub.Notes{}, err
	}
	out, err := n.change(ctx, target, op, entry, content, base)
	return n.tagProjects(ctx, out, err)
}

// ResolvePending approves or rejects a memory write Hermes staged.
func (s *Service) ResolvePending(ctx context.Context, user, backendID, pendingID string, approve bool) (hub.Notes, error) {
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return hub.Notes{}, err
	}
	if !pendingIDPattern.MatchString(pendingID) {
		return hub.Notes{}, &hub.MemoryError{Status: http.StatusNotFound, Message: "That change is no longer waiting"}
	}
	out, err := n.resolve(ctx, pendingID, approve)
	return n.tagProjects(ctx, out, err)
}

// SetApproval turns on or off whether Hermes asks before it saves to
// memory.
func (s *Service) SetApproval(ctx context.Context, user, backendID string, on bool) (hub.Notes, error) {
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return hub.Notes{}, err
	}
	if err := n.setApproval(ctx, on); err != nil {
		return hub.Notes{}, err
	}
	out, err := n.get(ctx)
	return n.tagProjects(ctx, out, err)
}

// Projects lists the projects of the backend's project-memory plugin.
func (s *Service) Projects(ctx context.Context, user, backendID string) ([]hub.Project, error) {
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return nil, err
	}
	return n.projects(ctx)
}

func (s *Service) project(ctx context.Context, user, backendID, projectID string) (*notes, error) {
	n, err := s.notes(ctx, user, backendID)
	if err != nil {
		return nil, err
	}
	if !projectIDPattern.MatchString(projectID) {
		return nil, &hub.MemoryError{Status: http.StatusNotFound, Message: "The agent has no such project"}
	}
	return n, nil
}

// ProjectNotes reads a project's MEMORY.md.
func (s *Service) ProjectNotes(ctx context.Context, user, backendID, projectID string) (hub.ProjectNotes, error) {
	n, err := s.project(ctx, user, backendID, projectID)
	if err != nil {
		return hub.ProjectNotes{}, err
	}
	return n.projectNotes(ctx, projectID)
}

// ChangeProjectNote applies one change to a project's MEMORY.md.
func (s *Service) ChangeProjectNote(ctx context.Context, user, backendID, projectID, op, entry, content string, base []string) (hub.ProjectNotes, error) {
	n, err := s.project(ctx, user, backendID, projectID)
	if err != nil {
		return hub.ProjectNotes{}, err
	}
	return n.changeProject(ctx, projectID, op, entry, content, base)
}

// skillName bounds what the hub passes to the plugin as a skill's name: one
// path segment of plain characters.
var skillName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$`)

func (s *Service) skill(ctx context.Context, user, backendID, projectID, name string) (*notes, error) {
	n, err := s.project(ctx, user, backendID, projectID)
	if err != nil {
		return nil, err
	}
	if name != "" && !skillName.MatchString(name) {
		return nil, &hub.MemoryError{Status: http.StatusNotFound, Message: "The project has no such skill"}
	}
	return n, nil
}

// ProjectSkills lists a project's own skills.
func (s *Service) ProjectSkills(ctx context.Context, user, backendID, projectID string) (hub.ProjectSkills, error) {
	n, err := s.skill(ctx, user, backendID, projectID, "")
	if err != nil {
		return hub.ProjectSkills{}, err
	}
	var out hub.ProjectSkills
	if err := n.projectSkills(ctx, http.MethodGet, skillsBase(projectID), &out); err != nil {
		return hub.ProjectSkills{}, err
	}
	fillSkills(&out)
	return out, nil
}

// ProjectSkill reads one project skill.
func (s *Service) ProjectSkill(ctx context.Context, user, backendID, projectID, name string) (hub.ProjectSkillDoc, error) {
	n, err := s.skill(ctx, user, backendID, projectID, name)
	if err != nil {
		return hub.ProjectSkillDoc{}, err
	}
	var out hub.ProjectSkillDoc
	if err := n.projectSkills(ctx, http.MethodGet, skillsBase(projectID)+"/"+url.PathEscape(name), &out); err != nil {
		return hub.ProjectSkillDoc{}, err
	}
	if out.Files == nil {
		out.Files = []string{}
	}
	return out, nil
}

// DeleteProjectSkill removes one project skill and answers with the rest.
func (s *Service) DeleteProjectSkill(ctx context.Context, user, backendID, projectID, name string) (hub.ProjectSkills, error) {
	n, err := s.skill(ctx, user, backendID, projectID, name)
	if err != nil {
		return hub.ProjectSkills{}, err
	}
	var out hub.ProjectSkills
	if err := n.projectSkills(ctx, http.MethodDelete, skillsBase(projectID)+"/"+url.PathEscape(name), &out); err != nil {
		return hub.ProjectSkills{}, err
	}
	fillSkills(&out)
	return out, nil
}

// docName bounds a topic's or path note's name as the plugin does: 1 to 64
// lowercase letters, digits and dashes.
var docName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

func (s *Service) doc(ctx context.Context, user, backendID, projectID, kind, name string, named bool) (*notes, error) {
	n, err := s.project(ctx, user, backendID, projectID)
	if err != nil {
		return nil, err
	}
	if kind != hub.DocTopics && kind != hub.DocPaths {
		return nil, &hub.MemoryError{Status: http.StatusNotFound, Message: "Not found"}
	}
	if named && !docName.MatchString(name) {
		return nil, &hub.MemoryError{Status: http.StatusNotFound, Message: "The project has no such " + docWord(kind)}
	}
	return n, nil
}

func docWord(kind string) string {
	if kind == hub.DocPaths {
		return "path note"
	}
	return "topic"
}

// ProjectDocs lists a project's topics or path notes.
func (s *Service) ProjectDocs(ctx context.Context, user, backendID, projectID, kind string) (hub.ProjectDocs, error) {
	n, err := s.doc(ctx, user, backendID, projectID, kind, "", false)
	if err != nil {
		return hub.ProjectDocs{}, err
	}
	var out hub.ProjectDocs
	if err := n.send(ctx, http.MethodGet, docsBase(projectID, kind), nil, &out); err != nil {
		return hub.ProjectDocs{}, err
	}
	out.Items = fillDocs(out.Items)
	return out, nil
}

// ProjectDoc reads one topic or path note.
func (s *Service) ProjectDoc(ctx context.Context, user, backendID, projectID, kind, name string) (hub.ProjectDocText, error) {
	n, err := s.doc(ctx, user, backendID, projectID, kind, name, true)
	if err != nil {
		return hub.ProjectDocText{}, err
	}
	var out hub.ProjectDocText
	if err := n.send(ctx, http.MethodGet, docsBase(projectID, kind)+"/"+name, nil, &out); err != nil {
		return hub.ProjectDocText{}, err
	}
	return out, nil
}

// PutProjectDoc creates or changes one topic or path note.
func (s *Service) PutProjectDoc(ctx context.Context, user, backendID, projectID, kind, name string, in hub.ProjectDocInput) (hub.ProjectDocText, error) {
	n, err := s.doc(ctx, user, backendID, projectID, kind, name, true)
	if err != nil {
		return hub.ProjectDocText{}, err
	}
	if in.Name != "" && !docName.MatchString(in.Name) {
		return hub.ProjectDocText{}, &hub.MemoryError{Status: http.StatusBadRequest, Message: "A name is 1 to 64 lowercase letters, digits and dashes"}
	}
	if strings.TrimSpace(in.Content) == "" {
		return hub.ProjectDocText{}, &hub.MemoryError{Status: http.StatusBadRequest, Message: "The text is empty"}
	}
	var out hub.ProjectDocText
	if err := n.send(ctx, http.MethodPut, docsBase(projectID, kind)+"/"+name, in, &out); err != nil {
		return hub.ProjectDocText{}, err
	}
	out.List = fillDocs(out.List)
	return out, nil
}

// DeleteProjectDoc removes one topic or path note and answers with the rest.
func (s *Service) DeleteProjectDoc(ctx context.Context, user, backendID, projectID, kind, name string) (hub.ProjectDocs, error) {
	n, err := s.doc(ctx, user, backendID, projectID, kind, name, true)
	if err != nil {
		return hub.ProjectDocs{}, err
	}
	var out hub.ProjectDocs
	if err := n.send(ctx, http.MethodDelete, docsBase(projectID, kind)+"/"+name, nil, &out); err != nil {
		return hub.ProjectDocs{}, err
	}
	out.Items = fillDocs(out.Items)
	return out, nil
}
