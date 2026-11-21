package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// The Usage page's subscription accounts: a person who cannot sign an account
// in is told why there is no Sign in button. testdata/claude/usage.js renders
// the panel with claude.js in a small DOM.
func TestClaudeUsageSignInHintScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "claude", "usage.js"), filepath.Join("static", "claude.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// The pooled API credits in the web UI: the Usage page's block and holds, and
// the lines for a fallback and a call that ran on API credits.
func TestClaudeCreditsScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "claude", "credits.js"), filepath.Join("static", "times.js"),
		filepath.Join("static", "claude.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
