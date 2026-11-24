//go:build unix

package firefoxtest_test

import (
	"context"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// casePage is a page shaped like a Salesforce Lightning case page: its
// framework comes from a static host while it loads, and its feed comes a
// moment later from a POST to its own host and a GET to the static host.
func casePage(sub string) string {
	return `<title>case</title><p>TS0000001</p><div id="feed"></div><script src="` + sub + `/static.js"></script>
<script>
setTimeout(() => {
  const feed = document.getElementById("feed");
  const own = new XMLHttpRequest();
  own.open("POST", "/aura");
  own.onerror = () => { feed.textContent = "own host blocked"; };
  own.onload = () => {
    const cdn = new XMLHttpRequest();
    cdn.open("GET", "` + sub + `/feed");
    cdn.onerror = () => { feed.textContent = "static host blocked"; };
    cdn.onload = () => { feed.textContent = own.responseText + " " + cdn.responseText; };
    cdn.send();
  };
  own.send("message=read");
}, 1500);
</script>`
}

// TestFirefoxSkillScriptPageLoads is the weekly SEV-1 tracker job's case
// read: with no user present, a read-only browser_eval by script_ref waits
// for a page that loads its feed by XHR after the script started. The
// page's POST to its own host and its GET to the static host it loaded
// from must arrive; the script still cannot reach any other host.
func TestFirefoxSkillScriptPageLoads(t *testing.T) { //nolint:paralleltest // one Firefox at a time
	if os.Getenv("HERMES_BROWSER_E2E") != "1" {
		t.Skip("set HERMES_BROWSER_E2E=1 to drive a throwaway headless Firefox")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	b, _ := startFirefox(ctx, t)

	h := &hits{n: map[string]int{}}
	sub := serveOn(ctx, t, crossHost, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.add("sub " + r.Method + " " + r.URL.Path)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		switch r.URL.Path {
		case "/static.js":
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, "window.framework = 1;")
		default:
			_, _ = io.WriteString(w, "FEED-FROM-STATIC")
		}
	}))
	leak := serveOn(ctx, t, otherLoginHost, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		h.add("leak " + r.URL.Path)
	}))
	srv := serveOn(ctx, t, loopback, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.add(r.Method + " " + r.URL.Path)
		switch r.URL.Path {
		case "/case":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, casePage(strings.TrimSuffix(sub.URL, "/")))
		case "/aura":
			_, _ = io.WriteString(w, "AURA-OK")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Setenv("HERMES_BROWSER_E2E_LEAK_URL", leak.URL)

	pluginLayer(ctx, t, b, srv.URL, srv.URL, nil, "test_skill_script_keeps_page_loading")

	if h.get("POST /aura") == 0 {
		t.Error("the case page's POST to its own host never arrived")
	}
	if h.get("sub GET /feed") == 0 {
		t.Error("the case page's GET to its static host never arrived")
	}
	if n := h.get("leak /leak"); n != 0 {
		t.Errorf("the skill script reached a host the page never used (%d requests)", n)
	}
}
