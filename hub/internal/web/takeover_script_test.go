package web_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

// A Hermes takeover while the open chat streams a carried reply: the
// page's reply goes on with no pause and no redraw. The gateway hands over
// to the next one behind a Service (gatewaytest.Front); with the successor
// hint (Talaria Hermes patch 0155) the hub moves its connection before the
// old one closes. testdata/takeover/run.js drives the real page in
// headless Chrome and reports the longest pause between two updates of the
// reply; TAKEOVER_SHOTS_DIR=dir also saves PNGs of the chat around the
// takeover. TAKEOVER_NO_HINT=1 runs the takeover as a gateway without the
// hint does (it closes the hub's socket with 1012), for comparison.
func TestTakeoverKeepsTheReplyStreamingChrome(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	old := gatewaytest.New(clientID, "pw")
	next := gatewaytest.New(clientID, "pw")
	front := gatewaytest.NewFront(old)
	t.Cleanup(front.Close)
	t.Cleanup(old.Close)
	t.Cleanup(next.Close)
	msgs := make([]map[string]any, 0, 61)
	for i := range 30 {
		msgs = append(msgs, map[string]any{kRole: roleUser, kText: fmt.Sprintf("question %d", i)},
			map[string]any{kRole: roleAssistant, kText: strings.Repeat(fmt.Sprintf("answer %d fills the log. ", i), 6)})
	}
	msgs = append(msgs, map[string]any{kRole: roleUser, kText: "write the long one"})
	old.AddSession(&gatewaytest.Session{ID: "carried", Title: "Carried reply", Live: true, Running: true, StartedAt: 900, Messages: msgs})
	for i := range 6 {
		old.AddSession(&gatewaytest.Session{ID: fmt.Sprintf("idle%d", i), Title: fmt.Sprintf("Idle %d", i), Live: true, StartedAt: float64(800 - i),
			Messages: []map[string]any{{kRole: roleUser, kText: "hi"}, {kRole: roleAssistant, kText: "hello"}}})
	}
	next.SlowResume(func(string) time.Duration { return 100 * time.Millisecond })
	e := setupWith(t, func(cfg *config.Config, _ *web.Options, _ *store.Store) {
		cfg.Backends[0].URL = front.URL()
	})
	hint := os.Getenv("TAKEOVER_NO_HINT") == ""
	var n atomic.Int64
	stopStream := make(chan struct{})
	streamed := make(chan struct{})
	words := func() {
		defer close(streamed)
		tick := time.NewTicker(40 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stopStream:
				return
			case <-tick.C:
			}
			i := n.Add(1)
			old.Carry(next, "carried", hub.KindMessageDelta, map[string]any{kText: fmt.Sprintf("word%d ", i)})
		}
	}
	// The page's pokes, run one at a time off the request.
	type ask struct {
		verb string
		done chan struct{}
	}
	asks := make(chan ask)
	go func() {
		for a := range asks {
			switch a.verb {
			case pokeStart:
				old.Publish("carried", hub.KindMessageStart, map[string]any{})
				go words()
			case "takeover":
				front.Route(next)
				old.HandOver(next, hint)
			case "stop":
				close(stopStream)
				<-streamed
			}
			close(a.done)
		}
	}()
	poke := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a := ask{verb: strings.TrimPrefix(r.URL.Path, "/"), done: make(chan struct{})}
		asks <- a
		<-a.done
		_, _ = w.Write([]byte(strconv.FormatInt(n.Load(), 10)))
	}))
	t.Cleanup(func() { close(asks) })
	t.Cleanup(poke.Close)
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "takeover", "run.js"), chrome, e.url, t.TempDir(), poke.URL)
	label := "hint"
	if !hint {
		label = "nohint"
	}
	cmd.Env = append(os.Environ(), "SHOT_DIR="+os.Getenv("TAKEOVER_SHOTS_DIR"), "SHOT_LABEL="+label)
	out, err := cmd.CombinedOutput()
	t.Logf("%s", out)
	if err != nil {
		t.Fatalf("%v", err)
	}
	if hint && !strings.Contains(string(out), "redraws=0") {
		t.Fatalf("the page redrew the chat at the takeover")
	}
}
