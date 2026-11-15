package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// filecard.js draws the card of a file the agent offers; testdata/filecard
// runs every state of it (ready with a note, PDF, code, image, audio and
// video, transferring, gone, refused, sent at the user's request, a link in
// a reply, the copied link) against a small fake DOM.
func TestFileCardScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "filecard", "run.js"),
		filepath.Join("static", "filecard.js"), filepath.Join("static", "icons.js"), filepath.Join("testdata", "fakedom.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
