package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A subagent's row in the Activity panel has a title that opens to the whole
// goal on a tap (or Enter) and closes on a second, and its small chat opens
// with the task and then the context it was given, each folded after six lines
// with Show all / Show less. testdata/subagentbrief/run.js drives the real
// page in headless Chrome at phone and desktop size, light and dark;
// BRIEF_SHOTS=dir keeps screenshots.
func TestSubagentBriefTitleExpandsAndChatShowsTaskAndContext(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	bin := chromePath(t)
	e := setup(t)
	goal := "Audit the status bar in the game UI.\nLook at /home/reddragon/Projects/game/ui/statusbar.go and report whether it draws over the game view.\nTry both window sizes.\nCompare light and dark.\nNote any clipping.\nNote the z-order.\nWrite the findings down in a table.\nThen stop."
	ctx := "Background:\n- The status bar moved to the top in the last release.\n\nKnown facts:\n- The window is 412 or 1280 pixels wide.\n- The game view starts under the bar.\n- Dark mode uses a darker bar.\nDo not change any file.\nReport only what you can see in the screenshots.\nEnd of the context."
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Games", Live: true, StartedAt: 900,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	e.gw.AddChildRows("s9", subA, map[string]any{kRole: roleUser, keyText: "Audit the status bar in the game UI.", kTimestamp: 1000.0},
		map[string]any{kRole: roleAssistant, keyText: "Auditing.", kTimestamp: 1001.0})
	e.gw.SetChildBrief("s9", subA, goal, ctx)
	prof, err := os.MkdirTemp("", "subagentbrief-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "subagentbrief", "run.js"), bin, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
