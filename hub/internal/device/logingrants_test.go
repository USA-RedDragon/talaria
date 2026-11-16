package device_test

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/logingrant"
)

const (
	grantHost  = "portal.example.com"
	grantVia   = "web"
	methodPass = "Password"
	noDevice   = "d_none"
)

func pubKey(k ed25519.PrivateKey) ed25519.PublicKey {
	pub, _ := k.Public().(ed25519.PublicKey)
	return pub
}

// A device reads the hub's public keys over its own authenticated
// connection, a sandbox device too, and nobody else.
func TestHubKeys(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		tok, _ := e.pair(e.a)
		want := base64.StdEncoding.EncodeToString(pubKey(e.key))
		for _, token := range []string{tok, sandboxDevKey} {
			s, out := call(t, http.MethodGet, e.a.url+"/api/device/hub-keys", token, nil)
			keys, _ := out["keys"].([]any)
			if s != http.StatusOK || len(keys) != 1 || keys[0] != want {
				t.Fatalf("hub-keys = %d %v, want [%s]", s, out, want)
			}
			key, _ := keys[0].(string)
			raw, err := base64.StdEncoding.DecodeString(key)
			if err != nil || len(raw) != ed25519.PublicKeySize {
				t.Fatalf("key = %v, %v", raw, err)
			}
		}
		if s, _ := call(t, http.MethodGet, e.a.url+"/api/device/hub-keys", "", nil); s != http.StatusUnauthorized {
			t.Fatalf("hub-keys without a token = %d", s)
		}
		if s, _ := call(t, http.MethodGet, e.a.url+"/api/device/hub-keys", tok+"x", nil); s != http.StatusUnauthorized {
			t.Fatalf("hub-keys with a wrong token = %d", s)
		}
	})
}

// The hub signs the grant with its device key for the computer, the user and
// the chat, and the plugin gets it; the same key verifies it.
func TestGrantLoginSignsAndDelivers(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		req := hub.LoginGrantRequest{User: userAlice, BackendID: backendID, DeviceID: id, Host: grantHost, Method: methodPass, Scope: logingrant.ScopeDevice,
			SessionID: "s1", ChatTitle: "Pay the bill", Via: grantVia}
		if err := e.a.dev.GrantLogin(ctx, req); err != nil {
			t.Fatal(err)
		}
		toks := e.plugin.LoginGrantTokens(id)
		if len(toks) != 1 {
			t.Fatalf("tokens = %v", toks)
		}
		c, err := logingrant.Verify([]ed25519.PublicKey{pubKey(e.key)}, toks[0], time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if c.Sub != userAlice || c.DeviceID != id || c.Host != grantHost || c.Method != methodPass || c.Scope != logingrant.ScopeDevice ||
			c.SessionID != "s1" || c.ChatTitle != "Pay the bill" || c.Via != grantVia || c.Expires-c.IssuedAt != int64((2*time.Minute).Seconds()) {
			t.Fatalf("claims = %+v", c)
		}
	})
}

// A computer that is not the answering user's, one of another backend, a
// sandbox and a made-up one get nothing signed.
func TestGrantLoginRefusesOtherComputers(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		base := hub.LoginGrantRequest{User: userAlice, BackendID: backendID, DeviceID: id, Host: grantHost, Scope: logingrant.ScopeOnce, Via: grantVia}
		for name, req := range map[string]hub.LoginGrantRequest{
			"bob":           func() hub.LoginGrantRequest { r := base; r.User = userBob; return r }(),
			"sandbox":       func() hub.LoginGrantRequest { r := base; r.DeviceID = sandboxID; return r }(),
			"unknown":       func() hub.LoginGrantRequest { r := base; r.DeviceID = noDevice; return r }(),
			"other backend": func() hub.LoginGrantRequest { r := base; r.BackendID = "elsewhere"; return r }(),
		} {
			if err := e.a.dev.GrantLogin(ctx, req); !errors.Is(err, hub.ErrUnknownDevice) {
				t.Errorf("%s: error = %v", name, err)
			}
		}
		bad := base
		bad.Host = "10.0.0.1"
		if err := e.a.dev.GrantLogin(ctx, bad); !errors.Is(err, hub.ErrBadValue) {
			t.Errorf("bad host: error = %v", err)
		}
		if toks := e.plugin.LoginGrantTokens(id); len(toks) != 0 {
			t.Fatalf("refused requests reached the plugin: %v", toks)
		}
	})
}

// Plugin refusals become hub errors.
func TestGrantLoginPluginErrors(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		req := hub.LoginGrantRequest{User: userAlice, BackendID: backendID, DeviceID: id, Host: grantHost, Scope: logingrant.ScopeOnce, Via: "telegram"}
		e.plugin.RefuseLoginGrants(http.StatusBadRequest, "refused")
		if err := e.a.dev.GrantLogin(ctx, req); !errors.Is(err, hub.ErrLoginGrantRefused) {
			t.Errorf("refused: %v", err)
		}
		e.plugin.RefuseLoginGrants(0, "")
		e.plugin.Disconnect(id)
		if err := e.a.dev.GrantLogin(ctx, req); !errors.Is(err, hub.ErrComputerOffline) {
			t.Errorf("offline: %v", err)
		}
		if _, err := e.a.dev.LoginGrants(ctx, userAlice, id); !errors.Is(err, hub.ErrComputerOffline) {
			t.Errorf("offline list: %v", err)
		}
		e.plugin.UnsupportedLoginGrants()
		if err := e.a.dev.GrantLogin(ctx, req); !errors.Is(err, hub.ErrLoginGrantsUnsupported) {
			t.Errorf("unsupported: %v", err)
		}
	})
}

// The list and the revoke go to the computer's plugin routes, for the owner
// only.
func TestLoginGrantsListAndRevoke(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		e.plugin.SetLoginGrants(id, map[string]any{
			"grants":       []any{map[string]any{"host": grantHost, "method": methodPass, "scope": "device", "granted_at": 100, "session_id": "s1", "chat_title": "Pay", "last_used": 0}},
			"config_hosts": []any{map[string]any{"host": "bank.example.org", "method": ""}},
		})
		l, err := e.a.dev.LoginGrants(ctx, userAlice, id)
		if err != nil || l.DeviceID != id || len(l.Grants) != 1 || l.Grants[0].Host != grantHost || l.Grants[0].Method != methodPass ||
			l.Grants[0].SessionID != "s1" || l.Grants[0].LastUsed != 0 || len(l.ConfigHosts) != 1 || l.ConfigHosts[0].Host != "bank.example.org" {
			t.Fatalf("list = %+v, %v", l, err)
		}
		if _, err := e.a.dev.LoginGrants(ctx, userBob, id); !errors.Is(err, hub.ErrUnknownDevice) {
			t.Fatalf("bob's list: %v", err)
		}
		if _, err := e.a.dev.RevokeLoginGrant(ctx, userBob, id, grantHost); !errors.Is(err, hub.ErrUnknownDevice) {
			t.Fatalf("bob's revoke: %v", err)
		}
		if _, err := e.a.dev.RevokeLoginGrant(ctx, userAlice, id, "not a host"); !errors.Is(err, hub.ErrBadValue) {
			t.Fatalf("bad host revoke: %v", err)
		}
		if got := e.plugin.RevokedLoginGrants(id); len(got) != 0 {
			t.Fatalf("a refused revoke reached the plugin: %v", got)
		}
		if ok, err := e.a.dev.RevokeLoginGrant(ctx, userAlice, id, grantHost); err != nil || !ok {
			t.Fatalf("revoke = %v, %v", ok, err)
		}
		if got := e.plugin.RevokedLoginGrants(id); len(got) != 1 || got[0] != grantHost {
			t.Fatalf("revoked = %v", got)
		}
		if n := e.a.dev.ComputerName(backendID, id); n != deviceName {
			t.Fatalf("name = %q", n)
		}
		if n := e.a.dev.ComputerName(backendID, sandboxID); n != "" {
			t.Fatalf("sandbox name = %q", n)
		}
		if n := e.a.dev.ComputerName("elsewhere", id); n != "" {
			t.Fatalf("other backend name = %q", n)
		}
	})
}
