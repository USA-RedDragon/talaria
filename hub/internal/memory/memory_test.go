package memory_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/memory"
	"github.com/USA-RedDragon/talaria/hub/internal/memory/memorytest"
)

const (
	alice  = "alice"
	bob    = "bob"
	pcID   = "pc"
	homeID = "home"

	zstdAlways = "Use zstd always."
)

// access lets alice use pc and bob use home.
type access struct{}

func (access) Allowed(_ context.Context, user, backendID string) error {
	if (user == alice && backendID == pcID) || (user == bob && backendID == homeID) {
		return nil
	}
	if backendID != pcID && backendID != homeID {
		return hub.ErrUnknownBackend
	}
	return hub.ErrForbidden
}

func (access) Backends(_ context.Context, user string) ([]hub.Backend, error) {
	switch user {
	case alice:
		return []hub.Backend{{ID: pcID, Name: "PC"}}, nil
	case bob:
		return []hub.Backend{{ID: homeID, Name: "Home"}}, nil
	}
	return nil, nil
}

func sampleNotes() hub.Notes {
	return hub.Notes{Targets: map[string]hub.NoteStore{
		hub.TargetMemory: {File: "/data/memories/MEMORY.md", Limit: 2200, Used: 9, Enabled: true, Entries: []string{"Use zstd."}},
		hub.TargetUser:   {File: "/data/memories/USER.md", Limit: 1375, Enabled: true},
	}, Pending: []hub.PendingNote{{ID: "ab12", Target: hub.TargetMemory, Changes: []hub.NoteChange{{Action: "add", Content: "Backups at 02:00."}}}}}
}

type env struct {
	svc      *memory.Service
	pc, home *memorytest.Plugin
}

func setup(t *testing.T) *env {
	t.Helper()
	pc, home := memorytest.NewPlugin(sampleNotes()), memorytest.NewPlugin(sampleNotes())
	t.Cleanup(pc.Close)
	t.Cleanup(home.Close)
	home.Missing = true
	backends := []config.Backend{
		{ID: pcID},
		{ID: homeID},
	}
	svc, err := memory.New(memory.Options{Access: access{}, Backends: backends,
		Requesters: map[string]device.Requester{pcID: pc, homeID: home}})
	if err != nil {
		t.Fatal(err)
	}
	return &env{svc: svc, pc: pc, home: home}
}

func status(err error) int {
	var me *hub.MemoryError
	if errors.As(err, &me) {
		return me.Status
	}
	return 0
}

func TestBackendsAndAccess(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	bs, err := e.svc.MemoryBackends(ctx, alice)
	if err != nil || len(bs) != 1 || bs[0].ID != pcID || !bs[0].Notes || bs[0].Pending != 1 {
		t.Fatalf("alice backends = %+v, %v", bs, err)
	}
	bs, err = e.svc.MemoryBackends(ctx, bob)
	if err != nil || len(bs) != 0 {
		t.Fatalf("bob backends = %+v, %v", bs, err)
	}
	if _, err := e.svc.Notes(ctx, bob, pcID); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob notes on pc: %v", err)
	}
	if _, err := e.svc.Notes(ctx, bob, homeID); !errors.Is(err, hub.ErrNoMemory) {
		t.Fatalf("notes without routes: %v", err)
	}
	if _, err := e.svc.ChangeNote(ctx, bob, pcID, hub.TargetMemory, hub.NoteAdd, "", "x", nil); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob change on pc: %v", err)
	}
	if n := len(e.pc.Requests()); n != 1 {
		t.Fatalf("pc plugin got %d requests, want only alice's listing", n)
	}
}

func TestNotes(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	n, err := e.svc.ChangeNote(ctx, alice, pcID, hub.TargetMemory, hub.NoteEdit, "Use zstd.", zstdAlways, nil)
	if err != nil || !slices.Equal(n.Targets[hub.TargetMemory].Entries, []string{zstdAlways}) {
		t.Fatalf("edit = %+v, %v", n, err)
	}
	last := lastPluginRequest(e.pc)
	if last.Method != http.MethodPost || last.Path != "/api/plugins/device/memory/memory/edit" ||
		last.Body["entry"] != "Use zstd." || last.Body["content"] != zstdAlways {
		t.Fatalf("edit request = %+v", last)
	}
	if _, err := e.svc.ChangeNote(ctx, alice, pcID, hub.TargetUser, hub.NoteReplace, "", "a\n§\nb", []string{zstdAlways}); err != nil {
		t.Fatal(err)
	}
	if last := lastPluginRequest(e.pc); last.Body["text"] != "a\n§\nb" || fmt.Sprint(last.Body["base"]) != "["+zstdAlways+"]" {
		t.Fatalf("replace request = %+v", last)
	}
	if _, err := e.svc.ChangeNote(ctx, alice, pcID, "../config", hub.NoteAdd, "", "x", nil); status(err) != http.StatusNotFound {
		t.Fatalf("bad target: %v", err)
	}
	if _, err := e.svc.ChangeNote(ctx, alice, pcID, hub.TargetMemory, "wipe", "", "x", nil); status(err) != http.StatusNotFound {
		t.Fatalf("bad op: %v", err)
	}
	if _, err := e.svc.ResolvePending(ctx, alice, pcID, "../x", true); status(err) != http.StatusNotFound {
		t.Fatalf("bad pending id: %v", err)
	}
	n, err = e.svc.ResolvePending(ctx, alice, pcID, "ab12", true)
	if err != nil || len(n.Pending) != 0 || !slices.Contains(n.Targets[hub.TargetMemory].Entries, "Backups at 02:00.") {
		t.Fatalf("approve = %+v, %v", n, err)
	}
	if _, err := e.svc.ResolvePending(ctx, alice, pcID, "ab12", false); status(err) != http.StatusNotFound {
		t.Fatalf("reject gone: %v", err)
	}
	n, err = e.svc.SetApproval(ctx, alice, pcID, true)
	if err != nil || !n.Approval {
		t.Fatalf("approval = %+v, %v", n, err)
	}
	put := slices.IndexFunc(e.pc.Requests(), func(r memorytest.Request) bool { return r.Method == http.MethodPut })
	if put < 0 || e.pc.Requests()[put].Path != "/api/config" {
		t.Fatalf("no PUT /api/config: %+v", e.pc.Requests())
	}
	e.pc.Refuse = "That would put MEMORY.md over its limit of 2,200 characters."
	_, err = e.svc.ChangeNote(ctx, alice, pcID, hub.TargetMemory, hub.NoteAdd, "", "x", nil)
	if status(err) != http.StatusConflict || !strings.Contains(err.Error(), "2,200") {
		t.Fatalf("refusal = %v", err)
	}
}

const (
	demoID       = "github.com-alice-demo"
	demoIdentity = "github.com/alice/demo"
)

func demoProject() hub.Project {
	return hub.Project{ID: demoID, Identity: demoIdentity, Kind: hub.ProjectRemote, Name: "demo",
		Aliases: []string{"git.example.com/alice/demo"}, Folders: []hub.SeenFolder{{DeviceID: "d1", Device: "laptop", Dir: "/home/alice/src/demo", SeenAt: 1731300000.5}}}
}

func TestProjects(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	e.pc.AddProject(demoProject(), "Run make check.")
	e.pc.AddProject(hub.Project{ID: "root-abc", Identity: "root:abc", Kind: hub.ProjectRoot, Name: "scratch"})
	ps, err := e.svc.Projects(ctx, alice, pcID)
	if err != nil || len(ps) != 2 || ps[0].Identity != demoIdentity || ps[0].Aliases[0] != "git.example.com/alice/demo" ||
		ps[0].Folders[0].Device != "laptop" || ps[1].Aliases == nil || ps[1].Folders == nil {
		t.Fatalf("projects = %+v, %v", ps, err)
	}
	if last := e.pc.Requests()[len(e.pc.Requests())-1]; last.Method != http.MethodGet || last.Path != "/api/plugins/project-memory/projects" {
		t.Fatalf("list request = %+v", last)
	}
	pn, err := e.svc.ProjectNotes(ctx, alice, pcID, demoID)
	if err != nil || pn.Project.Name != "demo" || !slices.Equal(pn.Targets[hub.TargetMemory].Entries, []string{"Run make check."}) ||
		pn.Targets[hub.TargetUser].Entries == nil || pn.Pending == nil {
		t.Fatalf("project notes = %+v, %v", pn, err)
	}
	before := len(e.pc.Requests())
	for _, id := range []string{"..", "a/b", "", "%2e%2e"} {
		if _, err := e.svc.ProjectNotes(ctx, alice, pcID, id); status(err) != http.StatusNotFound {
			t.Fatalf("bad id %q: %v", id, err)
		}
	}
	if after := len(e.pc.Requests()); after != before {
		t.Fatalf("bad ids reached Hermes: %d requests", after-before)
	}
	_, err = e.svc.ProjectNotes(ctx, alice, pcID, "github.com-bob-other")
	if status(err) != http.StatusNotFound || err.Error() != "no such project" {
		t.Fatalf("unknown project = %v", err)
	}
	if _, err := e.svc.Projects(ctx, bob, pcID); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob projects on pc: %v", err)
	}
	if _, err := e.svc.ChangeProjectNote(ctx, bob, pcID, demoID, hub.NoteAdd, "", "x", nil); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob change on pc: %v", err)
	}
	e.pc.NoProjects = true
	if _, err := e.svc.Projects(ctx, alice, pcID); !errors.Is(err, hub.ErrNoMemory) {
		t.Fatalf("projects without the plugin: %v", err)
	}
	if _, err := e.svc.ProjectNotes(ctx, alice, pcID, demoID); !errors.Is(err, hub.ErrNoMemory) {
		t.Fatalf("project notes without the plugin: %v", err)
	}
}

// lastPluginRequest is the last request that was not the project-memory
// plugin's pending list, which the notes routes read after each answer.
func lastPluginRequest(p *memorytest.Plugin) memorytest.Request {
	reqs := p.Requests()
	for i := len(reqs) - 1; i > 0; i-- {
		if reqs[i].Path != "/api/plugins/project-memory/pending" {
			return reqs[i]
		}
	}
	return reqs[0]
}

func TestPendingProjectWrites(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	n, err := e.svc.Notes(ctx, alice, pcID)
	if err != nil || len(n.Pending) != 1 || n.Pending[0].Project != "" {
		t.Fatalf("untagged notes = %+v, %v", n.Pending, err)
	}
	e.pc.ProjectPending = map[string]string{"ab12": demoIdentity, "zz99": "github.com/alice/other"}
	n, err = e.svc.Notes(ctx, alice, pcID)
	if err != nil || len(n.Pending) != 1 || n.Pending[0].Project != demoIdentity {
		t.Fatalf("tagged notes = %+v, %v", n.Pending, err)
	}
	e.pc.NoProjects = true
	n, err = e.svc.Notes(ctx, alice, pcID)
	if err != nil || len(n.Pending) != 1 || n.Pending[0].Project != "" {
		t.Fatalf("notes without the plugin = %+v, %v", n.Pending, err)
	}
}

func TestProjectChanges(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	e.pc.AddProject(demoProject(), "Run make check.")
	pn, err := e.svc.ChangeProjectNote(ctx, alice, pcID, demoID, hub.NoteEdit, "Run make check.", "Run make test.", nil)
	if err != nil || !slices.Equal(pn.Targets[hub.TargetMemory].Entries, []string{"Run make test."}) {
		t.Fatalf("edit = %+v, %v", pn, err)
	}
	last := e.pc.Requests()[len(e.pc.Requests())-1]
	if last.Method != http.MethodPost || last.Path != "/api/plugins/project-memory/projects/"+demoID+"/memory/edit" ||
		last.Body["entry"] != "Run make check." || last.Body["content"] != "Run make test." {
		t.Fatalf("edit request = %+v", last)
	}
	if _, err := e.svc.ChangeProjectNote(ctx, alice, pcID, demoID, hub.NoteReplace, "", "a\n§\nb", nil); err != nil {
		t.Fatal(err)
	}
	if last := e.pc.Requests()[len(e.pc.Requests())-1]; last.Body["text"] != "a\n§\nb" || fmt.Sprint(last.Body["base"]) != "[]" {
		t.Fatalf("replace request = %+v", last)
	}
	pn, err = e.svc.ChangeProjectNote(ctx, alice, pcID, demoID, hub.NoteRemove, "a", "", nil)
	if err != nil || !slices.Equal(pn.Targets[hub.TargetMemory].Entries, []string{"b"}) {
		t.Fatalf("remove = %+v, %v", pn, err)
	}
	if _, err := e.svc.ChangeProjectNote(ctx, alice, pcID, demoID, "wipe", "", "x", nil); status(err) != http.StatusNotFound {
		t.Fatalf("bad op: %v", err)
	}
	e.pc.Refuse = "That would put MEMORY.md over its limit of 3,500 characters."
	if _, err := e.svc.ChangeProjectNote(ctx, alice, pcID, demoID, hub.NoteAdd, "", "x", nil); status(err) != http.StatusConflict || !strings.Contains(err.Error(), "3,500") {
		t.Fatalf("refusal = %v", err)
	}
}

const skillLayout = "demo-layout"

func TestProjectSkills(t *testing.T) {
	t.Parallel()
	e := setup(t)
	ctx := context.Background()
	e.pc.AddProject(demoProject(), "Run make check.")
	e.pc.AddProjectSkill(demoID, hub.ProjectSkillDoc{ProjectSkill: hub.ProjectSkill{Name: skillLayout, Path: skillLayout, Enabled: true}, Content: "# layout"})
	ps, err := e.svc.ProjectSkills(ctx, alice, pcID, demoID)
	if err != nil || len(ps.Skills) != 1 || ps.Skills[0].Name != skillLayout || ps.Project.Name != demoProject().Name {
		t.Fatalf("skills = %+v, %v", ps, err)
	}
	doc, err := e.svc.ProjectSkill(ctx, alice, pcID, demoID, skillLayout)
	if err != nil || doc.Content != "# layout" || doc.Files == nil {
		t.Fatalf("skill = %+v, %v", doc, err)
	}
	before := len(e.pc.Requests())
	for _, bad := range []struct{ id, name string }{{"..", skillLayout}, {demoID, ".."}, {demoID, "a/b"}, {demoID, "-x"}, {demoID, strings.Repeat("a", 200)}} {
		if _, err := e.svc.ProjectSkill(ctx, alice, pcID, bad.id, bad.name); status(err) != http.StatusNotFound {
			t.Fatalf("bad skill %+v: %v", bad, err)
		}
		if _, err := e.svc.DeleteProjectSkill(ctx, alice, pcID, bad.id, bad.name); status(err) != http.StatusNotFound {
			t.Fatalf("bad delete %+v: %v", bad, err)
		}
	}
	if after := len(e.pc.Requests()); after != before {
		t.Fatalf("bad names reached Hermes: %d requests", after-before)
	}
	if _, err := e.svc.ProjectSkills(ctx, bob, pcID, demoID); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob skills on pc: %v", err)
	}
	if _, err := e.svc.DeleteProjectSkill(ctx, bob, pcID, demoID, skillLayout); !errors.Is(err, hub.ErrForbidden) {
		t.Fatalf("bob delete on pc: %v", err)
	}
	if ps, err = e.svc.DeleteProjectSkill(ctx, alice, pcID, demoID, skillLayout); err != nil || len(ps.Skills) != 0 || ps.Skills == nil {
		t.Fatalf("delete = %+v, %v", ps, err)
	}
	if _, err := e.svc.ProjectSkill(ctx, alice, pcID, demoID, skillLayout); status(err) != http.StatusNotFound {
		t.Fatalf("skill after delete: %v", err)
	}
	e.pc.NoProjects = true
	if _, err := e.svc.ProjectSkills(ctx, alice, pcID, demoID); !errors.Is(err, hub.ErrNoMemory) {
		t.Fatalf("skills without the plugin: %v", err)
	}
}
