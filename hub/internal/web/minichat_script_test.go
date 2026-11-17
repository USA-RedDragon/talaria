package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// minichat.js draws a subagent's steps with the chat's own view
// (chatview.js): the chat's bubbles, notice cards, thinking, tool cards and
// groups, the chat's jump to the latest message, and the chat's pending
// bubbles for the messages the user sent, with whether the subagent read
// them.
func TestMiniChatScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	files := withCards(t, []string{"times.js", "attach.js", "peer.js", "notice.js", "origin.js", fileToolCard, "toolgroup.js", "uistate.js", "stick.js",
		"pageblocks.js", "pagesend.js", "plain.js", "chatview.js", "minichat.js"})
	args := make([]string, 0, 1+len(files))
	args = append(args, filepath.Join("testdata", "minichat", "run.js"))
	for _, f := range files {
		args = append(args, filepath.Join("static", f))
	}
	out, err := exec.CommandContext(t.Context(), node, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
