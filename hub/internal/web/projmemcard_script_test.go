package web_test

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A project_memory card names the project in plain words (never root:<sha>),
// shows a write that matched nothing as a failure with the error, and keeps
// the raw key out of the card. testdata/projmemcard/run.js drives the real
// page in headless Chrome, phone and desktop, light and dark. PROJMEM_SHOT=
// prefix also writes screenshots. It skips where node or Chrome is missing.
func TestProjectMemoryCardNamesTheProjectAndShowsFailure(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	const key = "root:fbf7b093b915dfa01651a528d629ab4cbbb217fb"
	call := func(id, args string) map[string]any {
		return map[string]any{"id": id, "function": map[string]any{"name": "project_memory", "arguments": args}}
	}
	result := func(id string, res map[string]any) map[string]any {
		b, _ := json.Marshal(res)
		return map[string]any{"role": "tool", "tool_call_id": id, "name": "project_memory", "text": string(b)}
	}
	msgs := []map[string]any{
		{"role": "user", "text": "tidy the notes"},
		{"role": "assistant", "text": "On it.", "tool_calls": []any{
			call("c1", `{"action":"write","operations":[{"action":"add","content":"Releases are tagged from main"}]}`),
			call("c2", `{"action":"write","operations":[{"action":"remove","old_text":"Honcho is the memory provider"}]}`),
		}},
		result("c1", map[string]any{"success": true, "project": key, "project_name": "relift", "message": "Applied 1 operation(s)."}),
		result("c2", map[string]any{"success": false, "project": key, "project_name": "relift",
			"error":           "Operation 1 (remove): No entry matched 'Honcho is the memory provider'. No operations were applied.",
			"closest_entries": []string{"Memory is kept in project notes"}}),
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Notes", Live: true, StartedAt: 900, Messages: msgs})
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "projmemcard", "run.js"), chrome, e.url, t.TempDir()).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
