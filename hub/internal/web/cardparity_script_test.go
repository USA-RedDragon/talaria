package web_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// parityCall is one tool call of testdata/cardparity/calls.json: what the
// chat and the subagent both ran.
type parityCall struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Args       map[string]any `json:"args"`
	Result     any            `json:"result"`
	IsError    bool           `json:"is_error"`
	DurationMS int64          `json:"duration_ms"`
	// Running is a call that has started and has no result yet.
	Running bool `json:"running"`
}

// The main chat and a subagent's steps in Activity draw a tool call with
// the one card component: the same call is the same DOM in both, closed and
// open. testdata/cardparity/*.json hold the calls (one file per card
// module); the chat has them as its rows and a subagent as its own. run.js
// drives Chrome on a Pixel-sized phone and Firefox on a desktop.
// Calls with "running": true have no result row: they show as running in
// both places (the ticking counter aside).
// CARD_SHOTS=dir (Chrome) also saves each card closed and open at 412 and
// 1280 px, light and dark, in the chat and in the subagent's steps:
// <tool>-<id>-<main|mini>-<open|closed>-<w>-<light|dark>.png;
// CARD_IDS=p01,p02 limits the shots to those calls.
func TestCardParityChrome(t *testing.T) {
	t.Parallel()
	cardParity(t, chromePath(t))
}

func TestCardParityFirefox(t *testing.T) {
	t.Parallel()
	cardParity(t, firefoxPath(t))
}

func cardParity(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	// Each card module keeps its calls in a file of its own.
	files, err := filepath.Glob(filepath.Join("testdata", "cardparity", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no calls in testdata/cardparity: %v", err)
	}
	sort.Strings(files)
	list := make([]parityCall, 0, 16*len(files))
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var some []parityCall
		if err := json.Unmarshal(raw, &some); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		list = append(list, some...)
	}
	const goal = "Run the same calls as the chat"
	rows := make([]map[string]any, 0, 1+2*len(list))
	rows = append(rows, map[string]any{kRole: roleUser, kText: "go", kTimestamp: 1763000000.0})
	child := make([]map[string]any, 0, 1+2*len(list))
	child = append(child, map[string]any{kRole: roleUser, keyText: goal, kTimestamp: 1763000000.0})
	for i, c := range list {
		at := 1763000010.0 + float64(i*10)
		if c.Running {
			at = float64(time.Now().Unix() - 5)
		}
		end := at + float64(c.DurationMS)/1000
		args, err := json.Marshal(c.Args)
		if err != nil {
			t.Fatal(err)
		}
		res, err := json.Marshal(c.Result)
		if err != nil {
			t.Fatal(err)
		}
		meta := map[string]any{keyToolOutcome: map[string]any{keyDurationMS: c.DurationMS, "is_error": c.IsError}}
		rows = append(rows, map[string]any{kRole: roleAssistant, kText: "", kTimestamp: at, kCalls: []map[string]any{{"id": c.ID, fnKey: map[string]any{fieldName: c.Name, ilArgs: string(args)}}}})
		child = append(child, map[string]any{kRole: roleAssistant, keyText: "", kTimestamp: at, kCalls: []map[string]any{{"id": c.ID, fieldName: c.Name, kArgs: c.Args}}})
		if c.Running {
			continue
		}
		rows = append(rows, map[string]any{kRole: stepTool, kCallID: c.ID, fieldName: c.Name, kText: string(res), kTimestamp: end, keyDisplayMeta: meta})
		child = append(child, map[string]any{kRole: stepTool, fieldName: c.Name, kCallID: c.ID, kTimestamp: end, kArgs: c.Args, sjResult: string(res), keyResultSize: len(res), keyDisplayMeta: meta})
	}
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	// A call that kept a screenshot has its file on the hub's computer.
	for _, c := range list {
		if r, ok := c.Result.(map[string]any); ok {
			if p, ok := r["path"].(string); ok && strings.HasSuffix(p, ".png") {
				e.gw.SetFile(p, shotPicture(t))
			}
		}
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Parity", Live: true, StartedAt: 900, Messages: rows,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.AddChildRows("s9", subA, child...)
	e.gw.SetChildBrief("s9", subA, goal, "")
	ids := make([]string, 0, len(list))
	running := []string{}
	names := map[string]string{}
	for _, c := range list {
		ids = append(ids, c.ID)
		names[c.ID] = c.Name
		if c.Running {
			running = append(running, c.ID)
		}
	}
	want, err := json.Marshal(ids)
	if err != nil {
		t.Fatal(err)
	}
	meta, err := json.Marshal(map[string]any{"running": running, "names": names})
	if err != nil {
		t.Fatal(err)
	}
	// The running calls start live, after the page has the chat.
	poke := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		e.gw.Publish("s9", "message.start", map[string]any{})
		for _, c := range list {
			if c.Running {
				e.gw.Publish("s9", "tool.start", map[string]any{"tool_id": c.ID, fieldName: c.Name, "args": c.Args})
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(poke.Close)
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "cardparity", "run.js"), bin, e.url, t.TempDir(), string(want), string(meta), poke.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
