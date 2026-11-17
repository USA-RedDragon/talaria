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
