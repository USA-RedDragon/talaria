// Package memorytest has fakes of the talaria device plugin's memory routes, for tests.
package memorytest

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// Request is a request a fake got.
type Request struct {
	Method, Path, Query, Auth string
	Body                      map[string]any
}

type recorder struct {
	mu   sync.Mutex
	reqs []Request
}

func (r *recorder) record(req *http.Request) map[string]any {
	var body map[string]any
	b, _ := io.ReadAll(req.Body)
	_ = json.Unmarshal(b, &body)
	r.mu.Lock()
	r.reqs = append(r.reqs, Request{Method: req.Method, Path: req.URL.Path, Query: req.URL.RawQuery, Auth: req.Header.Get("Authorization"), Body: body})
	r.mu.Unlock()
	return body
}

// Requests returns the requests so far.
func (r *recorder) Requests() []Request {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.reqs)
}

const (
	keyDetail = "detail"
	keyError  = "error"
	keyMsg    = "message"
	notFound  = "Not Found"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(b)
}

// Plugin fakes a backend's dashboard: the device plugin's memory routes and
// PUT /api/config. It keeps notes in memory and applies changes simply.
type Plugin struct {
	recorder
	srv *httptest.Server
	// Missing makes every memory route answer 404 as a dashboard without
	// them does.
	Missing bool
	// NoProjects makes every project-memory route answer 404 as a
	// dashboard without that plugin does.
	NoProjects bool
	// ProjectPending maps the id of a pending write to the identity of the
	// project it is for, as the project-memory plugin's /pending lists it.
	ProjectPending map[string]string
	// Refuse makes changes answer 409 with this message.
	Refuse   string
	mu       sync.Mutex
	notes    hub.Notes
	projects []hub.ProjectNotes
	skills   map[string][]hub.ProjectSkillDoc
	docs     map[string][]hub.ProjectDocText
}

// AddProjectDoc gives a project a topic (kind hub.DocTopics) or a path note
// (hub.DocPaths), as the project-memory plugin would keep it.
func (p *Plugin) AddProjectDoc(projectID, kind string, d hub.ProjectDocText) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.docs == nil {
		p.docs = map[string][]hub.ProjectDocText{}
	}
	d.Size = len(d.Content)
	p.docs[projectID+"/"+kind] = append(p.docs[projectID+"/"+kind], d)
	p.syncDocs(projectID)
}

func (p *Plugin) docList(projectID, kind string) []hub.ProjectDoc {
	out := make([]hub.ProjectDoc, 0, len(p.docs[projectID+"/"+kind]))
	for _, d := range p.docs[projectID+"/"+kind] {
		out = append(out, d.ProjectDoc)
	}
	return out
}

// syncDocs keeps a project's counts and lists in step with its docs.
func (p *Plugin) syncDocs(projectID string) {
	i := slices.IndexFunc(p.projects, func(x hub.ProjectNotes) bool { return x.Project.ID == projectID })
	if i < 0 {
		return
	}
	pn := &p.projects[i]
	pn.Topics, pn.PathNotes = p.docList(projectID, hub.DocTopics), p.docList(projectID, hub.DocPaths)
	pn.Project.Topics, pn.Project.PathNotes = len(pn.Topics), len(pn.PathNotes)
	pn.Project.Total = pn.Project.Used
	for _, d := range append(slices.Clone(pn.Topics), pn.PathNotes...) {
		pn.Project.Total += d.Size
	}
}

func (p *Plugin) serveDocs(w http.ResponseWriter, method string, pn *hub.ProjectNotes, parts []string, body map[string]any) {
	id, kind := pn.Project.ID, parts[1]
	key := id + "/" + kind
	if len(parts) == 2 && method == http.MethodGet {
		writeJSON(w, http.StatusOK, hub.ProjectDocs{Items: p.docList(id, kind), Inbox: pn.Inbox})
		return
	}
	if len(parts) != 3 {
		writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
		return
	}
	list := p.docs[key]
	i := slices.IndexFunc(list, func(d hub.ProjectDocText) bool { return d.Name == parts[2] })
	switch method {
	case http.MethodGet, http.MethodDelete:
		if i < 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{keyError: "unknown_doc", keyMsg: "This project has no such topic."})
			return
		}
		if method == http.MethodGet {
			writeJSON(w, http.StatusOK, list[i])
			return
		}
		p.docs[key] = slices.Delete(list, i, i+1)
		p.syncDocs(id)
		writeJSON(w, http.StatusOK, hub.ProjectDocs{Items: p.docList(id, kind), Inbox: pn.Inbox})
		return
	case http.MethodPut:
		str := func(k string) string { s, _ := body[k].(string); return s }
		if create, _ := body["create"].(bool); create && i >= 0 {
			writeJSON(w, http.StatusConflict, map[string]string{keyError: "exists", keyMsg: "There is already a topic named " + parts[2] + "."})
			return
		}
		if base, ok := body["base"].(string); ok && i >= 0 && base != list[i].Content {
			writeJSON(w, http.StatusConflict, map[string]string{keyError: "changed", keyMsg: "This changed since you opened it. Reload and try again."})
			return
		}
		d := hub.ProjectDocText{ProjectDoc: hub.ProjectDoc{Name: parts[2], Description: str("description"), Modified: "2026-11-14"}, Content: str("content")}
		if name := str("name"); name != "" {
			d.Name = name
		}
		if ps, ok := body["paths"].([]any); ok {
			for _, x := range ps {
				if s, ok := x.(string); ok {
					d.Paths = append(d.Paths, s)
				}
			}
		} else if i >= 0 {
			d.Paths = list[i].Paths
		}
		if kind == hub.DocPaths && len(d.Paths) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{keyError: "bad_request", keyMsg: "a path note needs paths"})
			return
		}
		d.Size = len(d.Content)
		if i >= 0 {
			d.InIndex = list[i].InIndex
			list[i] = d
		} else {
			list = append(list, d)
		}
		slices.SortFunc(list, func(a, b hub.ProjectDocText) int { return strings.Compare(a.Name, b.Name) })
		p.docs[key] = list
		p.syncDocs(id)
		d.List = p.docList(id, kind)
		writeJSON(w, http.StatusOK, d)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
}

// AddProjectSkill gives a project a skill, as the project-memory plugin
// would list it.
func (p *Plugin) AddProjectSkill(projectID string, sk hub.ProjectSkillDoc) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.skills == nil {
		p.skills = map[string][]hub.ProjectSkillDoc{}
	}
	if sk.Files == nil {
		sk.Files = []string{}
	}
	p.skills[projectID] = append(p.skills[projectID], sk)
}

func (p *Plugin) skillList(pn *hub.ProjectNotes) hub.ProjectSkills {
	out := hub.ProjectSkills{Project: hub.ProjectRef{ID: pn.Project.ID, Identity: pn.Project.Identity, Name: pn.Project.Name}, Skills: []hub.ProjectSkill{}}
	for _, d := range p.skills[pn.Project.ID] {
		out.Skills = append(out.Skills, d.ProjectSkill)
	}
	return out
}

func (p *Plugin) serveSkills(w http.ResponseWriter, method string, pn *hub.ProjectNotes, parts []string) {
	switch {
	case method == http.MethodGet && len(parts) == 2:
		writeJSON(w, http.StatusOK, p.skillList(pn))
		return
	case len(parts) == 3 && (method == http.MethodGet || method == http.MethodDelete):
		list := p.skills[pn.Project.ID]
		i := slices.IndexFunc(list, func(d hub.ProjectSkillDoc) bool { return d.Name == parts[2] })
		if i < 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{keyError: "unknown_skill", keyMsg: "This project has no such skill."})
			return
		}
		if method == http.MethodGet {
			writeJSON(w, http.StatusOK, list[i])
			return
		}
		p.skills[pn.Project.ID] = slices.Delete(list, i, i+1)
		writeJSON(w, http.StatusOK, p.skillList(pn))
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
}

// AddProject adds a project whose MEMORY.md holds entries.
func (p *Plugin) AddProject(pr hub.Project, entries ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if entries == nil {
		entries = []string{}
	}
	p.projects = append(p.projects, hub.ProjectNotes{Project: pr, Topics: []hub.ProjectDoc{}, PathNotes: []hub.ProjectDoc{}, Notes: hub.Notes{Targets: map[string]hub.NoteStore{
		hub.TargetMemory: {File: "/data/projects/" + pr.ID + "/MEMORY.md", Limit: 3500, Enabled: true, Entries: entries},
		hub.TargetUser:   {Entries: []string{}},
	}, Pending: []hub.PendingNote{}}})
}

// SetProjectIndex sets a project's index budget, counts what its entries
// use, and how many notes its inbox topic holds.
func (p *Plugin) SetProjectIndex(projectID string, limit, inbox int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	i := slices.IndexFunc(p.projects, func(x hub.ProjectNotes) bool { return x.Project.ID == projectID })
	if i < 0 {
		return
	}
	pn := &p.projects[i]
	st := pn.Targets[hub.TargetMemory]
	st.Limit, st.Used = limit, len(strings.Join(st.Entries, "\n§\n"))
	pn.Targets[hub.TargetMemory] = st
	pn.Project.Limit, pn.Project.Used, pn.Project.Count = limit, st.Used, len(st.Entries)
	pn.Inbox, pn.Project.Inbox = inbox, inbox
	p.syncDocs(projectID)
}

// NewPlugin starts a fake with notes.
func NewPlugin(notes hub.Notes) *Plugin {
	p := &Plugin{notes: notes}
	p.srv = httptest.NewServer(http.HandlerFunc(p.serve))
	return p
}

// URL is the fake's base URL.
func (p *Plugin) URL() string { return p.srv.URL }

// Close stops the fake.
func (p *Plugin) Close() { p.srv.Close() }

// Request sends one request to the fake, like *gateway.Dialer.
func (p *Plugin) Request(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	var r io.Reader
	if body != nil {
		r = strings.NewReader(string(body))
	}
	req, err := http.NewRequestWithContext(ctx, method, p.srv.URL+path, r)
	if err != nil {
		return nil, err
	}
	return p.srv.Client().Do(req)
}

func (p *Plugin) serve(w http.ResponseWriter, r *http.Request) {
	body := p.record(r)
	p.mu.Lock()
	defer p.mu.Unlock()
	if r.Method == http.MethodPut && r.URL.Path == "/api/config" {
		cfg, _ := body["config"].(map[string]any)
		mem, _ := cfg["memory"].(map[string]any)
		on, ok := mem["write_approval"].(bool)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{keyDetail: "bad"})
			return
		}
		p.notes.Approval = on
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if r.URL.Path == "/api/plugins/project-memory/pending" {
		if p.NoProjects {
			writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
			return
		}
		list := []map[string]string{}
		for id, identity := range p.ProjectPending {
			list = append(list, map[string]string{"id": id, "project": "slug", "identity": identity})
		}
		writeJSON(w, http.StatusOK, map[string]any{"pending": list})
		return
	}
	if rest, ok := strings.CutPrefix(r.URL.Path, "/api/plugins/project-memory/projects"); ok {
		p.serveProject(w, r.Method, rest, body)
		return
	}
	rest, ok := strings.CutPrefix(r.URL.Path, "/api/plugins/device/memory")
	if !ok || p.Missing {
		writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
		return
	}
	if r.Method == http.MethodGet && rest == "" {
		writeJSON(w, http.StatusOK, p.notes)
		return
	}
	if p.Refuse != "" {
		writeJSON(w, http.StatusConflict, map[string]string{keyError: "over_limit", keyMsg: p.Refuse})
		return
	}
	parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
	if len(parts) == 3 && parts[0] == "pending" {
		i := slices.IndexFunc(p.notes.Pending, func(x hub.PendingNote) bool { return x.ID == parts[1] })
		if i < 0 {
			writeJSON(w, http.StatusNotFound, map[string]string{keyError: "unknown_pending", keyMsg: "no such pending memory write"})
			return
		}
		rec := p.notes.Pending[i]
		p.notes.Pending = slices.Delete(p.notes.Pending, i, i+1)
		if parts[2] == "approve" {
			st := p.notes.Targets[rec.Target]
			for _, c := range rec.Changes {
				st.Entries = append(st.Entries, c.Content)
			}
			p.notes.Targets[rec.Target] = st
		}
		writeJSON(w, http.StatusOK, p.notes)
		return
	}
	if len(parts) != 2 {
		writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
		return
	}
	st, ok := p.notes.Targets[parts[0]]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{keyError: "unknown_target", keyMsg: "target must be memory or user"})
		return
	}
	if !apply(w, &st, parts[1], body) {
		return
	}
	p.notes.Targets[parts[0]] = st
	writeJSON(w, http.StatusOK, p.notes)
}

// apply makes one change to a store. It answers the refusal itself and
// returns false when it refuses.
func apply(w http.ResponseWriter, st *hub.NoteStore, op string, body map[string]any) bool {
	str := func(k string) string { s, _ := body[k].(string); return s }
	switch op {
	case "add":
		st.Entries = append(st.Entries, str("content"))
	case "edit":
		if i := slices.Index(st.Entries, str("entry")); i >= 0 {
			st.Entries[i] = str("content")
		}
	case "remove":
		st.Entries = slices.DeleteFunc(st.Entries, func(e string) bool { return e == str("entry") })
	case "replace":
		if _, ok := body["base"].([]any); !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{keyError: "bad_request", keyMsg: "base is required"})
			return false
		}
		st.Entries = strings.Split(str("text"), "\n§\n")
	}
	return true
}

func (p *Plugin) serveProject(w http.ResponseWriter, method, rest string, body map[string]any) {
	if p.NoProjects {
		writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
		return
	}
	if method == http.MethodGet && rest == "" {
		list := make([]hub.Project, 0, len(p.projects))
		for _, pn := range p.projects {
			list = append(list, pn.Project)
		}
		writeJSON(w, http.StatusOK, map[string]any{"projects": list})
		return
	}
	parts := strings.Split(strings.TrimPrefix(rest, "/"), "/")
	i := slices.IndexFunc(p.projects, func(x hub.ProjectNotes) bool { return x.Project.ID == parts[0] })
	if i < 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{keyError: "unknown_project", keyMsg: "no such project"})
		return
	}
	pn := &p.projects[i]
	switch {
	case len(parts) >= 2 && parts[1] == "skills":
		p.serveSkills(w, method, pn, parts)
		return
	case len(parts) >= 2 && (parts[1] == hub.DocTopics || parts[1] == hub.DocPaths):
		p.serveDocs(w, method, pn, parts, body)
		return
	case method == http.MethodGet && len(parts) == 1:
	case method == http.MethodPost && len(parts) == 3 && parts[1] == "memory":
		if p.Refuse != "" {
			writeJSON(w, http.StatusConflict, map[string]string{keyError: "over_limit", keyMsg: p.Refuse})
			return
		}
		st := pn.Targets[hub.TargetMemory]
		if !apply(w, &st, parts[2], body) {
			return
		}
		pn.Targets[hub.TargetMemory] = st
		pn.Project.Count = len(st.Entries)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{keyDetail: notFound})
		return
	}
	writeJSON(w, http.StatusOK, pn)
}
