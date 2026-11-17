package firefox_test

import (
	"os/exec"
	"testing"
)

// TestLoginGuardLogic runs the unit tests of loginguard.js
// (loginguard_test.js) with Node's test runner: a login request goes only to
// the guard's https hosts, a post host the user allowed counts for its own
// login host only, and a cancelled request names the host for the sign-in
// card. It is skipped where node is not installed.
func TestLoginGuardLogic(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, "--test", "loginguard_test.js").CombinedOutput()
	if err != nil {
		t.Fatalf("node --test loginguard_test.js: %v\n%s", err, out)
	}
}
