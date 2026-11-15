package web_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

var fileCardAges = regexp.MustCompile(`9000(\d{6})`)

// A send_file result is a file card, a link to a file in a reply is one too.
// testdata/filecard/session.json is the chat (results of every state: a zip
// with a note, a PDF, a large file streaming, code, an image, a deleted file,
// a refused secret, a secret sent at the user's request, a refusal from the
// server); run.js drives the real page in headless Chrome, phone and desktop,
// light and dark, with the media routes answered by the page script, and
// FILECARD_SHOT=prefix also writes screenshots. It skips where node or
// Chrome is missing.
func TestFileCardBrowser(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	raw, err := os.ReadFile(filepath.Join("testdata", "filecard", "session.json"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	raw = fileCardAges.ReplaceAllFunc(raw, func(b []byte) []byte {
		n, _ := strconv.Atoi(string(b[4:]))
		return []byte(strconv.FormatInt(now-int64(n), 10))
	})
	var msgs []map[string]any
	if err := json.Unmarshal(raw, &msgs); err != nil {
		t.Fatal(err)
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Files", Live: true, StartedAt: 900, Messages: msgs})
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "filecard", "browser.js"), chrome, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
