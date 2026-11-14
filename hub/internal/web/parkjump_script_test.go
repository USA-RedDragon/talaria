package web_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
)

// The jump seen in the field: a long chat the page kept (parked) while the
// reader looked at another is shown again at its newest message, and a
// fresh snapshot of it that comes 0.5 s or 8 s later draws it again. The
// reader, who touched nothing, still sees the newest message after it,
// after its older rows, and the page throws nothing and reports no jump.
// testdata/parkjump/run.js drives the real page in headless Chrome and
// Firefox; each skips where node or its browser is missing.
func TestParkedChatKeepsNewestOnFreshSnapshotChrome(t *testing.T) {
	t.Parallel()
	for _, c := range pjCases() {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			parkJump(t, chromePath(t), c.delay, c.throw)
		})
	}
}

func TestParkedChatKeepsNewestOnFreshSnapshotFirefox(t *testing.T) {
	t.Parallel()
	for _, c := range pjCases() {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			parkJump(t, firefoxPath(t), c.delay, c.throw)
		})
	}
}

// pjCases are the delays of the fresh snapshot after the chat is shown
// again, and whether one step of drawing it throws, as one did in the
// field (the log was emptied and the reader's place never put back).
func pjCases() []struct {
	name  string
	delay int
	throw bool
} {
	return []struct {
		name  string
		delay int
		throw bool
	}{{"500", 500, false}, {"8000", 8000, false}, {"500-throw", 500, true}, {"8000-throw", 8000, true}}
}

func parkJump(t *testing.T, bin string, delay int, throw bool) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setupService(t, nil, func(o *service.Options) { o.IdleDetach = time.Second })
	for k, c := range []struct {
		id    string
		turns int
	}{{"parka", 400}, {"parkb", 120}} {
		ms := make([]map[string]any, 0, c.turns*4)
		for i := range c.turns {
			ms = append(ms, map[string]any{kRole: roleUser, kText: fmt.Sprintf("%s question %d", c.id, i)})
			if i%5 == 2 {
				call := fmt.Sprintf("c%d", i)
				ms = append(ms, map[string]any{kRole: roleAssistant, kText: "", kCalls: []map[string]any{{"id": call,
					fnKey: map[string]any{fieldName: toolTerminal, ilArgs: lsTmpArgs}}}},
					map[string]any{kRole: stepTool, kCallID: call, fieldContent: strings.Repeat("line of output\n", 12)})
			}
			ms = append(ms, map[string]any{kRole: roleAssistant, kText: strings.Repeat(fmt.Sprintf("%s answer %d fills the log. ", c.id, i), 3+i%17)})
		}
		e.gw.AddSession(&gatewaytest.Session{ID: c.id, Title: "Park " + c.id, Live: true, StartedAt: float64(900 - k), Messages: ms})
	}
	var slowA atomic.Int64
	e.gw.SlowResume(func(id string) time.Duration {
		if id == "parka" {
			return time.Duration(slowA.Load()) * time.Millisecond
		}
		return 0
	})
	prof, err := os.MkdirTemp("", "parkjump-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	go func() {
		for {
			select {
			case <-t.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			if _, err := os.Stat(filepath.Join(prof, "away")); err == nil {
				break
			}
		}
		// The hub lets go of A, a reply is stored, and A's resume is slow.
		time.Sleep(2500 * time.Millisecond)
		e.gw.FinishReply("parka", "parka a reply stored while away "+strings.Repeat("more words ", 30))
		slowA.Store(int64(delay))
		_ = os.WriteFile(filepath.Join(prof, "stored"), nil, 0o600)
	}()
	cmd := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "parkjump", "run.js"), bin, e.url, prof, strconv.Itoa(delay))
	cmd.Env = os.Environ()
	if throw {
		cmd.Env = append(cmd.Env, "PARKJUMP_THROW=1")
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
