package grants_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/broker"
	"github.com/USA-RedDragon/talaria/internal/browser/grants"
	"github.com/USA-RedDragon/talaria/logingrant"
)

const (
	pwMethod   = "Password"
	kAction    = "action"
	kRevoke    = "revoke"
	kHost      = "host"
	kStatus    = "status"
	scopeDev   = "device"
	testUser   = "jacob"
	testDevice = "d_test"
	hostA      = "portal.example.com"
	hostB      = "static.example.com"
	kGuard     = "guard"
	kLogins    = "login_hosts"
	kList      = "list"
	scopeOnce  = "once"
	submitted  = `{"filled":true,"submitted":true}`
)

type fakeInner struct {
	mu    sync.Mutex
	calls []string
	args  []string
	reply map[string]string
}

func (f *fakeInner) Call(_ context.Context, op string, args any) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, op)
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	f.args = append(f.args, string(raw))
	if r, ok := f.reply[op]; ok {
		return json.RawMessage(r), nil
	}
	return json.RawMessage(`{}`), nil
}

// lastPostHosts returns guard.post_hosts of the last call.
func (f *fakeInner) lastPostHosts(t *testing.T) map[string][]string {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var a struct {
		Guard struct {
			PostHosts map[string][]string `json:"post_hosts"`
		} `json:"guard"`
	}
	if err := json.Unmarshal([]byte(f.args[len(f.args)-1]), &a); err != nil {
		t.Fatal(err)
	}
	return a.Guard.PostHosts
}

func (f *fakeInner) count(op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == op {
			n++
		}
	}
	return n
}

type applied struct {
	mu      sync.Mutex
	hosts   []string
	methods map[string]string
	n       int
}

func (a *applied) apply(h []string, m map[string]string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.hosts, a.methods, a.n = slices.Clone(h), m, a.n+1
}

func (a *applied) get() ([]string, map[string]string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.hosts), a.methods
}

type rig struct {
	gate    *grants.Gate
	inner   *fakeInner
	applied *applied
	pub     ed25519.PublicKey
	priv    ed25519.PrivateKey
	path    string
	now     time.Time
	fetches int
	profile string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	r := &rig{inner: &fakeInner{reply: map[string]string{}}, applied: &applied{}, pub: pub, priv: priv,
		path: filepath.Join(t.TempDir(), "state", grants.FileName), now: time.Now(), profile: t.TempDir()}
	r.gate = r.build(t)
	return r
}

func (r *rig) build(t *testing.T) *grants.Gate {
	t.Helper()
	store, err := grants.OpenStore(r.path, func() time.Time { return r.now })
	if err != nil {
		t.Fatal(err)
	}
	return grants.NewGate(grants.Options{
		Inner: r.inner, Store: store,
		Keys: &grants.KeyCache{Now: func() time.Time { return r.now }, Fetch: func(context.Context) ([]ed25519.PublicKey, error) {
			r.fetches++
			return []ed25519.PublicKey{r.pub}, nil
		}},
		Identity:    func(context.Context) (string, string, error) { return testUser, testDevice, nil },
		ConfigHosts: []string{hostB}, ConfigMethods: map[string]string{hostB: pwMethod},
		Apply: r.applied.apply, ProfileDirs: func() []string { return []string{r.profile} },
		Now: func() time.Time { return r.now },
	})
}

func (r *rig) token(t *testing.T, mod func(*logingrant.Claims)) string {
	t.Helper()
	c := logingrant.Claims{Sub: testUser, DeviceID: testDevice, Host: hostA, Scope: logingrant.ScopeDevice,
		SessionID: "s1", ChatTitle: "chat", Via: "web", IssuedAt: r.now.Unix(), Expires: r.now.Add(2 * time.Minute).Unix()}
	if mod != nil {
		mod(&c)
	}
	tok, err := logingrant.Sign(r.priv, c)
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (r *rig) op(t *testing.T, args map[string]any) (map[string]any, error) {
	t.Helper()
	res, err := r.gate.Call(t.Context(), "login_grants", args)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(res, &out); err != nil {
		t.Fatalf("result %s: %v", res, err)
	}
	return out, nil
}

func (r *rig) add(t *testing.T, tok string) error {
	t.Helper()
	_, err := r.op(t, map[string]any{kAction: "add", "token": tok})
	return err
}

func (r *rig) login(host string) (json.RawMessage, error) {
	return r.gate.Call(context.Background(), "login", map[string]any{kTab: 1, kGuard: map[string]any{kLogins: []string{host}}})
}

func wantRefused(t *testing.T, err error, contains string) {
	t.Helper()
	var be *broker.Error
	if !errors.As(err, &be) || !be.Refused() || !strings.Contains(err.Error(), contains) {
		t.Fatalf("err = %v, want a refusal containing %q", err, contains)
	}
}

func TestAddStoresGrantWith0600AndReloads(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Method = pwMethod })); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(r.path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 600", fi.Mode().Perm())
	}
	g2 := r.build(t)
	res, err := g2.Call(t.Context(), "login_grants", map[string]any{kAction: kList})
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Grants []grants.Grant `json:"grants"`
	}
	if err := json.Unmarshal(res, &list); err != nil || len(list.Grants) != 1 {
		t.Fatalf("after reload: %s %v", res, err)
	}
	g := list.Grants[0]
	if g.Host != hostA || g.Method != pwMethod || g.Scope != scopeDev || g.User != testUser || g.SessionID != "s1" ||
		g.ChatTitle != "chat" || g.Via != "web" || g.GrantedAt != r.now.Unix() || g.LastUsed != 0 {
		t.Errorf("grant = %+v", g)
	}
	// A reloaded gate still refuses the same token: the nonce persisted.
	tok := r.token(t, nil)
	if err := r.add(t, tok); err != nil {
		t.Fatal(err)
	}
	r.gate = r.build(t)
	wantRefused(t, r.add(t, tok), "already used")
}

func TestAddRefusals(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	other, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	_ = other
	forged, err := logingrant.Sign(otherPriv, logingrant.Claims{Sub: testUser, DeviceID: testDevice, Host: hostA,
		Scope: scopeDev, IssuedAt: r.now.Unix(), Expires: r.now.Add(time.Minute).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ tok, want string }{
		"wrong key":    {forged, "signature"},
		"wrong device": {r.token(t, func(c *logingrant.Claims) { c.DeviceID = "d_other" }), "another computer"},
		"wrong user":   {r.token(t, func(c *logingrant.Claims) { c.Sub = "mallory" }), "another user"},
		"expired": {r.token(t, func(c *logingrant.Claims) {
			c.IssuedAt, c.Expires = r.now.Add(-10*time.Minute).Unix(), r.now.Add(-5*time.Minute).Unix()
		}), "expired"},
		"garbage":  {"lg1.abc.def", "malformed"},
		"bad host": {"", "malformed"},
	} {
		wantRefused(t, r.add(t, tc.tok), tc.want)
		if name == "wrong key" || name == "wrong device" {
			if got, _ := r.op(t, map[string]any{kAction: kList}); len(asList(got["grants"])) != 0 {
				t.Errorf("%s stored a grant", name)
			}
		}
	}
	if _, err := os.Stat(r.path); err == nil {
		t.Error("a refused grant created the store file")
	}
	// Replay.
	tok := r.token(t, nil)
	if err := r.add(t, tok); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, r.add(t, tok), "already used")
}

func TestRefusedWithoutGrantAndAllowedWithOne(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	_, err := r.login(hostA)
	wantRefused(t, err, hostA)
	if r.inner.count("login") != 0 {
		t.Fatal("login reached the extension without a grant")
	}
	// A login by URL is checked too.
	_, err = r.gate.Call(t.Context(), "login", map[string]any{"url": "https://" + hostA + "/x", kGuard: map[string]any{kLogins: []string{hostB}}})
	wantRefused(t, err, hostA)
	if _, err := r.login(hostB); err != nil {
		t.Errorf("config host refused: %v", err)
	}
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.login(hostA); err != nil {
		t.Errorf("granted host refused: %v", err)
	}
}

func TestMergeWithConfigAndBrokerResent(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	hosts, methods := r.applied.get()
	if !slices.Equal(hosts, []string{hostB}) || methods[hostB] != pwMethod {
		t.Fatalf("initial = %v %v", hosts, methods)
	}
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Method = "Email link" })); err != nil {
		t.Fatal(err)
	}
	hosts, methods = r.applied.get()
	if !slices.Equal(hosts, []string{hostB, hostA}) || methods[hostA] != "Email link" || methods[hostB] != pwMethod {
		t.Errorf("merged = %v %v", hosts, methods)
	}
	// A grant for a config host overrides its method only.
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Host, c.Method = hostB, "Other" })); err != nil {
		t.Fatal(err)
	}
	hosts, methods = r.applied.get()
	if !slices.Equal(hosts, []string{hostB, hostA}) || methods[hostB] != "Other" {
		t.Errorf("override = %v %v", hosts, methods)
	}
	// Revoke takes effect at once: refused and the extension's config resent.
	out, err := r.op(t, map[string]any{kAction: kRevoke, kHost: hostA})
	if err != nil || out["revoked"] != true {
		t.Fatalf("revoke = %v %v", out, err)
	}
	hosts, _ = r.applied.get()
	if !slices.Equal(hosts, []string{hostB}) {
		t.Errorf("after revoke hosts = %v", hosts)
	}
	_, err = r.login(hostA)
	wantRefused(t, err, hostA)
	out, _ = r.op(t, map[string]any{kAction: kRevoke, kHost: hostA})
	if out["revoked"] != false {
		t.Errorf("second revoke = %v", out)
	}
	// A config host cannot be revoked.
	out, _ = r.op(t, map[string]any{kAction: kRevoke, kHost: "nothere.example.com"})
	if out["revoked"] != false {
		t.Errorf("revoke of nothing = %v", out)
	}
}

func TestOnceGrantConsumedBySubmittedLogin(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Scope = scopeOnce })); err != nil {
		t.Fatal(err)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if st["once"] != true || st["grant"] == nil {
		t.Fatalf("status = %v", st)
	}
	// An unsubmitted login keeps it.
	r.inner.reply["login"] = `{"filled":true,"submitted":false,"reason":"x"}`
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	if _, err := r.login(hostA); err != nil {
		t.Fatalf("once grant gone after an unsubmitted login: %v", err)
	}
	r.inner.reply["login"] = submitted
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	_, err := r.login(hostA)
	wantRefused(t, err, hostA)
	if hosts, _ := r.applied.get(); slices.Contains(hosts, hostA) {
		t.Errorf("extension still lists %s: %v", hostA, hosts)
	}
}

func TestOnceGrantExpires(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Scope = scopeOnce })); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(logingrant.OnceLifetime + time.Second)
	_, err := r.login(hostA)
	wantRefused(t, err, hostA)
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if st["grant"] != nil {
		t.Errorf("expired once grant in status: %v", st)
	}
}

func TestDeviceGrantLastUsedAndMethodsSeen(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	r.inner.reply["login"] = `{"filled":false,"submitted":false,"reason":"no method is configured","methods_seen":["Password","Passkey"]}`
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if seen, merr := json.Marshal(st["methods_seen"]); merr != nil || string(seen) != `["Password","Passkey"]` {
		t.Errorf("methods_seen = %s", seen)
	}
	r.now = r.now.Add(time.Hour)
	r.inner.reply["login"] = submitted
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	st, _ = r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	g, _ := st["grant"].(map[string]any)
	if lu, _ := g["last_used"].(float64); int64(lu) != r.now.Unix() {
		t.Errorf("last_used = %v, want %d", g["last_used"], r.now.Unix())
	}
	if len(asList(st["methods_seen"])) != 0 {
		t.Errorf("methods_seen kept after a sign-in: %v", st["methods_seen"])
	}
}

func TestSignedInPageDropsMethodsSeen(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	r.inner.reply["login"] = `{"filled":false,"submitted":false,"reason":"no method is configured","methods_seen":["jacob@example.com acme"]}`
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	r.inner.reply["login"] = `{"filled":false,"submitted":false,"signed_in":true}`
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if len(asList(st["methods_seen"])) != 0 {
		t.Errorf("methods_seen kept after a signed-in page: %v", st["methods_seen"])
	}
}

func TestStatusSavedLoginsReadsOnlyHostnames(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if n, _ := st["saved_logins"].(float64); n != 0 {
		t.Errorf("no logins.json: saved_logins = %v", st["saved_logins"])
	}
	body := `{"logins":[{"hostname":"https://` + hostA + `","encryptedUsername":"SECRET-U","encryptedPassword":"SECRET-P"},` +
		`{"hostname":"https://other.example.com"},{"hostname":"http://` + hostA + `"},{"hostname":"https://` + hostA + `"}]}`
	if err := os.WriteFile(filepath.Join(r.profile, "logins.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err := r.gate.Call(t.Context(), "login_grants", map[string]any{kAction: kStatus, kHost: hostA})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(res), "SECRET") || !strings.Contains(string(res), `"saved_logins":2`) {
		t.Errorf("status = %s", res)
	}
	r.gate = grants.NewGate(grants.Options{Inner: r.inner, Store: mustStore(t), Keys: &grants.KeyCache{}, ProfileDirs: func() []string { return nil }})
	st, _ = r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if n, _ := st["saved_logins"].(float64); n != -1 {
		t.Errorf("unknown profile: saved_logins = %v", st["saved_logins"])
	}
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func mustStore(t *testing.T) *grants.Store {
	t.Helper()
	s, err := grants.OpenStore(filepath.Join(t.TempDir(), grants.FileName), nil)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestCheckGainsLoginGrantsAndListShowsConfigHosts(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	r.inner.reply["check"] = `{"window_state":"normal"}`
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	res, err := r.gate.Call(t.Context(), "check", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		WindowState string `json:"window_state"`
		LoginGrants struct {
			Grants      []grants.Grant                  `json:"grants"`
			ConfigHosts []struct{ Host, Method string } `json:"config_hosts"`
		} `json:"login_grants"`
	}
	if err := json.Unmarshal(res, &out); err != nil || out.WindowState != "normal" || len(out.LoginGrants.Grants) != 1 ||
		len(out.LoginGrants.ConfigHosts) != 1 || out.LoginGrants.ConfigHosts[0].Method != pwMethod {
		t.Errorf("check = %s %v", res, err)
	}
}

func TestHubKeysRefetchedOnceAMinute(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	rotatedPub, rotatedPriv, _ := ed25519.GenerateKey(rand.Reader)
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	if r.fetches != 1 {
		t.Fatalf("fetches = %d", r.fetches)
	}
	// The hub rotates its key: the cached key fails, one refetch fixes it.
	r.pub, r.priv = rotatedPub, rotatedPriv
	r.now = r.now.Add(2 * time.Minute)
	if err := r.add(t, r.token(t, func(c *logingrant.Claims) { c.Host = "new.example.com" })); err != nil {
		t.Fatalf("after rotation: %v", err)
	}
	if r.fetches != 2 {
		t.Fatalf("fetches = %d, want 2", r.fetches)
	}
	// A bad signature right after: no third fetch within a minute.
	_, bad, _ := ed25519.GenerateKey(rand.Reader)
	forged, _ := logingrant.Sign(bad, logingrant.Claims{Sub: testUser, DeviceID: testDevice, Host: hostA, Scope: scopeDev,
		IssuedAt: r.now.Unix(), Expires: r.now.Add(time.Minute).Unix()})
	wantRefused(t, r.add(t, forged), "signature")
	wantRefused(t, r.add(t, forged), "signature")
	if r.fetches != 2 {
		t.Errorf("fetches = %d, want 2 (rate limited)", r.fetches)
	}
}

func TestUnknownActionAndMissingHost(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	_, err := r.op(t, map[string]any{kAction: "nope"})
	wantRefused(t, err, "unknown action")
	_, err = r.op(t, map[string]any{kAction: kStatus})
	wantRefused(t, err, "needs a host")
}

func TestDesktopProfileFromProfilesINI(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "linux" {
		t.Skip("linux profile locations")
	}
	home := t.TempDir()
	root := filepath.Join(home, ".mozilla", "firefox")
	prof := filepath.Join(root, "abc.default-release")
	if err := os.MkdirAll(prof, 0o700); err != nil {
		t.Fatal(err)
	}
	ini := "[Profile1]\nName=old\nIsRelative=1\nPath=zzz.old\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n\n[General]\nStartWithLastProfile=1\n"
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := grants.DesktopProfileDirs(home); !slices.Equal(got, []string{prof}) {
		t.Errorf("profile dirs = %v, want %v", got, prof)
	}
	if got := grants.DesktopProfileDirs(t.TempDir()); len(got) != 0 {
		t.Errorf("no profiles.ini: %v", got)
	}
}

const (
	apiA = "portal-api.example.com"
	apiB = "auth.example.net"
)

func (r *rig) grant(t *testing.T, mod func(*logingrant.Claims)) grants.Grant {
	t.Helper()
	out, err := r.op(t, map[string]any{kAction: "add", "token": r.token(t, mod)})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(out["grant"])
	if err != nil {
		t.Fatal(err)
	}
	var g grants.Grant
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func (r *rig) listed(t *testing.T, host string) grants.Grant {
	t.Helper()
	res, err := r.gate.Call(t.Context(), "login_grants", map[string]any{kAction: kList})
	if err != nil {
		t.Fatal(err)
	}
	var list struct {
		Grants []grants.Grant `json:"grants"`
	}
	if err := json.Unmarshal(res, &list); err != nil {
		t.Fatal(err)
	}
	for _, g := range list.Grants {
		if g.Host == host {
			return g
		}
	}
	return grants.Grant{}
}

func TestPostHostsGoWithTheirLoginHostOnly(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiA} })
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	if got := r.inner.lastPostHosts(t); len(got) != 1 || !slices.Equal(got[hostA], []string{apiA}) {
		t.Errorf("post hosts for %s = %v", hostA, got)
	}
	// Another login host gets none, and what the caller put in the guard is
	// dropped: only a signed grant adds a host.
	if _, err := r.gate.Call(t.Context(), "login", map[string]any{"tab_id": 1, kGuard: map[string]any{
		kLogins: []string{hostB}, "post_hosts": map[string][]string{hostB: {"evil.example.org"}}}}); err != nil {
		t.Fatal(err)
	}
	if got := r.inner.lastPostHosts(t); len(got) != 0 {
		t.Errorf("post hosts for %s = %v, want none", hostB, got)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA})
	if ph := asList(st["post_hosts"]); len(ph) != 1 || ph[0] != apiA {
		t.Errorf("status post_hosts = %v", st["post_hosts"])
	}
	st, _ = r.op(t, map[string]any{kAction: kStatus, kHost: hostB})
	if ph, ok := st["post_hosts"].([]any); !ok || len(ph) != 0 {
		t.Errorf("status post_hosts of %s = %v", hostB, st["post_hosts"])
	}
}

func TestPostHostsAddUp(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiA} })
	g := r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiB} })
	if !slices.Equal(g.PostHosts, []string{apiA, apiB}) || g.Scope != scopeDev {
		t.Errorf("grant = %+v", g)
	}
	// A device grant without post hosts keeps the earlier ones.
	g = r.grant(t, func(c *logingrant.Claims) { c.Method = pwMethod })
	if !slices.Equal(g.PostHosts, []string{apiA, apiB}) || g.Method != pwMethod {
		t.Errorf("grant = %+v", g)
	}
	// A post host card without a method keeps the grant's method.
	g = r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiA} })
	if g.Method != pwMethod {
		t.Errorf("grant after a post host card = %+v", g)
	}
	// A config host takes a grant for its post host alone.
	g = r.grant(t, func(c *logingrant.Claims) { c.Host, c.Scope, c.PostHosts = hostB, scopeOnce, []string{apiA} })
	if g.Scope != scopeOnce || !slices.Equal(g.PostHosts, []string{apiA}) {
		t.Errorf("config host grant = %+v", g)
	}
}

func TestOncePostHostOnADeviceGrant(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	r.grant(t, nil)
	g := r.grant(t, func(c *logingrant.Claims) { c.Scope, c.PostHosts = scopeOnce, []string{apiA} })
	if g.Scope != scopeDev || len(g.PostHosts) != 0 || !slices.Equal(g.OncePostHosts, []string{apiA}) ||
		g.OncePostExpiresAt != r.now.Add(logingrant.OnceLifetime).Unix() {
		t.Fatalf("grant = %+v", g)
	}
	// Kept by a login that did not submit, used up by one that did.
	r.inner.reply["login"] = `{"filled":true,"submitted":false,"needs_post_host":"x.example.com"}`
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	if got := r.inner.lastPostHosts(t); !slices.Equal(got[hostA], []string{apiA}) {
		t.Errorf("post hosts = %v", got)
	}
	r.inner.reply["login"] = submitted
	if _, err := r.login(hostA); err != nil {
		t.Fatal(err)
	}
	if _, err := r.login(hostA); err != nil {
		t.Fatalf("the device grant went with the once post host: %v", err)
	}
	if got := r.inner.lastPostHosts(t); len(got) != 0 {
		t.Errorf("post hosts after the sign-in = %v", got)
	}
	if g := r.listed(t, hostA); g.Scope != scopeDev || len(g.OncePostHosts) != 0 || g.OncePostExpiresAt != 0 {
		t.Errorf("listed = %+v", g)
	}
	// Unused, it expires with the once lifetime.
	r.grant(t, func(c *logingrant.Claims) { c.Scope, c.PostHosts = scopeOnce, []string{apiA} })
	r.now = r.now.Add(logingrant.OnceLifetime + time.Second)
	if g := r.listed(t, hostA); g.Scope != scopeDev || len(g.OncePostHosts) != 0 {
		t.Errorf("after expiry = %+v", g)
	}
	// A device grant for the post host makes it lasting.
	r.grant(t, func(c *logingrant.Claims) { c.Scope, c.PostHosts = scopeOnce, []string{apiA} })
	g = r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiA} })
	if !slices.Equal(g.PostHosts, []string{apiA}) || len(g.OncePostHosts) != 0 {
		t.Errorf("device after once = %+v", g)
	}
}

func TestRevokeOnePostHost(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	r.grant(t, func(c *logingrant.Claims) { c.PostHosts = []string{apiA, apiB} })
	out, err := r.op(t, map[string]any{kAction: kRevoke, kHost: hostA, "post_host": "Portal-API.example.com."})
	if err != nil || out["revoked"] != true {
		t.Fatalf("revoke = %v %v", out, err)
	}
	if g := r.listed(t, hostA); g.Host != hostA || !slices.Equal(g.PostHosts, []string{apiB}) {
		t.Errorf("after revoke = %+v", g)
	}
	out, _ = r.op(t, map[string]any{kAction: kRevoke, kHost: hostA, "post_host": apiA})
	if out["revoked"] != false {
		t.Errorf("second revoke = %v", out)
	}
	if _, err := r.login(hostA); err != nil {
		t.Errorf("the login grant went with its post host: %v", err)
	}
	if got := r.inner.lastPostHosts(t); !slices.Equal(got[hostA], []string{apiB}) {
		t.Errorf("post hosts = %v", got)
	}
}

func (r *rig) loginAs(sessions ...string) (json.RawMessage, error) {
	return r.gate.Call(context.Background(), "login", map[string]any{kTab: 1, kSessions: sessions,
		kGuard: map[string]any{kLogins: []string{hostA}}})
}

const (
	chatA     = "20261124_090000_aaaaaa"
	chatB     = "20261124_090000_bbbbbb"
	subOfA    = "20261124_091500_cccccc"
	scopeSes  = "session"
	kTab      = "tab_id"
	kSessions = "session_ids"
)

func sessionToken(r *rig, t *testing.T, chat string, mod func(*logingrant.Claims)) string {
	t.Helper()
	return r.token(t, func(c *logingrant.Claims) {
		c.Scope, c.SessionID = logingrant.ScopeSession, chat
		if mod != nil {
			mod(c)
		}
	})
}

func TestSessionGrantHoldsOnlyForItsChat(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, sessionToken(r, t, chatA, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.loginAs(chatA); err != nil {
		t.Errorf("same chat refused: %v", err)
	}
	if _, err := r.loginAs(subOfA, chatA); err != nil {
		t.Errorf("subagent of the chat refused: %v", err)
	}
	_, err := r.loginAs(chatB)
	wantRefused(t, err, hostA)
	_, err = r.loginAs()
	wantRefused(t, err, hostA)
	_, err = r.login(hostA)
	wantRefused(t, err, hostA)
	if got := r.inner.count("login"); got != 2 {
		t.Errorf("logins reaching the extension = %d, want 2", got)
	}
	r.inner.mu.Lock()
	sent := r.inner.args[len(r.inner.args)-1]
	r.inner.mu.Unlock()
	if strings.Contains(sent, "session_ids") {
		t.Errorf("session ids reached the extension: %s", sent)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA, kSessions: []string{chatA}})
	if st["session"] != true || st["grant"] == nil {
		t.Errorf("status for the chat = %v", st)
	}
	st, _ = r.op(t, map[string]any{kAction: kStatus, kHost: hostA, kSessions: []string{chatB}})
	if st["grant"] != nil || st["session"] != false {
		t.Errorf("status for another chat = %v", st)
	}
	if hosts, _ := r.applied.get(); !slices.Contains(hosts, hostA) {
		t.Errorf("extension does not list the session grant's host: %v", hosts)
	}
}

func TestSessionGrantSurvivesUseAndDropsOnRevoke(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, sessionToken(r, t, chatA, nil)); err != nil {
		t.Fatal(err)
	}
	if err := r.add(t, sessionToken(r, t, chatB, nil)); err != nil {
		t.Fatal(err)
	}
	r.inner.reply["login"] = submitted
	for range 2 {
		if _, err := r.loginAs(chatA); err != nil {
			t.Fatalf("session grant gone after a sign-in: %v", err)
		}
	}
	out, err := r.op(t, map[string]any{kAction: kRevoke, kHost: hostA})
	if err != nil || out["revoked"] != true {
		t.Fatalf("revoke = %v %v", out, err)
	}
	for _, chat := range []string{chatA, chatB} {
		_, err := r.loginAs(chat)
		wantRefused(t, err, hostA)
	}
}

func TestSessionGrantExpiresUnused(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, sessionToken(r, t, chatA, nil)); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(logingrant.SessionLifetime - time.Hour)
	r.inner.reply["login"] = submitted
	if _, err := r.loginAs(chatA); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(logingrant.SessionLifetime - time.Hour)
	if _, err := r.loginAs(chatA); err != nil {
		t.Fatalf("a used session grant expired early: %v", err)
	}
	r.now = r.now.Add(logingrant.SessionLifetime + time.Hour)
	_, err := r.loginAs(chatA)
	wantRefused(t, err, hostA)
}

func TestSessionGrantKeptApartFromDeviceGrant(t *testing.T) {
	t.Parallel()
	r := newRig(t)
	if err := r.add(t, sessionToken(r, t, chatA, func(c *logingrant.Claims) {
		c.PostHosts = []string{"api.example.com"}
	})); err != nil {
		t.Fatal(err)
	}
	if err := r.add(t, r.token(t, nil)); err != nil {
		t.Fatal(err)
	}
	if _, err := r.loginAs(chatB); err != nil {
		t.Errorf("device grant refused for another chat: %v", err)
	}
	if got := r.inner.lastPostHosts(t)[hostA]; len(got) != 0 {
		t.Errorf("another chat got the session grant's post hosts: %v", got)
	}
	if _, err := r.loginAs(chatA); err != nil {
		t.Fatal(err)
	}
	if got := r.inner.lastPostHosts(t)[hostA]; !slices.Equal(got, []string{"api.example.com"}) {
		t.Errorf("the chat's post hosts = %v", got)
	}
	st, _ := r.op(t, map[string]any{kAction: kStatus, kHost: hostA, kSessions: []string{chatA}})
	if g, _ := st["grant"].(map[string]any); g == nil || g["scope"] != scopeDev {
		t.Errorf("status prefers the device grant: %v", st)
	}
	list, _ := r.op(t, map[string]any{kAction: kList})
	scopes := []string{}
	for _, g := range asList(list["grants"]) {
		if m, ok := g.(map[string]any); ok {
			if sc, ok := m["scope"].(string); ok {
				scopes = append(scopes, sc)
			}
		}
	}
	slices.Sort(scopes)
	if !slices.Equal(scopes, []string{scopeDev, scopeSes}) {
		t.Errorf("stored scopes = %v", scopes)
	}
}
