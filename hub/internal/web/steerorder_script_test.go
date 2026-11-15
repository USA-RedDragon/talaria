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

// Steers sent to a running turn between its tool calls show where the
// turn read them, once and solid, when the reader comes back to the chat
// from another, as a fresh load of the chat shows them; a steer the turn
// has not read yet shows once at the end, marked as sent to the turn,
// never dimmed as a message still sending. testdata/steerorder/run.js
// drives the real page on a phone in headless Chrome and in headless
// Firefox. Each skips where node or its browser is missing.
func TestSteerOrderAfterSwitchChrome(t *testing.T) {
	t.Parallel()
	steerOrder(t, chromePath(t))
}

func TestSteerOrderAfterSwitchFirefox(t *testing.T) {
	t.Parallel()
	steerOrder(t, firefoxPath(t))
}

// The chat a test goes to and back from, and what the page's driver asks.
const (
	chatElsewhere = "elsewhere"
	pokeStart     = "start"
	pokeFinish    = "finish"
)

func steerOrder(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	e.gw.QueueWhileRunning = true
	turns := func(id string) []map[string]any {
		ms := make([]map[string]any, 0, 8)
		for i := range 4 {
			ms = append(ms, map[string]any{kRole: roleUser, kText: fmt.Sprintf("%s question %d", id, i)},
				map[string]any{kRole: roleAssistant, kText: fmt.Sprintf("%s answer %d.", id, i)})
		}
		return ms
	}
	// first: the running turn is the first the hub saw in the chat; again:
	// a turn ended in the chat since the hub subscribed.
	e.gw.AddSession(&gatewaytest.Session{ID: "first", Title: "First turn", Live: true, StartedAt: 900, Messages: turns("first")})
	e.gw.AddSession(&gatewaytest.Session{ID: "again", Title: "Later turn", Live: true, StartedAt: 800, Messages: turns("again")})
	e.gw.AddSession(&gatewaytest.Session{ID: chatElsewhere, Title: titleOther, Live: true, StartedAt: 700, Messages: turns("elsewhere")})
	// The page's driver asks for a turn to start, a tool round or the end;
	// the gateway does it outside the request, as Hermes does on its own.
	type ask struct {
		parts []string
		done  chan struct{}
	}
	asks := make(chan ask)
	go func() {
		for a := range asks {
			switch a.parts[0] {
			case pokeStart:
				e.gw.StartElsewhere(a.parts[1], "tui-"+a.parts[1], "long job in "+a.parts[1], false, true)
			case stepTool:
				e.gw.ToolRound(a.parts[1], a.parts[2], "agent_send")
			case pokeFinish:
				e.gw.FinishReply(a.parts[1], "finished "+a.parts[1])
			}
			close(a.done)
		}
	}()
	t.Cleanup(func() { close(asks) })
	poke := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		switch {
		case len(parts) == 2 && (parts[0] == pokeStart || parts[0] == pokeFinish):
		case len(parts) == 3 && parts[0] == stepTool:
		default:
			w.WriteHeader(http.StatusNotFound)
			return
		}
		a := ask{parts: parts, done: make(chan struct{})}
		asks <- a
		<-a.done
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(poke.Close)
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "steerorder", "run.js"), bin, e.url, prof, poke.URL).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if os.Getenv("STEERORDER_DEBUG") != "" {
		t.Logf("%s", out)
	}
}
