package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// movebg.js settles the Run in background button of a running terminal card
// that never got its tool.complete: it reads the state after a wait, so the
// card never shows "Moving to the background" for ever. testdata/movebg
// drives it with a card that sees no event.
func TestMoveBackgroundSettles(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "movebg", "run.js"), filepath.Join("static", "movebg.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// A move that is accepted and never answered by a tool.complete leaves the
// card with its button again. testdata/movebg/browser.js drives the real page
// in headless Chrome against a fake agent whose command never ends.
func TestMoveBackgroundPillEnds(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapToolBackground)
	e.gw.AddSession(&gatewaytest.Session{ID: "s7", Title: "Slow", Live: true, StartedAt: 900,
		Messages: []map[string]any{{kRole: roleUser, kText: "hello"}, {kRole: roleAssistant, kText: "hi"}}})
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "movebg", "browser.js"), chrome, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
