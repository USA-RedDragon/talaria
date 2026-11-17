//go:build unix

package firefoxtest_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/bidi"
	"github.com/USA-RedDragon/talaria/internal/browser/broker"
	"github.com/USA-RedDragon/talaria/internal/browser/grants"
	"github.com/USA-RedDragon/talaria/logingrant"
)

const (
	// loginHost and twoLoginHost are in browser.autologin-hosts;
	// otherLoginHost is not. twoLoginHost has two saved logins.
	loginHost      = "127.0.0.4"
	otherLoginHost = "127.0.0.5"
	twoLoginHost   = "127.0.0.6"
	loginUser      = "alice"
	// grantHost is a name for the loopback address that is in no config:
	// the user allows it with a sign-in grant. Grants take host names, not
	// addresses.
	grantHost = "grant.localhost"
	// postHost is the sign-in API of grantHost on its own host name: the
	// login form on grantHost posts the login there.
	postHost = "api." + grantHost
	// pickerMethod is the label configured for loginHost in browser.autologin-methods.
	pickerMethod = "Password"
	keyLogins    = "login_hosts"
	keySensitive = "sensitive"
	keySelector  = "selector"
	keyAwait     = "awaitPromise"
	keyContext   = "context"
	keyExpr      = "expression"
	keyTarget    = "target"
)

type loginResult struct {
	TabID      int    `json:"tab_id"`
	Filled     bool   `json:"filled"`
	Submitted  bool   `json:"submitted"`
	LandedHost string `json:"landed_host"`
	Reason     string `json:"reason"`
	Method     string `json:"method"`
	// MethodsSeen holds the labels of a sign-in method picker.
	MethodsSeen []string `json:"methods_seen"`
	// NeedsPostHost is the host a login form sent the login to that the
	// user has not allowed.
	NeedsPostHost string `json:"needs_post_host"`
}

// loginServer records the posts it gets.
type loginServer struct {
	mu     sync.Mutex
	posts  []string
	clicks []string
	// apiPosts are the posts that came in on the api. host name.
	apiPosts []string
}

func (l *loginServer) gotAPI() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.apiPosts...)
}

func (l *loginServer) clicked() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.clicks...)
}

// pickerPage mimics a typical identity provider: buttons to choose how to sign in, and the
// password form only after "Password" is chosen. Every button tells the
// server which one was clicked.
func pickerPage(buttons ...string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><title>Sign in</title><div id="root"><h1>Choose how to sign in</h1>` +
		`<p>Not sure? Use Password if you have one.</p><a href="#help">Password help</a>`)
	for _, label := range buttons {
		b.WriteString(`<button type="button" onclick="pick(this.textContent)">` + label + `</button>`)
	}
	b.WriteString(`</div><script>
function pick(m) {
  fetch("/clicked?m=" + encodeURIComponent(m), {method: "POST"});
  if (m !== "Password") { return; }
  setTimeout(() => { document.getElementById("root").innerHTML = '<form method="post" action="/login">' +
    '<label>Email <input name="user" autocomplete="username"></label>' +
    '<label>Password <input type="password" name="pass" autocomplete="current-password"></label>' +
    '<button type="submit">Sign in</button></form>'; }, 400);
}</script>`)
	return b.String()
}

func (l *loginServer) got() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.posts...)
}

// ServeHTTP serves a login form on /, one that posts to a 307 redirect
// to otherLoginHost on /bounce-form, one that uses GET on /get-form, and
// /login, which takes the post and redirects to /home.
func (l *loginServer) handler(other string) http.HandlerFunc {
	form := func(action, method string) string {
		return `<!doctype html><title>Sign in</title><h1>Sign in</h1><form method="` + method + `" action="` + action + `">` +
			`<label>Email <input name="user" autocomplete="username"></label>` +
			`<label>Password <input type="password" name="pass" autocomplete="current-password"></label>` +
			`<button type="button" onclick="this.closest('form').pass.type='text'">Show</button>` +
			`<button type="submit">Sign in</button></form>`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		switch r.URL.Path {
		case "/":
			_, _ = io.WriteString(w, form("/login", "post"))
		case "/bounce-form":
			_, _ = io.WriteString(w, form("/bounce", "post"))
		case "/get-form":
			_, _ = io.WriteString(w, form("/login", "get"))
		case "/spa-form":
			// A form with no method and no action that a script submits, as a
			// single-page app does.
			_, _ = io.WriteString(w, `<!doctype html><title>Sign in</title><h1>Sign in</h1><div id="root"><form id="f">`+
				`<label>Email <input name="user" autocomplete="username"></label>`+
				`<label>Password <input type="password" name="pass" autocomplete="current-password"></label>`+
				`<button type="submit">Sign in</button></form></div>`+
				`<script>document.getElementById("f").addEventListener("submit", async (e) => {`+
				`e.preventDefault(); const f = e.target;`+
				`const body = new URLSearchParams({user: f.user.value, pass: f.pass.value});`+
				`await fetch("/login-api", {method: "POST", body});`+
				`location.href = "/home"; });</script>`)
		case "/xorigin-form":
			// A single-page app whose script posts the login to its API on
			// another host name (api.<host>), as portal.salad.com does.
			_, _ = io.WriteString(w, `<!doctype html><title>Sign in</title><h1>Sign in</h1><div id="root"><form id="f">`+
				`<label>Email <input name="user" autocomplete="username"></label>`+
				`<label>Password <input type="password" name="pass" autocomplete="current-password"></label>`+
				`<button type="submit">Sign in</button></form></div>`+
				`<script>document.getElementById("f").addEventListener("submit", async (e) => {`+
				`e.preventDefault(); const f = e.target;`+
				`const body = new URLSearchParams({user: f.user.value, pass: f.pass.value});`+
				`await fetch("https://api." + location.host + "/login-api", {method: "POST", body});`+
				`location.href = "/home"; });</script>`)
		case "/login-api":
			body, _ := io.ReadAll(r.Body)
			w.Header().Set("Access-Control-Allow-Origin", "*")
			l.mu.Lock()
			if strings.HasPrefix(r.Host, "api.") {
				l.apiPosts = append(l.apiPosts, r.Method+" "+string(body))
			} else {
				l.posts = append(l.posts, r.Method+" "+string(body))
			}
			l.mu.Unlock()
		case "/picker":
			_, _ = io.WriteString(w, pickerPage("Passkey", "Password", "Approve on phone"))
		case "/picker-nomatch":
			_, _ = io.WriteString(w, pickerPage("Passkey", "Approve on phone", "Other options"))
		case "/picker-dup":
			_, _ = io.WriteString(w, pickerPage("Password", "Password"))
		case "/picker-offsite":
			_, _ = io.WriteString(w, `<!doctype html><title>Sign in</title><a href="https://evil.example/login">Password</a>`)
		case "/clicked":
			l.mu.Lock()
			l.clicks = append(l.clicks, r.URL.Query().Get("m"))
			l.mu.Unlock()
		case "/confirm":
			_, _ = io.WriteString(w, `<!doctype html><title>Confirm</title><form method="post" action="/login">`+
				`<input type="password" name="pass" autocomplete="current-password"><button>Confirm</button></form>`)
		case "/prefilled":
			_, _ = io.WriteString(w, `<!doctype html><title>Prefilled</title><form method="post" action="/login">`+
				`<input name="user"><input type="password" name="pass"></form>`+
				`<script>document.querySelector("[name=pass]").value = "typed-by-page"</script>`)
		case "/bounce":
			http.Redirect(w, r, other+"/login", http.StatusTemporaryRedirect)
		case "/login":
			body, _ := io.ReadAll(r.Body)
			l.mu.Lock()
			l.posts = append(l.posts, r.Method+" "+string(body))
			l.mu.Unlock()
			http.Redirect(w, r, "/home", http.StatusSeeOther)
		case "/home":
			_, _ = io.WriteString(w, `<!doctype html><title>Home</title><p>welcome</p>`)
		default:
			http.NotFound(w, r)
		}
	}
}

// testCA returns a CA certificate (DER) and a server certificate it signed
// for the hosts.
func testCA(t *testing.T, hosts ...string) ([]byte, tls.Certificate) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "talaria test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: hosts[0]},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	for _, h := range hosts {
		if ip := net.ParseIP(h); ip != nil {
			leaf.IPAddresses = append(leaf.IPAddresses, ip)
		} else {
			leaf.DNSNames = append(leaf.DNSNames, h)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return caDER, tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func serveTLSOn(ctx context.Context, t *testing.T, host string, cert tls.Certificate, h http.Handler) *httptest.Server {
	t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", host+":0")
	if err != nil {
		t.Fatalf("listen on %s: %v", host, err)
	}
	srv := httptest.NewUnstartedServer(h)
	srv.Listener = ln
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	srv.Config.ErrorLog = nil
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// chromeEval runs a script in Firefox's privileged browser window, which
// --remote-allow-system-access opens to BiDi. Only the test uses it, to
// trust the test CA and to save logins the way the user would.
func chromeEval(ctx context.Context, t *testing.T, bc *bidi.Client, expr string) string {
	t.Helper()
	res, err := bc.Call(ctx, "browsingContext.getTree", map[string]any{"moz:scope": "chrome"})
	if err != nil {
		t.Fatalf("chrome contexts: %v", err)
	}
	var tree struct {
		Contexts []struct {
			Context string `json:"context"`
		} `json:"contexts"`
	}
	if err := json.Unmarshal(res, &tree); err != nil || len(tree.Contexts) == 0 {
		t.Fatalf("no chrome context: %v %s", err, res)
	}
	out, err := bc.Call(ctx, "script.evaluate", map[string]any{keyExpr: expr, keyAwait: true,
		keyTarget: map[string]any{keyContext: tree.Contexts[0].Context}})
	if err != nil {
		t.Fatalf("chrome script: %v", err)
	}
	var r struct {
		Type   string `json:"type"`
		Result struct {
			Value any `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &r); err != nil || r.Type != "success" {
		t.Fatalf("chrome script failed: %s", out)
	}
	return fmt.Sprint(r.Result.Value)
}

// seedLogins trusts the CA and saves logins in the test profile's own
// login storage (Services.logins), as Firefox does when the user saves one.
func seedLogins(ctx context.Context, t *testing.T, bc *bidi.Client, caDER []byte, logins [][3]string) {
	t.Helper()
	js := `(async () => {
  const db = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB);
  db.addCertFromBase64(` + jsJSON(t, base64.StdEncoding.EncodeToString(caDER)) + `, "C,,");
  for (const [origin, user, pass] of ` + jsJSON(t, logins) + `) {
    const li = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    li.init(origin, origin, null, user, pass, "user", "pass");
    await Services.logins.addLoginAsync(li);
  }
  return (await Services.logins.getAllLogins()).length;
})()`
	if n := chromeEval(ctx, t, bc, js); n != fmt.Sprint(len(logins)) {
		t.Fatalf("saved logins = %s, want %d", n, len(logins))
	}
}

func jsJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// caller runs browser operations: the broker or the grant gate in front of it.
type caller interface {
	Call(ctx context.Context, op string, args any) (json.RawMessage, error)
}

// recorded calls the broker and keeps every answer and error, so the test
// can check that the password never comes back.
type recorded struct {
	b   caller
	out []string
}

func (r *recorded) call(ctx context.Context, op string, args map[string]any) (json.RawMessage, error) {
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	res, err := r.b.Call(cctx, op, args)
	r.out = append(r.out, string(res))
	if err != nil {
		r.out = append(r.out, err.Error())
	}
	return res, err
}

func (r *recorded) must(ctx context.Context, t *testing.T, op string, args map[string]any, out any) {
	t.Helper()
	res, err := r.call(ctx, op, args)
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
	if out != nil {
		if err := json.Unmarshal(res, out); err != nil {
			t.Fatalf("%s: %v: %s", op, err, res)
		}
	}
}

func (r *recorded) refused(ctx context.Context, t *testing.T, what, want, op string, args map[string]any) {
	t.Helper()
	_, err := r.call(ctx, op, args)
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Errorf("%s: err = %v, want %q", what, err, want)
	}
}

// loginFlow checks browser_login (docs/browser.md section 7.4) with real
// saved logins in the test profile: Firefox itself fills the form.
func loginFlow(ctx context.Context, t *testing.T, b *broker.Broker, gr *grantRig, bc *bidi.Client, firstTab int) {
	t.Helper()
	password := "pw-" + rand.Text()
	caDER, cert := testCA(t, loginHost, otherLoginHost, twoLoginHost, grantHost, postHost)
	other := &loginServer{}
	otherSrv := serveTLSOn(ctx, t, otherLoginHost, cert, other.handler(""))
	main := &loginServer{}
	mainSrv := serveTLSOn(ctx, t, loginHost, cert, main.handler(otherSrv.URL))
	two := &loginServer{}
	twoSrv := serveTLSOn(ctx, t, twoLoginHost, cert, two.handler(""))
	grantLoginSrv := &loginServer{}
	grantSrv := serveTLSOn(ctx, t, loopback, cert, grantLoginSrv.handler(""))
	grantAddr, ok := grantSrv.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("grant host listener is %T", grantSrv.Listener.Addr())
	}
	grantURL := "https://" + grantHost + ":" + strconv.Itoa(grantAddr.Port)
	seedLogins(ctx, t, bc, caDER, [][3]string{
		{grantURL, loginUser, password},
		{mainSrv.URL, loginUser, password},
		{otherSrv.URL, loginUser, password},
		{twoSrv.URL, loginUser, password},
		{twoSrv.URL, "bob", password + "-b"},
	})
	r := &recorded{b: gr.gate}
	rig := &loginRig{r: r, main: main, other: other, two: two, mainURL: mainSrv.URL, twoURL: twoSrv.URL,
		otherURL: otherSrv.URL}
	open := func(u string) tabResult { return rig.open(ctx, t, u) }

	// Not in browser.autologin-hosts: refused, even with an approval.
	otherTab := open(otherSrv.URL + "/")
	r.refused(ctx, t, "login on a host not in the list", "browser.autologin-hosts", "login",
		map[string]any{keyTab: otherTab.TabID, keyGuard: approve(otherLoginHost)})
	if got := other.got(); len(got) != 0 {
		t.Errorf("the unlisted host got posts: %d", len(got))
	}

	// The tab opens in the background; Firefox fills it once browser_login
	// shows it.
	tab := open(mainSrv.URL + "/")
	var before struct {
		Tabs []struct {
			TabID  int  `json:"tab_id"`
			Active bool `json:"active"`
		} `json:"tabs"`
	}
	r.must(ctx, t, "tabs_list", map[string]any{}, &before)
	activeBefore := -1
	for _, x := range before.Tabs {
		if x.Active {
			activeBefore = x.TabID
		}
		if x.TabID == tab.TabID && x.Active {
			t.Errorf("the login tab opened in the foreground")
		}
	}
	t.Logf("active agent tab before login: %d (first tab %d)", activeBefore, firstTab)
	loginRefusals(ctx, t, r, tab.TabID)

	var check map[string]any
	r.must(ctx, t, "check", map[string]any{keyTab: tab.TabID}, &check)
	t.Logf("check: %v", check)
	if a, ok := check["after_activate"].(map[string]any); !ok || a["visibility"] != "visible" || check["restored"] != true {
		t.Errorf("check = %v", check)
	}

	res := rig.login(ctx, t, map[string]any{keyTab: tab.TabID, keyGuard: approve(loginHost)})
	t.Logf("login: %+v", res)
	if !res.Filled || !res.Submitted || res.LandedHost != loginHost || res.Reason != "" {
		t.Errorf("login = %+v", res)
	}
	want := "POST user=" + url.QueryEscape(loginUser) + "&pass=" + url.QueryEscape(password)
	if got := main.got(); len(got) != 1 || got[0] != want {
		t.Errorf("login server got %q, want %q", got, want)
	}
	var text textResult
	r.must(ctx, t, "read_text", map[string]any{keyTab: tab.TabID}, &text)
	if text.Text != "welcome" {
		t.Errorf("after login: %s %q", text.URL, text.Text)
	}
	var after struct {
		Tabs []struct {
			TabID  int  `json:"tab_id"`
			Active bool `json:"active"`
		} `json:"tabs"`
	}
	r.must(ctx, t, "tabs_list", map[string]any{}, &after)
	for _, x := range after.Tabs {
		if x.TabID == tab.TabID && x.Active && activeBefore != tab.TabID {
			t.Errorf("the previously active tab was not restored")
		}
	}

	loginEdges(ctx, t, rig, tab.TabID)
	grantFlow(ctx, t, rig, b, gr, grantLoginSrv, grantURL, tab.TabID, password)
	postHostFlow(ctx, t, rig, gr, grantLoginSrv, grantURL, tab.TabID)

	for _, out := range r.out {
		if strings.Contains(out, password) {
			t.Errorf("a browser answer holds the password: %.200s", out)
		}
	}
	t.Logf("checked %d answers for the password", len(r.out))
}

// loginRig holds the login test servers and the recorded calls.
type loginRig struct {
	r                *recorded
	main, other, two *loginServer
	mainURL, twoURL  string
	otherURL         string
}

func (g *loginRig) open(ctx context.Context, t *testing.T, u string) tabResult {
	t.Helper()
	var tab tabResult
	host := strings.Split(strings.TrimPrefix(u, "https://"), ":")[0]
	g.r.must(ctx, t, "tab_open", map[string]any{keyURL: u, keyGuard: map[string]any{keyVisit: []string{host}}}, &tab)
	return tab
}

func (g *loginRig) login(ctx context.Context, t *testing.T, args map[string]any) loginResult {
	t.Helper()
	var res loginResult
	g.r.must(ctx, t, "login", args, &res)
	return res
}

func approve(host string) map[string]any { return map[string]any{keyLogins: []string{host}} }

// pickerEdges checks the sign-in method picker step of browser_login: the
// configured button is clicked and nothing else, then Firefox fills the
// password form; without a configured label the answer lists the labels; a
// label that no button has exactly, two buttons with the label, a button
// that leads off the autologin hosts and a page with a password field
// already click nothing.
func pickerEdges(ctx context.Context, t *testing.T, rig *loginRig, tabID int) {
	t.Helper()
	// Each page loads in the same agent tab with navigate.
	show := func(u string) int {
		host := strings.Split(strings.TrimPrefix(u, "https://"), ":")[0]
		rig.r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: u, keyGuard: map[string]any{keyVisit: []string{host}}}, nil)
		return tabID
	}
	post := func(res loginResult) bool { return res.Submitted }
	tab := show(rig.mainURL + "/picker")
	res := rig.login(ctx, t, map[string]any{keyTab: tab, keyGuard: approve(loginHost)})
	t.Logf("login through a picker: %+v", res)
	if !res.Filled || !post(res) || res.LandedHost != loginHost || res.Method != pickerMethod || res.Reason != "" {
		t.Errorf("login through a picker = %+v", res)
	}
	if got := rig.main.clicked(); len(got) != 1 || got[0] != "Password" {
		t.Errorf("buttons clicked = %q, want only Password", got)
	}

	// Nothing configured for this host: the labels come back, nothing is clicked.
	two := show(rig.twoURL + "/picker")
	res = rig.login(ctx, t, map[string]any{keyTab: two, keyGuard: approve(twoLoginHost), keyTimeout: 3000})
	t.Logf("picker without a configured method: %+v", res)
	if res.Filled || res.Submitted || !strings.Contains(res.Reason, "no method is configured") ||
		!slices.Equal(res.MethodsSeen, []string{"Password help", "Passkey", "Password", "Approve on phone"}) {
		t.Errorf("picker without a configured method = %+v", res)
	}
	if got := rig.two.clicked(); len(got) != 0 {
		t.Errorf("unconfigured picker clicked %q", got)
	}

	before := len(rig.main.clicked())
	for _, page := range []struct{ path, want string }{
		{"/picker-nomatch", "none has exactly"},
		{"/picker-dup", "more than one button"},
	} {
		tab := show(rig.mainURL + page.path)
		res = rig.login(ctx, t, map[string]any{keyTab: tab, keyGuard: approve(loginHost), keyTimeout: 3000})
		if res.Filled || res.Submitted || !strings.Contains(res.Reason, page.want) {
			t.Errorf("%s = %+v, want a reason with %q", page.path, res, page.want)
		}
	}
	if got := rig.main.clicked(); len(got) != before {
		t.Errorf("a label that did not match exactly clicked %q", got[before:])
	}
	off := show(rig.mainURL + "/picker-offsite")
	rig.r.refused(ctx, t, "a method button that leads off the autologin hosts", "browser.autologin-hosts", "login",
		map[string]any{keyTab: off, keyGuard: approve(loginHost), keyTimeout: 3000})
}

// loginEdges checks a login from a URL, two saved logins, a GET form and
// a 307 redirect to another host.
func loginEdges(ctx context.Context, t *testing.T, rig *loginRig, tabID int) {
	t.Helper()
	// From a URL, in a new tab.
	res := rig.login(ctx, t, map[string]any{keyURL: rig.mainURL + "/", keyGuard: approve(loginHost)})
	if !res.Filled || !res.Submitted || res.LandedHost != loginHost || res.TabID == tabID {
		t.Errorf("login from a URL = %+v", res)
	}

	// Two saved logins: Firefox fills nothing, and the reason says why.
	twoTab := rig.open(ctx, t, rig.twoURL+"/")
	res = rig.login(ctx, t, map[string]any{keyTab: twoTab.TabID, keyGuard: approve(twoLoginHost), keyTimeout: 3000})
	t.Logf("login with two saved logins: %+v", res)
	if res.Filled || res.Submitted || !strings.Contains(res.Reason, "more than one login") {
		t.Errorf("login with two saved logins = %+v", res)
	}
	if got := rig.two.got(); len(got) != 0 {
		t.Errorf("unfilled login posted: %q", got)
	}

	pickerEdges(ctx, t, rig, tabID)

	// A GET form would put the password into the address: the request is
	// cancelled and the tool says so.
	before := len(rig.main.got())
	rig.r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: rig.mainURL + "/get-form"}, nil)
	res = rig.login(ctx, t, map[string]any{keyTab: tabID, keyGuard: approve(loginHost)})
	if !res.Filled || res.Submitted || !strings.Contains(res.Reason, "in the address") {
		t.Errorf("login on a GET form = %+v", res)
	}
	if got := rig.main.got(); len(got) != before {
		t.Errorf("the GET form request reached the server: %q", got)
	}

	// A single-page app form has no method and posts through a script: it
	// works.
	rig.r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: rig.mainURL + "/spa-form"}, nil)
	res = rig.login(ctx, t, map[string]any{keyTab: tabID, keyGuard: approve(loginHost)})
	if !res.Filled || !res.Submitted || res.Reason != "" {
		t.Errorf("login on a script form = %+v", res)
	}
	if got := rig.main.got(); len(got) != before+1 || !strings.HasPrefix(got[before], "POST user=alice&pass=") {
		t.Errorf("the script form post = %q", got)
	}

	// A 307 redirect would post the form again to another host: cancelled.
	var nav tabResult
	rig.r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: rig.mainURL + "/bounce-form"}, &nav)
	t.Logf("navigated to %s", nav.URL)
	res = rig.login(ctx, t, map[string]any{keyTab: tabID, keyGuard: approve(loginHost)})
	t.Logf("login through a 307 to another host: %+v", res)
	// The target is an address, which no sign-in card can allow.
	if !res.Filled || res.Submitted || res.NeedsPostHost != "" || !strings.Contains(res.Reason, otherLoginHost) {
		t.Errorf("login through a 307 = %+v", res)
	}
	if got := rig.other.got(); len(got) != 0 {
		t.Errorf("the 307 target got the login post: %q", got)
	}

	// A form with only a password field (a confirmation) is not submitted.
	rig.r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: rig.mainURL + "/confirm"}, nil)
	res = rig.login(ctx, t, map[string]any{keyTab: tabID, keyGuard: approve(loginHost)})
	if res.Filled || res.Submitted || !strings.Contains(res.Reason, "no username field") {
		t.Errorf("login on a password-only form = %+v", res)
	}

	// Off the list: no script reads a filled password, and check does not
	// show a tab with a password field.
	other := rig.open(ctx, t, rig.otherURL+"/prefilled")
	rig.r.refused(ctx, t, "eval on a page with a filled password", "filled password", "eval", map[string]any{keyTab: other.TabID,
		"script": "return 1", keyGuard: map[string]any{keyScripts: []string{otherLoginHost}, keySensitive: true}})
	var check map[string]any
	rig.r.must(ctx, t, "check", map[string]any{keyTab: other.TabID}, &check)
	if _, shown := check["after_activate"]; shown || !strings.Contains(fmt.Sprint(check["note"]), "not activated") {
		t.Errorf("check on an unlisted password page = %v", check)
	}
}

// loginRefusals checks what is refused on a login page of an autologin
// host, and that its snapshot shows no values.
func loginRefusals(ctx context.Context, t *testing.T, r *recorded, tabID int) {
	t.Helper()
	var snap snapResult
	r.must(ctx, t, "snapshot", map[string]any{keyTab: tabID}, &snap)
	t.Logf("login page snapshot:\n%s", snap.Snapshot)
	if strings.Contains(snap.Snapshot, "value=") {
		t.Errorf("snapshot on an autologin host shows a value: %s", snap.Snapshot)
	}
	r.refused(ctx, t, "eval on an autologin host", "browser.autologin-hosts", "eval", map[string]any{keyTab: tabID,
		"script": "return document.querySelector('[name=pass]').value", keyGuard: map[string]any{keyScripts: []string{loginHost}, keySensitive: true}})
	r.refused(ctx, t, "type into the password field", "browser_login", "type", map[string]any{keyTab: tabID,
		keyRef: refByName(snap.Snapshot, "Password"), keyText: "x", keyGuard: map[string]any{keySensitive: true}})
	r.refused(ctx, t, "click the show button", "browser_login", "click", map[string]any{keyTab: tabID,
		keyRef: refByName(snap.Snapshot, "Show"), keyGuard: map[string]any{keySensitive: true}})
	r.refused(ctx, t, "screenshot of the login page", "autologin", "screenshot", map[string]any{keyTab: tabID})
	r.refused(ctx, t, "selector wait on the login page", "autologin", "wait",
		map[string]any{keyTab: tabID, keySelector: "input[name=pass]:placeholder-shown", keyTimeout: 500})
	r.refused(ctx, t, "login without approval", "needs the user's approval", "login", map[string]any{keyTab: tabID})
}

// grantRig is the sign-in grant gate in front of the test broker, and the
// key that plays the hub: the gate trusts its public key.
type grantRig struct {
	gate *grants.Gate
	key  ed25519.PrivateKey
}

const (
	grantAction = "action"
	grantAdd    = "add"
	grantRevoke = "revoke"
	grantToken  = "token"
	grantHostK  = "host"
	grantUser   = "e2e-user"
	grantDevice = "d_e2e"
)

func newGrantRig(t *testing.T, b *broker.Broker, path string) *grantRig {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store, err := grants.OpenStore(path, nil)
	if err != nil {
		t.Fatal(err)
	}
	gate := grants.NewGate(grants.Options{
		Inner: b, Store: store,
		Keys: &grants.KeyCache{Fetch: func(context.Context) ([]ed25519.PublicKey, error) {
			return []ed25519.PublicKey{pub}, nil
		}},
		Identity:    func(context.Context) (string, string, error) { return grantUser, grantDevice, nil },
		ConfigHosts: []string{loginHost, twoLoginHost}, ConfigMethods: map[string]string{loginHost: pickerMethod},
		Apply: b.SetAutologin,
	})
	return &grantRig{gate: gate, key: priv}
}

func (g *grantRig) token(t *testing.T, host, scope string, postHosts ...string) string {
	t.Helper()
	now := time.Now()
	tok, err := logingrant.Sign(g.key, logingrant.Claims{Sub: grantUser, DeviceID: grantDevice, Host: host, Scope: scope,
		PostHosts: postHosts, SessionID: "s_e2e", ChatTitle: "e2e", Via: "web", IssuedAt: now.Unix(), Expires: now.Add(time.Minute).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// grantFlow checks sign-in grants against the real extension: a host that is
// in no config is refused; after a grant the hub signed, Firefox signs in;
// after the grant is revoked, or a once grant is used up, it is refused again,
// by the daemon and, with the daemon bypassed, by the extension itself, which
// got the new lists.
func grantFlow(ctx context.Context, t *testing.T, rig *loginRig, b *broker.Broker, gr *grantRig, srv *loginServer, u string, tabID int, password string) {
	t.Helper()
	r := rig.r
	guard := approve(grantHost)
	show := func() int {
		r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: u + "/", keyGuard: map[string]any{keyVisit: []string{grantHost}}}, nil)
		return tabID
	}
	login := func() (loginResult, error) {
		var res loginResult
		out, err := r.call(ctx, "login", map[string]any{keyTab: show(), keyGuard: guard, keyTimeout: 5000})
		if err == nil {
			err = json.Unmarshal(out, &res)
		}
		return res, err
	}
	refusedBoth := func(what string) {
		t.Helper()
		if _, err := login(); err == nil || !strings.Contains(err.Error(), grantHost) {
			t.Errorf("%s: daemon err = %v, want a refusal naming %s", what, err, grantHost)
		}
		// With the daemon out of the way the extension refuses too.
		_, err := b.Call(ctx, "login", map[string]any{keyTab: tabID, keyGuard: guard})
		var be *broker.Error
		if !errors.As(err, &be) || !be.Refused() || !strings.Contains(err.Error(), "browser.autologin-hosts") {
			t.Errorf("%s: extension err = %v, want a refusal", what, err)
		}
	}
	grant := func(scope string) {
		t.Helper()
		if _, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantAdd, grantToken: gr.token(t, grantHost, scope)}); err != nil {
			t.Fatalf("add %s grant: %v", scope, err)
		}
	}
	signedIn := func(want int) {
		t.Helper()
		res, err := login()
		if err != nil || !res.Filled || !res.Submitted || res.Reason != "" {
			t.Fatalf("login with a grant = %+v, %v", res, err)
		}
		want2 := "POST user=" + url.QueryEscape(loginUser) + "&pass=" + url.QueryEscape(password)
		if got := srv.got(); len(got) != want || got[want-1] != want2 {
			t.Errorf("grant host got %q, want %d posts ending in %q", got, want, want2)
		}
	}

	refusedBoth("no grant")
	if got := srv.got(); len(got) != 0 {
		t.Fatalf("the ungranted host got posts: %q", got)
	}
	grant(logingrant.ScopeDevice)
	signedIn(1)
	signedIn(2) // a device grant stays until revoked
	out, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantRevoke, grantHostK: grantHost})
	if err != nil || !strings.Contains(string(out), `"revoked":true`) {
		t.Fatalf("revoke = %s, %v", out, err)
	}
	refusedBoth("after revoke")

	grant(logingrant.ScopeOnce)
	signedIn(3)
	refusedBoth("after a once grant was used")
	if got := srv.got(); len(got) != 3 {
		t.Errorf("grant host got %d posts, want 3", len(got))
	}
	// A token the hub did not sign adds nothing.
	_, forged, _ := ed25519.GenerateKey(rand.Reader)
	bad, _ := logingrant.Sign(forged, logingrant.Claims{Sub: grantUser, DeviceID: grantDevice, Host: grantHost, Scope: "device",
		IssuedAt: time.Now().Unix(), Expires: time.Now().Add(time.Minute).Unix()})
	if _, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantAdd, grantToken: bad}); err == nil {
		t.Error("a grant with a wrong signature was accepted")
	}
	refusedBoth("after a forged grant")
}

// postHostFlow checks a login form whose script posts the login to another
// host name (postHost), against the real extension: the post is cancelled
// and the answer names the host; after a grant with that post host, a
// second try on the reloaded page signs in; a once post host holds for one
// sign-in, and a revoked one is cancelled again.
func postHostFlow(ctx context.Context, t *testing.T, rig *loginRig, gr *grantRig, srv *loginServer, u string, tabID int) {
	t.Helper()
	r := rig.r
	page := u + "/xorigin-form"
	add := func(scope string, post ...string) {
		t.Helper()
		if _, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantAdd, grantToken: gr.token(t, grantHost, scope, post...)}); err != nil {
			t.Fatalf("add %s grant %v: %v", scope, post, err)
		}
	}
	login := func(reload bool) loginResult {
		t.Helper()
		if !reload {
			r.must(ctx, t, "navigate", map[string]any{keyTab: tabID, keyURL: page, keyGuard: map[string]any{keyVisit: []string{grantHost}}}, nil)
		}
		args := map[string]any{keyTab: tabID, keyGuard: approve(grantHost), keyTimeout: 5000}
		if reload {
			args["reload"] = true
		}
		return rig.login(ctx, t, args)
	}
	blocked := func(what string, posts int) {
		t.Helper()
		res := login(false)
		t.Logf("%s: %+v", what, res)
		if !res.Filled || res.Submitted || res.NeedsPostHost != postHost || !strings.Contains(res.Reason, postHost) {
			t.Errorf("%s: login = %+v, want not submitted with needs_post_host %s", what, res, postHost)
		}
		if got := srv.gotAPI(); len(got) != posts {
			t.Errorf("%s: the api host got %d posts, want %d", what, len(got), posts)
		}
	}
	signedIn := func(what string, reload bool, posts int) {
		t.Helper()
		res := login(reload)
		t.Logf("%s: %+v", what, res)
		if !res.Filled || !res.Submitted || res.NeedsPostHost != "" || res.Reason != "" {
			t.Errorf("%s: login = %+v", what, res)
		}
		got := srv.gotAPI()
		if len(got) != posts || !strings.HasPrefix(got[len(got)-1], "POST user=alice&pass=") {
			t.Errorf("%s: the api host got %q, want %d posts", what, got, posts)
		}
	}

	add(logingrant.ScopeDevice)
	blocked("no post host", 0)
	// Allow once: the second try reloads the page and signs in.
	add(logingrant.ScopeOnce, postHost)
	signedIn("after allow once", true, 1)
	blocked("once post host used", 1)
	// Allow on this computer: it stays.
	add(logingrant.ScopeDevice, postHost)
	signedIn("after allow on this computer", false, 2)
	signedIn("device post host stays", false, 3)
	out, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantRevoke, grantHostK: grantHost, "post_host": postHost})
	if err != nil || !strings.Contains(string(out), `"revoked":true`) {
		t.Fatalf("revoke post host = %s, %v", out, err)
	}
	blocked("after the post host was revoked", 3)
	if _, err := gr.gate.Call(ctx, grants.OpName, map[string]any{grantAction: grantRevoke, grantHostK: grantHost}); err != nil {
		t.Fatal(err)
	}
}
