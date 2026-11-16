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

// The Activity panel has the Plan at the top and one list of subagents and
// background commands, with no tabs. testdata/activitymerge/run.js drives the
// real page: Chrome on a Pixel-sized phone and Firefox on a desktop.
// MERGE_SHOTS, when set to a folder, makes the Chrome run save screenshots there.
func TestActivityMergeChrome(t *testing.T) {
	t.Parallel()
	activityMerge(t, chromePath(t))
}

func TestActivityMergeFirefox(t *testing.T) {
	t.Parallel()
	activityMerge(t, firefoxPath(t))
}

func activityMerge(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	msgs := []map[string]any{{kRole: roleUser, kText: "Run the build."}, {kRole: roleAssistant, kText: "Started it."}}
	ago := func(d time.Duration) *float64 { return todoPtr(float64(time.Now().Add(-d).Unix())) }
	sub := func(id, goal, status string, d time.Duration) gateway.SubagentRow {
		return gateway.SubagentRow{SubagentID: id, Goal: goal, Status: todoPtr(status), AcceptingSteer: todoPtr(true), StartedAt: ago(d)}
	}
	exit := todoPtr(2)
	e.gw.AddSession(&gatewaytest.Session{ID: "s1", Title: "Build", Live: true, StartedAt: 900, Messages: msgs,
		Subagents: []gateway.SubagentRow{sub("sa-new", "check-logs", statusRunning, 2*time.Minute), sub("sa-old", "read-docs", "completed", 20*time.Minute)},
		Processes: []gateway.ProcessRow{
			{SessionID: "proc_mid", Command: "sleep 900", Status: statusRunning, StartedEpoch: ago(6 * time.Minute)},
			{SessionID: "proc_bad", Command: "make all", Status: "exited", ExitCode: exit, StartedEpoch: ago(12 * time.Minute), ExitedAt: ago(10 * time.Minute)},
		}})
	e.gw.SetTodos("s1", todoPlan(), false)
	prof := t.TempDir()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "activitymerge", "run.js"), bin, e.url, prof)
	if shots := os.Getenv("MERGE_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "MERGE_SHOTS="+shots)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
