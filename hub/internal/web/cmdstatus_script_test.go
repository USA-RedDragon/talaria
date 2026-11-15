package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// cmdstatus.js words what a slash command shows while it runs and when it is
// done; testdata/cmdstatus/run.js checks the lines.
func TestCmdStatusScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "cmdstatus", "run.js"), filepath.Join("static", "cmdstatus.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// Sending /compress shows the command as received, a line that the chat is
// being compressed while Hermes summarizes, and then the result; with a turn
// running it says it waits for the turn. testdata/cmdstatus/page.js drives
// the real page in headless Chrome. CMDSTATUS_SHOT=prefix writes screenshots.
func TestCompressShowsProgress(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	msgs := []map[string]any{{kRole: roleUser, kText: "hello"}, {kRole: roleAssistant, kText: "hi there"}}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Compress me", Live: true, StartedAt: 900, Messages: msgs})
	e.gw.AddSession(&gatewaytest.Session{ID: "s8", Title: "Busy chat", Live: true, StartedAt: 800, Running: true, Messages: msgs})
	release := e.gw.HoldCompress()
	t.Cleanup(release)
	prof, err := os.MkdirTemp("", "cmdstatus-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	cmd := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "cmdstatus", "page.js"), chrome, e.url, prof)
	cmd.Env = append(os.Environ(), "SHOT_PREFIX="+os.Getenv("CMDSTATUS_SHOT"))
	// The page script cannot call Go: it asks through files in the profile.
	go func() {
		if waitFile(t, filepath.Join(prof, "release")) {
			release()
		}
		if waitFile(t, filepath.Join(prof, "finish")) {
			e.gw.FinishReply("s8", "done")
		}
	}()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// waitFile waits until the page script writes path, or the test ends.
func waitFile(t *testing.T, path string) bool {
	for t.Context().Err() == nil {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}
