package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A drop of the user's network (5 s, then 30 s) leaves the page quiet: no red
// banner, no error text, the chat list stays, few requests, a quiet
// Reconnecting note only after the 10 s grace, and a refresh when it is back.
// testdata/netdrop/run.js drives the real page through a proxy it cuts, in
// Chrome on a Pixel-sized phone and in Firefox on a desktop, one at a time.
// NETDROP_SHOTS, when set to a folder, makes the Chrome run save screenshots.
func TestNetworkDropChrome(t *testing.T) {
	t.Parallel()
	netDrop(t, chromePath(t))
}

func TestNetworkDropFirefox(t *testing.T) {
	t.Parallel()
	netDrop(t, firefoxPath(t))
}

func netDrop(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "netdrop", "run.js"), bin, e.url, t.TempDir())
	if shots := os.Getenv("NETDROP_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "NETDROP_SHOTS="+shots)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	t.Logf("%s", out)
}
