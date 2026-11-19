package firefox_test

import (
	"os/exec"
	"testing"
)

// TestPageMethodLogic runs the unit tests of pageMethod in background.js
// (pagemethod_test.js) with Node's test runner: a configured sign-in method
// clicks the button whose text is it or starts with it and a description,
// and nothing else. It is skipped where node is not installed.
func TestPageMethodLogic(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, "--test", "pagemethod_test.js").CombinedOutput()
	if err != nil {
		t.Fatalf("node --test pagemethod_test.js: %v\n%s", err, out)
	}
}
