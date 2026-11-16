package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// peer.js names the other end of an agent message (a subagent by its goal,
// a chat by its title, the parent); testdata/peer checks it and the titles of
// the message cards that use it.
func TestPeerScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "peer", "run.js"), filepath.Join("static", "peer.js"),
		filepath.Join("static", "times.js"), filepath.Join("static", "icons.js"), filepath.Join("static", "notice.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
