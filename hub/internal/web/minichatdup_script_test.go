package web_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A message sent to a running subagent from the Activity panel shows once
// in its small chat: as the user's bubble, read by the subagent. Hermes stores
// the steer as its own user row in the steer marker, and that row is not
// drawn a second time as a gray line. The chat opens with the subagent's
// whole task. testdata/minichatdup/run.js drives the real page in headless
// Chrome at phone and desktop size; MINICHAT_SHOTS=dir keeps screenshots.
const subA = "sa-0-a"

func TestSubagentMiniChatShowsASteerOnce(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	bin := chromePath(t)
	e := setup(t)
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Games", Live: true, StartedAt: 900,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: "Check the status bar", Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	brief := "Check the status bar in the screenshots.\nLook at /home/reddragon/Projects/game/ui/statusbar.go and report whether it draws over the game view.\nTry both window sizes.\nCompare light and dark.\nNote any clipping.\nNote the z-order.\nWrite the findings down.\nThen stop."
	e.gw.AddChildRows("s9", subA, map[string]any{kRole: roleUser, keyText: brief, kTimestamp: 1000.0},
		map[string]any{kRole: roleAssistant, keyText: "Looking.", kTimestamp: 1001.0})
	poke := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The subagent read the steers: a tool result, then the steer row.
		text := r.URL.Query().Get("text")
		at := float64(time.Now().Unix() + 2) // after the hub stored the steers
		e.gw.AddChildRows("s9", subA,
			map[string]any{kRole: roleAssistant, keyText: "", kTimestamp: at, kCalls: []map[string]any{{"id": "c1", fieldName: toolTerminal, kArgs: map[string]any{kCommand: "ls"}}}},
			map[string]any{kRole: stepTool, fieldName: toolTerminal, kCallID: "c1", kTimestamp: at, kArgs: map[string]any{kCommand: "ls"}, sjResult: "{}", "result_size": 2},
			map[string]any{kRole: roleUser, keyText: gatewaytest.SteerOpen + "\n" + text + "\n" + gatewaytest.SteerClose, "display_kind": "steer", kTimestamp: at})
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(poke.Close)
	prof, err := os.MkdirTemp("", "minichatdup-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "minichatdup", "run.js"), bin, e.url, prof, poke.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
