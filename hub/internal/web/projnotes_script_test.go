package web_test

import (
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/memory"
	"github.com/USA-RedDragon/talaria/hub/internal/memory/memorytest"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

// A project's notes on the Memory page have four parts: the index (the
// lines every chat reads, with a meter for the index only, and a link from
// a line to the topic it points to), topics (open, edit, create, delete
// with a confirm), path notes (their patterns and text) and skills.
// testdata/projnotes/run.js drives the real page in headless Chrome at 412
// and 1280 px, light and dark. PROJNOTES_SHOT=dir also writes
// project-notes-v2-build-*.png. It skips where node or Chrome is missing.
func TestProjectNotesPages(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	notes := hub.Notes{Targets: map[string]hub.NoteStore{
		hub.TargetMemory: {Limit: 2200, Enabled: true, Entries: []string{"Use zstd."}},
		hub.TargetUser:   {Limit: 1375, Enabled: true},
	}, Pending: []hub.PendingNote{}}
	pcM, homeM := memorytest.NewPlugin(notes), memorytest.NewPlugin(notes)
	t.Cleanup(pcM.Close)
	t.Cleanup(homeM.Close)
	const demo = "github.com-alice-demo-app"
	pcM.AddProject(hub.Project{ID: demo, Identity: "github.com/alice/demo-app", Kind: hub.ProjectRemote, Name: "demo-app", Skills: 1},
		"Build with `make dev`; tests need Redis on port 6390.",
		"Release flow: tag on main after green CI, never on a bot commit. -> topic: release",
		"PPU timing rules and the mid-scanline quirks. -> topic: gb-timing",
		"Owners: emulator core Alice; web UI Bob.")
	pcM.AddProjectSkill(demo, hub.ProjectSkillDoc{ProjectSkill: hub.ProjectSkill{Name: "demo-app-release", Path: "demo-app-release", Description: "Use when cutting a demo-app release.", Enabled: true}, Content: "# release"})
	topic := func(name, desc, text string, linked bool) {
		pcM.AddProjectDoc(demo, hub.DocTopics, hub.ProjectDocText{ProjectDoc: hub.ProjectDoc{Name: name, Description: desc, Modified: "2026-11-13", InIndex: linked}, Content: text})
	}
	topic("gb-timing", "PPU modes, STAT interrupts, mid-scanline writes", "# PPU timing\n\n- Mode 3 length varies with sprites on the line.\n- A write to SCX during mode 3 shows from the next tile fetch.", true)
	topic("inbox", "Notes saved while the index was full; sort them into topics", "## 2026-11-14 unsorted\n\nDeploys come from the release branch.", false)
	topic("mbc-quirks", "Bank switching edge cases in MBC1, MBC3 and MBC5", "MBC1 bank 0x20 maps to 0x21.", false)
	topic("release", "How a release is cut, step by step", "1. Tag on main.\n2. Wait for CI.", true)
	pcM.AddProjectDoc(demo, hub.DocPaths, hub.ProjectDocText{ProjectDoc: hub.ProjectDoc{Name: "ppu-code", Modified: "2026-11-12", Paths: []string{"src/ppu/**", "src/video/*.rs"}}, Content: "Keep the dot-accurate loop in ppu/fetch.rs; never batch a scanline."})
	pcM.AddProjectDoc(demo, hub.DocPaths, hub.ProjectDocText{ProjectDoc: hub.ProjectDoc{Name: "web-ui", Modified: "2026-11-02", Paths: []string{"web/**/*.ts", "web/**/*.css"}}, Content: "The web UI builds with pnpm, not npm."})
	pcM.SetProjectIndex(demo, 300, 1)

	var e *hubEnv
	e = setupWith(t, func(cfg *config.Config, opts *web.Options, _ *store.Store) {
		if err := cfg.Validate(); err != nil {
			t.Fatal(err)
		}
		m, err := memory.New(memory.Options{Access: lateAccess{&e}, Backends: cfg.Backends,
			Requesters: map[string]device.Requester{"pc": pcM, backendHome: homeM}})
		if err != nil {
			t.Fatal(err)
		}
		opts.Memory = m
	})
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "projnotes", "run.js"), chrome, e.url, prof, demo).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	// The page's changes reached the plugin as asked.
	var calls []string
	for _, r := range pcM.Requests() {
		if r.Method == http.MethodPut || r.Method == http.MethodDelete {
			calls = append(calls, r.Method+" "+strings.TrimPrefix(r.Path, "/api/plugins/project-memory/projects/"+demo))
		}
	}
	want := []string{"PUT /topics/gb-timing", "PUT /topics/audio-apu", "DELETE /topics/mbc-quirks", "PUT /paths/ppu-code"}
	if strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("plugin changes = %v, want %v", calls, want)
	}
	for _, r := range pcM.Requests() {
		if r.Method == http.MethodPut && strings.HasSuffix(r.Path, "/paths/ppu-code") {
			b, err := json.Marshal(r.Body["paths"])
			if err != nil || string(b) != `["src/ppu/**","src/lcd/**"]` {
				t.Fatalf("path note patterns = %s", b)
			}
		}
	}
}
