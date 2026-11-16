package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// The user's own messages render as Markdown, as a reply does.
// testdata/usermd/run.js drives the renderer (hubMarkdown.renderUser) in node
// with a small DOM: quote, bold, code, list, link, lines as typed, symbols in
// paths and globs left alone, hostile text inert.
func TestUserMarkdownRenderer(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "usermd", "run.js"), filepath.Join("static", "markdown.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}

// A message sent with "> quote" shows a blockquote, still after a reload and
// after a switch to another chat and back, and Copy and Edit keep the typed
// text. testdata/usermd/browser.js drives the real page on a phone in headless
// Chrome (Pixel emulation) and in headless Firefox. USERMD_SHOT=prefix also
// writes screenshots from Chrome (412 and 1280 wide, light and dark).
func TestUserMarkdownBubbleChrome(t *testing.T) {
	t.Parallel()
	userMarkdownBrowser(t, chromePath(t))
}

func TestUserMarkdownBubbleFirefox(t *testing.T) {
	t.Parallel()
	userMarkdownBrowser(t, firefoxPath(t))
}

func userMarkdownBrowser(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	rich := "> From the model's next thinking, 1:15 PM\nDumb\n\n**Bold**, *italic*, `inline_code` and a [link](https://example.com).\n\n- first\n- second\n\n# A heading\n\n```go\nfmt.Println(\"hi\")\n```\nSee ~/my_dir/some_file_name.txt and *.go"
	e.gw.AddSession(&gatewaytest.Session{ID: "mdchat", Title: "Markdown", Live: true, StartedAt: 900, Messages: []map[string]any{
		{kRole: roleUser, kText: rich},
		{kRole: roleAssistant, kText: "Got it."},
	}})
	e.gw.AddSession(&gatewaytest.Session{ID: "mdother", Title: titleOther, Live: true, StartedAt: 700, Messages: []map[string]any{
		{kRole: roleUser, kText: "first words"},
		{kRole: roleAssistant, kText: "hi"},
	}})
	prof := t.TempDir()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "usermd", "browser.js"), bin, e.url, prof, rich)
	cmd.Env = append(os.Environ(), "USERMD_SHOT="+os.Getenv("USERMD_SHOT"))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
