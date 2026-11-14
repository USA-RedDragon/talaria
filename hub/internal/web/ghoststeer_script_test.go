package web_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// Messages sent to a running turn as steers leave no bubble that reads as
// still sending once the turn has read them: not when the reader comes
// back to the chat from another (the page's kept copy of it), not after a
// reload, not ten minutes later. A message the hub accepted that the
// transcript does not show is kept at most ten minutes from when it was
// sent, and a message that never reached the hub still shows as sending,
// with its retry line, until it does. testdata/ghoststeer/run.js drives
// the real page on a phone in headless Chrome and in headless Firefox.
// Each skips where node or its browser is missing.
func TestSteersLeaveNoPendingBubbleChrome(t *testing.T) {
	t.Parallel()
	ghostSteer(t, chromePath(t))
}

func TestSteersLeaveNoPendingBubbleFirefox(t *testing.T) {
	t.Parallel()
	ghostSteer(t, firefoxPath(t))
}

// titleSteering is the chat the steers go to.
const titleSteering = "Steering"

func ghostSteer(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	e.gw.QueueWhileRunning = true
	turns := func(id string) []map[string]any {
		ms := make([]map[string]any, 0, 12)
		for i := range 6 {
			ms = append(ms, map[string]any{kRole: roleUser, kText: fmt.Sprintf("%s question %d", id, i)},
				map[string]any{kRole: roleAssistant, kText: strings.Repeat(fmt.Sprintf("%s answer %d. ", id, i), 6)})
		}
		return ms
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "work", Title: titleSteering, Live: true, StartedAt: 900, Messages: turns("work")})
	// A Hermes that stored the steers where the page cannot see them.
	e.gw.AddSession(&gatewaytest.Session{ID: "hidden", Title: "Hidden", Live: true, StartedAt: 800, Messages: turns("hidden"),
		SteerRow: func([]string) map[string]any { return nil }})
	e.gw.AddSession(&gatewaytest.Session{ID: "elsewhere", Title: titleOther, Live: true, StartedAt: 700, Messages: turns("elsewhere")})
	// The page's driver asks for a turn to start or end; the gateway does it
	// outside the request, as Hermes does on its own.
	type ask struct {
		verb, chat string
		done       chan struct{}
	}
	asks := make(chan ask)
	go func() {
		for a := range asks {
			if a.verb == "start" {
				e.gw.StartElsewhere(a.chat, "tui-"+a.chat, "long job in "+a.chat, false, true)
			} else {
				e.gw.FinishTurn(a.chat)
			}
			close(a.done)
		}
	}()
	t.Cleanup(func() { close(asks) })
	poke := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(parts) != 2 || (parts[0] != "start" && parts[0] != "finish") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		a := ask{verb: parts[0], chat: parts[1], done: make(chan struct{})}
		asks <- a
		<-a.done
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(poke.Close)
	prof, err := os.MkdirTemp("", "ghoststeer-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "ghoststeer", "run.js"), bin, e.url, prof, poke.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if os.Getenv("GHOSTSTEER_DEBUG") != "" {
		t.Logf("%s", out)
	}
}
