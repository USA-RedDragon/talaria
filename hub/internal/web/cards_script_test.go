package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// Each card module's cases (testdata/cards/<module>.json) give a call in
// every state its mockup shows and what its card must say.
func TestCardCasesScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "cards", "run.js"), "static", filepath.Join("testdata", "cards")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
