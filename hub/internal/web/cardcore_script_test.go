package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// toolcard.js is the one card component of tool calls: testdata/cardcore
// draws each part of its model, finds failures in every result shape,
// keeps raw JSON behind a closed Raw toggle, mounts and finishes cards the
// same way for every log, and ties the model's answer to a vision card.
func TestToolCardCoreScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "cardcore", "run.js"), "static").CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
