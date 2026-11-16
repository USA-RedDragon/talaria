//go:build unix

package firefoxtest_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/bidi"
)

// hits counts the requests a test server got, by path.
type hits struct {
	mu sync.Mutex
	n  map[string]int
}

func (h *hits) add(p string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.n[p]++
}

func (h *hits) get(p string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.n[p]
}

const swSource = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (new URL(e.request.url).pathname === "/sw-trigger") {
    e.respondWith(fetch("/sw-fetch").then(() => new Response("ok")).catch(() => new Response("blocked")));
  }
});
`

// installOther loads a second, unrelated extension that fetches from the
// test server in its background page and in a content script of every
// page, like a password manager or an ad blocker does.
func installOther(ctx context.Context, t *testing.T, bc *bidi.Client, base string) {
	t.Helper()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "manifest.json"), []byte(`{"manifest_version": 2, "name": "other", "version": "1.0",`+
		` "browser_specific_settings": {"gecko": {"id": "other@test", "data_collection_permissions": {"required": ["none"]}}},`+
		` "permissions": ["http://*/*"], "background": {"scripts": ["bg.js"]},`+
		` "content_scripts": [{"matches": ["http://*/*"], "js": ["cs.js"], "run_at": "document_idle"}]}`))
	writeFile(t, filepath.Join(dir, "bg.js"), []byte(`setInterval(() => { fetch("`+base+`/other-bg").catch(() => {}); }, 300);`))
	writeFile(t, filepath.Join(dir, "cs.js"), []byte(`window.fetch("`+base+`/other-cs", {mode: "no-cors"}).catch(() => {});`))
	if _, err := bc.InstallTemporary(ctx, dir); err != nil {
		t.Fatal(err)
	}
}

// newContext opens a tab outside the agent group and loads url in it.
func newContext(ctx context.Context, t *testing.T, bc *bidi.Client, url string) string {
	t.Helper()
	res, err := bc.Call(ctx, "browsingContext.create", map[string]any{"type": "tab"})
	if err != nil {
		t.Fatal(err)
	}
	var c struct {
		Context string `json:"context"`
	}
	if err := json.Unmarshal(res, &c); err != nil {
		t.Fatal(err)
	}
	if _, err := bc.Call(ctx, "browsingContext.navigate", map[string]any{keyContext: c.Context, "url": url, "wait": "complete"}); err != nil {
		t.Fatal(err)
	}
	return c.Context
}

func evalAsync(ctx context.Context, t *testing.T, bc *bidi.Client, browsingContext, expr string) {
	t.Helper()
	if _, err := bc.Call(ctx, "script.evaluate", map[string]any{
		"expression": expr, "awaitPromise": true, "userActivation": true, "target": map[string]any{keyContext: browsingContext},
	}); err != nil {
		t.Fatal(err)
	}
}

// TestUnrelatedRequestsNotBlocked checks that a tab that ran a script does
// not make the extension cancel requests that have nothing to do with it:
// another extension's content script and background fetches, a service
// worker's and a worker's fetch, a page in an ordinary tab, and a tab the
// scripted tab opened before it ran a script. The tainted tab itself stays
// limited, also against what a script leaves running after it returned.
func TestUnrelatedRequestsNotBlocked(t *testing.T) { //nolint:paralleltest // one Firefox at a time
	if os.Getenv("HERMES_BROWSER_E2E") != "1" {
		t.Skip("set HERMES_BROWSER_E2E=1 to drive a throwaway headless Firefox")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	b, bc := startFirefox(ctx, t)

	h := &hits{n: map[string]int{}}
	srv := serveOn(ctx, t, loopback, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.add(r.URL.Path)
		switch r.URL.Path {
		case "/sw.js":
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, swSource)
		case "/sw-page":
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `<title>sw</title><script>navigator.serviceWorker.register("/sw.js");</script>`)
		case "/worker.js":
			w.Header().Set("Content-Type", "text/javascript")
			_, _ = io.WriteString(w, `fetch("/worker-fetch");`)
		case "/rich":
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `<title>rich</title><link rel="icon" href="/fav.png"><script>new Worker("/worker.js"); fetch("/page-fetch");</script><img src="/img.png">`)
		default:
			w.Header().Set("Content-Type", "text/html")
			_, _ = io.WriteString(w, `<title>page</title><p>hello</p>`)
		}
	}))
	other := serveOn(ctx, t, crossHost, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.add("other" + r.URL.Path)
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}))

	// A service worker in an ordinary tab, before any script runs.
	sw := newContext(ctx, t, bc, srv.URL+"/sw-page")
	evalAsync(ctx, t, bc, sw, `navigator.serviceWorker.ready.then(() => new Promise((r) => setTimeout(r, 500)))`)

	// An agent tab opens a tab with window.open before it runs a script,
	// then runs one: it holds limits from now on, the earlier tab does not.
	var tab tabResult
	call(ctx, t, b, "tab_open", map[string]any{keyURL: srv.URL + "/page", keyGuard: map[string]any{keyVisit: []string{loopback}}}, &tab)
	if got := evalInTab(ctx, bc, srv.URL+"/page", `window.open("/child"); 1`); got == "" {
		t.Fatal("no eval in the agent tab")
	}
	time.Sleep(time.Second)
	read := map[string]any{keyScripts: []string{loopback}}
	call(ctx, t, b, "eval", map[string]any{keyTab: tab.TabID, keyScript: `return 1;`, keyGuard: read}, nil)

	installOther(ctx, t, bc, srv.URL)
	newContext(ctx, t, bc, srv.URL+"/rich")
	time.Sleep(2 * time.Second)
	evalAsync(ctx, t, bc, sw, `fetch("/sw-trigger").then((r) => r.text())`)
	plain := newContext(ctx, t, bc, srv.URL+"/plain")
	evalAsync(ctx, t, bc, plain, `fetch("/plain-fetch").then((r) => r.text())`)
	// The child tab opened before the script ran loads another site.
	if got := evalInTab(ctx, bc, srv.URL+"/child", `fetch("`+other.URL+`/from-child", {mode: "no-cors"}).then(() => 1); 1`); got == "" {
		t.Log("no child tab")
	}
	time.Sleep(time.Second)

	for _, p := range []string{"/other-bg", "/other-cs", "/sw-fetch", "/plain", "/plain-fetch", "/worker-fetch", "/page-fetch", "/img.png"} {
		if h.get(p) == 0 {
			t.Errorf("request to %s never reached the server: cancelled while a tab holds a script's limits", p)
		}
	}
	if h.get("other/from-child") == 0 {
		t.Error("a tab opened before the script ran lost access to other sites: it inherited limits it was not given")
	}

	// The scripted tab stays limited to its own site, also against a timer
	// and a listener the script leaves behind in the extension's world.
	leak := other.URL
	for _, s := range []string{
		`try { await window.fetch("` + leak + `/a", {mode: "no-cors"}); } catch (e) {} return 1;`,
		`try { await fetch("` + leak + `/b", {mode: "no-cors"}); } catch (e) {} return 1;`,
		`try { const x = new globalThis.XMLHttpRequest(); x.open("GET", "` + leak + `/c"); x.send(); await new Promise((r) => setTimeout(r, 300)); } catch (e) {} return 1;`,
		`setTimeout(() => { window.fetch("` + leak + `/d", {mode: "no-cors"}).catch(() => {}); }, 1500); return 1;`,
		`setTimeout(() => { try { const x = new globalThis.XMLHttpRequest(); x.open("GET", "` + leak + `/e"); x.send(); } catch (e) {} }, 1500); return 1;`,
		`setTimeout(() => { try { new globalThis.WebSocket("ws://127.0.0.2/f"); } catch (e) {} }, 1500); return 1;`,
		`setTimeout(() => { fetch("` + leak + `/g", {mode: "no-cors"}).catch(() => {}); }, 1500); return 1;`,
	} {
		call(ctx, t, b, "eval", map[string]any{keyTab: tab.TabID, keyScript: s, keyGuard: read}, nil)
	}
	time.Sleep(3 * time.Second)
	for _, p := range []string{"/a", "/b", "/c", "/d", "/e", "/g"} {
		if h.get("other"+p) != 0 {
			t.Errorf("the scripted tab reached another site: %s", p)
		}
	}
}
