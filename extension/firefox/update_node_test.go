package firefox_test

import (
	"os/exec"
	"testing"
)

// TestUpdateLogic runs the unit tests of update.js (update_test.js) with
// Node's test runner: a newer daemon triggers a check, a reload waits for
// actions in flight, and a throttled answer is retried. It is skipped where
// node is not installed.
func TestUpdateLogic(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, "--test", "update_test.js").CombinedOutput()
	if err != nil {
		t.Fatalf("node --test update_test.js: %v\n%s", err, out)
	}
}
