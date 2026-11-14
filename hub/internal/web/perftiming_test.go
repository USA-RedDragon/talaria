package web_test

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

// A page's timing of a chat open is logged with the hub's own time for
// that chat's event stream, found by the hash the page names the chat by;
// a scroll timing is logged as such.
func TestTimingReportsAreLogged(t *testing.T) {
	t.Parallel()
	sink := &lockedBuf{}
	e := setupWith(t, func(_ *config.Config, o *web.Options, _ *store.Store) {
		o.Logger = slog.New(slog.NewJSONHandler(sink, nil))
	})
	c := client(t)
	m := login(t, e, c)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, e.url+"/api/sessions/pc/s1/events", nil)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if st := resp.Header.Get("Server-Timing"); !strings.Contains(st, "attach;dur=") {
		t.Fatalf("events Server-Timing = %q", st)
	}
	readEvents(t, bufio.NewReader(resp.Body), "snapshot")
	// FNV-1a of "pc\ns1", as perfwatch.js hashes it.
	const chat = "24f7821e"
	const kChat = "chat"
	if r, _ := post(t, c, e.url+"/api/view-report", m.CSRF, "", map[string]any{kKind: "timing", "what": "open", kChat: chat, "paint": 40}); r.StatusCode != http.StatusNoContent {
		t.Fatalf("timing = %d", r.StatusCode)
	}
	if r, _ := post(t, c, e.url+"/api/view-report", m.CSRF, "", map[string]any{kKind: "scroll", kChat: chat, "ms": 900}); r.StatusCode != http.StatusNoContent {
		t.Fatalf("scroll = %d", r.StatusCode)
	}
	var open, scroll int
	for _, l := range sink.lines() {
		rep, _ := l["report"].(string)
		switch l["msg"] {
		case "chat open timing":
			var r map[string]any
			_ = json.Unmarshal([]byte(rep), &r)
			if ev, _ := r["events_srv"].(string); !strings.Contains(ev, "attach;dur=") {
				t.Errorf("open timing without the hub's stream time: %s", rep)
			}
			open++
		case "chat scroll timing":
			scroll++
		}
	}
	if open != 1 || scroll != 1 {
		t.Fatalf("logged %d open and %d scroll timings, want 1 each", open, scroll)
	}
}
