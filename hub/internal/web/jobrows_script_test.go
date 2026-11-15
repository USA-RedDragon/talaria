package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// jobrows.js puts the run chats of one scheduled job in one row of the
// chat list; testdata/jobrows/run.js checks the grouping.
func TestJobRowsScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "jobrows", "run.js"), filepath.Join("static", "jobrows.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
