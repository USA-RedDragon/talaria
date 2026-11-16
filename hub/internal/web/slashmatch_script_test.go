package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// slashmatch.js ranks the commands the message box offers after a "/";
// testdata/slashmatch/run.js checks the order and the aliases.
func TestSlashMatchScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "slashmatch", "run.js"), filepath.Join("static", "slashmatch.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// slashmatch.js reads a command's usage hint into the words and values that
// may come next; testdata/slashargs/run.js checks it against the usage
// strings of Hermes's own command registry (testdata/slashargs/usage.txt).
func TestSlashArgsScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "slashargs", "run.js"), filepath.Join("static", "slashmatch.js"),
		filepath.Join("testdata", "slashargs", "usage.txt")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// After "/command " the suggestions stay and help with the command's
// arguments, at 412 and 1280 pixels, light and dark. testdata/slashargs/
// browser.js drives the real page in headless Chrome; SLASHARGS_SHOT=dir
// writes screenshots. It skips where node or Chrome is missing.
func TestSlashArgsBrowser(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	bin := chromePath(t)
	e := setup(t)
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "slashargs", "browser.js"), bin, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
