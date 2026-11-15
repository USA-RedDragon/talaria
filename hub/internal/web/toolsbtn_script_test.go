package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// The Tools button sits inside the message box at its right edge, opens and
// closes the chat's panel, and the box keeps room for it so typed text never
// runs under it; the top bar and the model line have no second entry.
// testdata/toolsbtn/run.js drives the real page in headless Chrome at 360,
// 412 and 1280 px. TOOLSBTN_SHOT=dir also writes screenshots. It skips where
// node or Chrome is missing.
func TestToolsButtonInMessageBox(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setupAgent(t)
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "toolsbtn", "run.js"), chrome, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
