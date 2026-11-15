package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A click anywhere on a subagent card's header, its title included, opens
// the card and a second click closes it; Enter and Space on the header do
// the same. v0.26.110 made a title click flip the title between one line and
// the whole goal and left the card open. testdata/cardcollapse/run.js clicks
// with a real mouse in headless Chrome and Firefox; each skips where node or
// its browser is missing. CARD_SHOTS=dir keeps screenshots (Chrome).
func TestSubagentCardTitleClickTogglesCardChrome(t *testing.T) {
	t.Parallel()
	cardCollapse(t, chromePath(t))
}

func TestSubagentCardTitleClickTogglesCardFirefox(t *testing.T) {
	t.Parallel()
	cardCollapse(t, firefoxPath(t))
}

func cardCollapse(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	goal := "Find, with proof, why a pending clarify question stays on screen after it is answered.\nLook at the page and the hub.\nReport what you find."
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Games", Live: true, StartedAt: 900,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	e.gw.AddChildRows("s9", subA, map[string]any{kRole: roleUser, keyText: goal, kTimestamp: 1000.0},
		map[string]any{kRole: roleAssistant, keyText: "Looking.", kTimestamp: 1001.0})
	e.gw.SetChildBrief("s9", subA, goal, "")
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "cardcollapse", "run.js"), bin, e.url, t.TempDir()).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
