package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// The agent's to-do list is the Plan section of the Activity panel, a line
// above the message box and a subagent's own list in its card, live and after
// a reload. testdata/todoui/run.js drives the real page: Chrome on a
// Pixel-sized phone and Firefox on a desktop. TODOUI_SHOTS, when set to a
// folder, makes the Chrome run save screenshots there.
func TestTodoUIChrome(t *testing.T) {
	t.Parallel()
	todoUI(t, chromePath(t))
}

func TestTodoUIFirefox(t *testing.T) {
	t.Parallel()
	todoUI(t, firefoxPath(t))
}

const (
	todoDone    = "completed"
	todoProg    = "in_progress"
	todoPending = "pending"
	subRezero   = "sa-rz"
)

// todoPlan is a chat's list: two items in progress (one is the other's
// subtask, owned by a subagent), one blocked, one cancelled, 6 done of 15.
func todoPlan() []gateway.TodoItem {
	items := []gateway.TodoItem{
		{ID: "build", Content: "Android build of main installs on the Thor", Status: todoDone},
		{ID: todoRezero, Content: "Re:Zero to the title screen on the Thor", Status: todoProg},
		{ID: "vulkan", Content: "Find the failing Vulkan call", Status: todoDone, Parent: todoRezero},
		{ID: "touch", Content: "Thor touch: confirm touch reaches the guest", Status: todoProg, Parent: todoRezero, Owner: subRezero,
			Notes: "Re:Zero doesn't read touch; checking with the libnx touch test"},
		{ID: "apk", Content: "APK size back to ~630 MB", Status: "blocked", Parent: todoRezero, Owner: "sa-apk",
			Notes: "Blocked: needs the cold-copy change from main"},
		{ID: "icon", Content: "Launcher icon and name", Status: todoPending, Parent: todoRezero},
		{ID: "push1", Content: "relift push: batch the device file check", Status: todoPending},
		{ID: "push2", Content: "relift push: leave romfs readable by the app", Status: todoPending},
		{ID: "turnip", Content: "Try Turnip as the default driver", Status: "cancelled"},
	}
	for _, id := range []string{"d1", "d2", "d3", "d4"} {
		items = append(items, gateway.TodoItem{ID: id, Content: "Finished step " + id, Status: todoDone})
	}
	return append(items, gateway.TodoItem{ID: "n1", Content: "Write the release notes", Status: todoPending},
		gateway.TodoItem{ID: "n2", Content: "Tag the build", Status: todoPending})
}

func todoPtr[T any](v T) *T { return &v }

func todoUI(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	msgs := []map[string]any{{kRole: roleUser, kText: "Re zero doesn't use it, but does touch work?"}, {kRole: roleAssistant, kText: "Checking the touch path now."}}
	run := func(id, goal string) gateway.SubagentRow {
		return gateway.SubagentRow{SubagentID: id, Goal: goal, Status: todoPtr("running"), AcceptingSteer: todoPtr(true), StartedAt: todoPtr(float64(time.Now().Add(-4 * time.Minute).Unix()))}
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s1", Title: "Thor port", Live: true, StartedAt: 900, Messages: msgs,
		Subagents: []gateway.SubagentRow{run(subRezero, "android-rezero"), run("sa-apk", "apk-size")}})
	e.gw.AddSession(&gatewaytest.Session{ID: "s2", Title: "No list here", Live: true, StartedAt: 800, Messages: msgs})
	e.gw.AddSession(&gatewaytest.Session{ID: "s3", Title: "Older server", Live: true, NoTodos: true, StartedAt: 700, Messages: msgs})
	e.gw.SetTodos("s1", todoPlan(), false)
	child := []gateway.TodoItem{
		{ID: "a", Content: "Find the libnx touch test", Status: todoDone},
		{ID: "b", Content: "Read the libnx touch test", Status: todoProg},
		{ID: "c", Content: "Report what it shows", Status: todoPending},
		{ID: "d", Content: "Clean up", Status: todoPending},
	}
	e.gw.SetChildTodos("s1", subRezero, child)
	prof := t.TempDir()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "todoui", "run.js"), bin, e.url, prof)
	if shots := os.Getenv("TODOUI_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "TODOUI_SHOTS="+shots)
	}
	// The page cannot call Go: it asks through files in the profile.
	go func() {
		if waitFile(t, filepath.Join(prof, "update")) {
			items := todoPlan()
			items[3].Status = todoDone
			items[5].Status = todoProg
			e.gw.SetTodos("s1", items, true)
		}
		if waitFile(t, filepath.Join(prof, "child")) {
			next := append([]gateway.TodoItem(nil), child...)
			next[1].Status, next[2].Status = todoDone, todoProg
			e.gw.SetChildTodos("s1", subRezero, next)
		}
		if waitFile(t, filepath.Join(prof, "finish")) {
			items := todoPlan()
			for i := range items {
				if items[i].Status != "cancelled" {
					items[i].Status = todoDone
				}
			}
			e.gw.SetTodos("s1", items, true)
		}
	}()
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
