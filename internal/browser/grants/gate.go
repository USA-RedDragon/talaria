package grants

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/broker"
	"github.com/USA-RedDragon/talaria/logingrant"
)

// OpName is the browser operation the gate handles itself.
const OpName = "login_grants"

// Caller runs a browser operation: the broker.
type Caller interface {
	Call(ctx context.Context, op string, args any) (json.RawMessage, error)
}

// Options configure a Gate.
type Options struct {
	// Inner is the broker, for every operation but login_grants.
	Inner Caller
	// Store holds the grants.
	Store *Store
	// Keys holds the hub's public keys.
	Keys *KeyCache
	// Identity answers who this device belongs to and its id, as the hub
	// says (whoami), never as the plugin says.
	Identity func(ctx context.Context) (user, deviceID string, err error)
	// ConfigHosts and ConfigMethods are browser.autologin-hosts and
	// browser.autologin-methods.
	ConfigHosts   []string
	ConfigMethods map[string]string
	// Apply sends the merged lists to the extension. Optional.
	Apply func(hosts []string, methods map[string]string)
	// ProfileDirs lists Firefox profile directories to count saved logins
	// in, first one that exists wins. Called for each status.
	ProfileDirs func() []string
	// Now is the clock; time.Now when nil.
	Now func() time.Time
}

// Gate sits in front of the broker. It answers login_grants, refuses login
// on a host that neither the config nor a grant allows, and keeps the
// extension's lists in step with the grants.
type Gate struct {
	o Options

	mu    sync.Mutex
	seen  map[string][]string
	timer *time.Timer
}

// NewGate returns a gate and sends the merged lists to the extension.
func NewGate(o Options) *Gate {
	if o.Now == nil {
		o.Now = time.Now
	}
	g := &Gate{o: o, seen: map[string][]string{}}
	g.Sync()
	return g
}

// Effective returns the hosts browser_login may sign in on and the method
// label per host: the config's, plus the hosts of unexpired grants; a
// grant's method overrides the config's.
func (g *Gate) Effective() ([]string, map[string]string) {
	hosts := slices.Clone(g.o.ConfigHosts)
	methods := maps.Clone(g.o.ConfigMethods)
	if methods == nil {
		methods = map[string]string{}
	}
	all := g.o.Store.Grants()
	for _, gr := range all {
		if !slices.Contains(hosts, gr.Host) {
			hosts = append(hosts, gr.Host)
		}
		if gr.Method != "" && gr.Scope != logingrant.ScopeSession {
			methods[gr.Host] = gr.Method
		}
	}
	for _, gr := range all {
		if _, set := methods[gr.Host]; !set && gr.Method != "" {
			methods[gr.Host] = gr.Method
		}
	}
	return hosts, methods
}

// MaxSessionIDs is the most session ids of a chat's lineage a call names.
const MaxSessionIDs = 32

// sessionIDs returns ids cut to MaxSessionIDs non-empty ids of at most 256
// bytes each.
func sessionIDs(ids []string) []string {
	out := make([]string, 0, min(len(ids), MaxSessionIDs))
	for _, id := range ids {
		if id != "" && len(id) <= 256 && len(out) < MaxSessionIDs {
			out = append(out, id)
		}
	}
	return out
}

// Sync sends the merged lists to the extension and arms the timer for the
// next once grant to expire.
func (g *Gate) Sync() {
	hosts, methods := g.Effective()
	if g.o.Apply != nil {
		g.o.Apply(hosts, methods)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
	if at, ok := g.o.Store.NextExpiry(); ok {
		g.timer = time.AfterFunc(max(time.Until(at), 0)+time.Second, g.Sync)
	}
}

func refuse(op, format string, a ...any) error {
	return &broker.Error{Op: op, Code: broker.CodeRefused, Message: fmt.Sprintf(format, a...)}
}

// Call implements the browser operations.
func (g *Gate) Call(ctx context.Context, op string, args any) (json.RawMessage, error) {
	switch op {
	case OpName:
		return g.grantsOp(ctx, args)
	case "login":
		return g.login(ctx, args)
	case "check":
		res, err := g.o.Inner.Call(ctx, op, args)
		if err != nil {
			return res, err
		}
		var m map[string]any
		if json.Unmarshal(res, &m) != nil || m == nil {
			return res, nil //nolint:nilerr // not an object: the extension's answer stands as it is
		}
		m["login_grants"] = g.list()
		out, merr := json.Marshal(m)
		if merr != nil {
			return res, nil //nolint:nilerr // the extension's own answer stands without the grants
		}
		return out, nil
	}
	return g.o.Inner.Call(ctx, op, args)
}

type loginArgs struct {
	URL string `json:"url"`
	// SessionIDs are the calling chat's session lineage: a session grant
	// holds only when it names one of them.
	SessionIDs []string `json:"session_ids"`
	Guard      struct {
		LoginHosts []string `json:"login_hosts"`
	} `json:"guard"`
}

// PostHosts returns, per host, the other hosts the user allowed its login
// form to send the login to, for the chat whose session lineage is
// sessions; only hosts that have any.
func (g *Gate) PostHosts(hosts, sessions []string) map[string][]string {
	out := map[string][]string{}
	for _, gr := range g.o.Store.Grants() {
		if all := gr.AllPostHosts(); len(all) > 0 && slices.Contains(hosts, gr.Host) && gr.For(sessions) {
			out[gr.Host] = union(out[gr.Host], all)
		}
	}
	return out
}

// withPostHosts returns the login arguments with guard.post_hosts set from
// the grants of hosts. Whatever the caller put there is replaced: only a
// grant the hub signed adds a host.
func withPostHosts(raw []byte, post map[string][]string) (json.RawMessage, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, refuse("login", "bad arguments")
	}
	delete(m, "session_ids")
	var guard map[string]json.RawMessage
	if len(m["guard"]) > 0 && string(m["guard"]) != "null" {
		if err := json.Unmarshal(m["guard"], &guard); err != nil {
			return nil, refuse("login", "bad guard")
		}
	}
	if guard == nil {
		guard = map[string]json.RawMessage{}
	}
	delete(guard, "post_hosts")
	if len(post) > 0 {
		enc, err := json.Marshal(post)
		if err != nil {
			return nil, err
		}
		guard["post_hosts"] = enc
	}
	enc, err := json.Marshal(guard)
	if err != nil {
		return nil, err
	}
	m["guard"] = enc
	return json.Marshal(m)
}

func (g *Gate) login(ctx context.Context, args any) (json.RawMessage, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	var a loginArgs
	_ = json.Unmarshal(raw, &a)
	hosts := make([]string, 0, len(a.Guard.LoginHosts)+1)
	for _, h := range a.Guard.LoginHosts {
		hosts = append(hosts, strings.ToLower(strings.TrimSuffix(h, ".")))
	}
	if h := urlHost(a.URL); h != "" {
		hosts = append(hosts, h)
	}
	sessions := sessionIDs(a.SessionIDs)
	for _, h := range hosts {
		if !slices.Contains(g.o.ConfigHosts, h) && !g.o.Store.Allows(h, sessions) {
			return nil, refuse("login", "browser_login is not allowed on %s: it is not in browser.autologin-hosts and the user has not allowed it for this computer or this chat", h)
		}
	}
	send, err := withPostHosts(raw, g.PostHosts(hosts, sessions))
	if err != nil {
		return nil, err
	}
	res, err := g.o.Inner.Call(ctx, "login", send)
	var out struct {
		Submitted   bool     `json:"submitted"`
		SignedIn    bool     `json:"signed_in"`
		MethodsSeen []string `json:"methods_seen"`
	}
	if err != nil || json.Unmarshal(res, &out) != nil {
		return res, err
	}
	g.mu.Lock()
	for _, h := range hosts {
		switch {
		case out.Submitted || out.SignedIn:
			delete(g.seen, h)
		case len(out.MethodsSeen) > 0:
			g.seen[h] = slices.Clone(out.MethodsSeen)
		}
	}
	g.mu.Unlock()
	if out.Submitted {
		for _, h := range hosts {
			if err := g.o.Store.Used(h, sessions); err != nil {
				slog.Warn("Could not record a sign-in grant use", "host", h, "error", err)
			}
		}
		g.Sync()
	}
	return res, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func urlHost(u string) string {
	rest, ok := strings.CutPrefix(u, "https://")
	if !ok {
		return ""
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}
	if i := strings.LastIndex(rest, ":"); i >= 0 {
		rest = rest[:i]
	}
	return strings.ToLower(strings.TrimSuffix(rest, "."))
}

type configHost struct {
	Host   string `json:"host"`
	Method string `json:"method"`
}

type listResult struct {
	Grants      []Grant      `json:"grants"`
	ConfigHosts []configHost `json:"config_hosts"`
}

func (g *Gate) list() listResult {
	res := listResult{Grants: g.o.Store.Grants(), ConfigHosts: []configHost{}}
	for _, h := range g.o.ConfigHosts {
		res.ConfigHosts = append(res.ConfigHosts, configHost{Host: h, Method: g.o.ConfigMethods[h]})
	}
	return res
}

func (g *Gate) grantsOp(ctx context.Context, args any) (json.RawMessage, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	var a struct {
		Action     string   `json:"action"`
		Host       string   `json:"host"`
		PostHost   string   `json:"post_host"`
		Token      string   `json:"token"`
		SessionIDs []string `json:"session_ids"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return nil, refuse(OpName, "bad arguments: %v", err)
	}
	a.Host = strings.ToLower(strings.TrimSuffix(a.Host, "."))
	a.PostHost = strings.ToLower(strings.TrimSuffix(a.PostHost, "."))
	switch a.Action {
	case "list":
		return json.Marshal(g.list())
	case "status":
		return g.status(a.Host, sessionIDs(a.SessionIDs))
	case "add":
		gr, err := g.add(ctx, a.Token)
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"grant": gr})
	case "revoke":
		ok, err := g.o.Store.Revoke(a.Host, a.PostHost)
		if err != nil {
			return nil, fmt.Errorf("revoke: %w", err)
		}
		if a.PostHost == "" {
			g.mu.Lock()
			delete(g.seen, a.Host)
			g.mu.Unlock()
		}
		g.Sync()
		return json.Marshal(map[string]any{"revoked": ok})
	}
	return nil, refuse(OpName, "unknown action %q", a.Action)
}

func (g *Gate) status(host string, sessions []string) (json.RawMessage, error) {
	if host == "" {
		return nil, refuse(OpName, "status needs a host")
	}
	var grant *Grant
	if gr, ok := g.o.Store.Get(host, sessions); ok {
		grant = &gr
	}
	_, methods := g.Effective()
	saved := -1
	if g.o.ProfileDirs != nil {
		saved = savedLogins(g.o.ProfileDirs(), host)
	}
	g.mu.Lock()
	seen := slices.Clone(g.seen[host])
	g.mu.Unlock()
	if seen == nil {
		seen = []string{}
	}
	return json.Marshal(map[string]any{"host": host, "config": slices.Contains(g.o.ConfigHosts, host), "grant": grant,
		"once": grant != nil && grant.Scope == logingrant.ScopeOnce, "session": grant != nil && grant.Scope == logingrant.ScopeSession,
		"method": methods[host], "saved_logins": saved, "methods_seen": seen,
		"post_hosts": nonNil(g.PostHosts([]string{host}, sessions)[host])})
}

// add verifies a grant token and stores it. The grant must verify with a hub
// key, name this device's user and id, and carry a nonce not seen before.
func (g *Gate) add(ctx context.Context, token string) (Grant, error) {
	keys, err := g.o.Keys.Keys(ctx)
	var c *logingrant.Claims
	if err == nil {
		c, err = verify(ctx, g.o.Keys, keys, token, g.o.Now())
	}
	if err != nil {
		return Grant{}, refuse(OpName, "%v", err)
	}
	user, id, err := g.o.Identity(ctx)
	if err != nil || user == "" || id == "" {
		return Grant{}, refuse(OpName, "cannot confirm this device's user with the hub")
	}
	if c.Sub != user {
		return Grant{}, refuse(OpName, "sign-in grant is for another user")
	}
	if c.DeviceID != id {
		return Grant{}, refuse(OpName, "sign-in grant is for another computer")
	}
	gr, err := g.o.Store.Add(c)
	switch {
	case errors.Is(err, ErrNonceUsed):
		return Grant{}, refuse(OpName, "%v", err)
	case err != nil:
		return Grant{}, fmt.Errorf("store the grant: %w", err)
	}
	g.Sync()
	return gr, nil
}

// verify checks token with keys; when no key fits it fetches the hub keys
// again (at most once a minute) and tries once more.
func verify(ctx context.Context, kc *KeyCache, keys []ed25519.PublicKey, token string, now time.Time) (*logingrant.Claims, error) {
	c, err := logingrant.Verify(keys, token, now)
	if errors.Is(err, logingrant.ErrSignature) || errors.Is(err, logingrant.ErrNoKeys) {
		fresh, ferr := kc.Refresh(ctx)
		if ferr == nil && len(fresh) > 0 {
			return logingrant.Verify(fresh, token, now)
		}
	}
	return c, err
}
