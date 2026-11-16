package web_test

import (
	"os/exec"
	"path/filepath"
	"testing"
)

// The script todo.js reads the agent's to-do list: the tree, the counts and their words,
// the folding of finished items, the line above the message box and a
// subagent's brief. testdata/todo/run.js checks them without a page.
func TestTodoScript(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "todo", "run.js"), filepath.Join("static", "todo.js")).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
