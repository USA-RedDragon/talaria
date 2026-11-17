package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

func runNetGateScript(t *testing.T) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "netgate", "run.js"),
		filepath.Join("static", "eventstream.js"), filepath.Join("static", "netgate.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// netgate.js is the page's shared view of a network drop: a failed fetch with
// no answer is transient, the quiet note comes only after 10 s, reads are let
// through as one probe at a time with waits that double from 1 s to 30 s, and
// the end of the drop is reported once. testdata/netgate/run.js drives it with
// a fake clock.
func TestNetGateScript(t *testing.T) {
	t.Parallel()
	runNetGateScript(t)
}
