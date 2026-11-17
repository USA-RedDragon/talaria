package web_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/logingrant"
	"github.com/USA-RedDragon/talaria/protocol"
)

// Settings lists what a computer allows to sign in with a saved login and
// takes a grant back; only the computer's owner may, and an offline computer
// answers 409.
func TestLoginGrantsAPI(t *testing.T) {
	t.Parallel()
	e := setupComputers(t)
	c := client(t)
	m := login(t, e.hubEnv, c)
	e.plugin.SetLoginGrants(e.id, map[string]any{
		"grants":       []any{map[string]any{"host": grantSite, keyMethod: methodPass, "scope": "device", "granted_at": 100, keySession: "s1", "chat_title": "Pay", "via": "web", "last_used": 0}},
		"config_hosts": []any{map[string]any{"host": "bank.example.org", keyMethod: ""}},
	})
	base := e.url + "/api/computers/" + e.id + "/login-grants"
	var list struct {
		DeviceID string `json:"device_id"`
		Grants   []struct {
			Host     string `json:"host"`
			Method   string `json:"method"`
			Scope    string `json:"scope"`
			ChatID   string `json:"session_id"`
			Title    string `json:"chat_title"`
			LastUsed int64  `json:"last_used"`
		} `json:"grants"`
		ConfigHosts []struct {
			Host string `json:"host"`
		} `json:"config_hosts"`
	}
	if s := apiJSON(t, c, http.MethodGet, base, "", nil, &list); s != http.StatusOK || list.DeviceID != e.id || len(list.Grants) != 1 ||
		list.Grants[0].Host != grantSite || list.Grants[0].Method != methodPass || list.Grants[0].Title != "Pay" || len(list.ConfigHosts) != 1 ||
		list.ConfigHosts[0].Host != "bank.example.org" {
		t.Fatalf("list = %d %+v", s, list)
	}
	// Revoke needs the CSRF token.
	if code, _, _ := call(t, c, http.MethodDelete, base+"/portal.example.com", "", nil); code != http.StatusForbidden {
		t.Fatalf("revoke without CSRF = %d", code)
	}
	if code, body, text := call(t, c, http.MethodDelete, base+"/portal.example.com", m.CSRF, nil); code != http.StatusOK || body["revoked"] != true {
		t.Fatalf("revoke = %d %s", code, text)
	}
	if got := e.plugin.RevokedLoginGrants(e.id); len(got) != 1 || got[0] != grantSite {
		t.Fatalf("plugin revoked = %v", got)
	}
	if code, _, _ := call(t, c, http.MethodDelete, base+"/portal.example.com?post_host=not+a+host", m.CSRF, nil); code != http.StatusBadRequest {
		t.Fatalf("revoke of a bad post host = %d", code)
	}
	if code, body, text := call(t, c, http.MethodDelete, base+"/portal.example.com?post_host=api.example.com", m.CSRF, nil); code != http.StatusOK || body["revoked"] != true {
		t.Fatalf("post host revoke = %d %s", code, text)
	}
	if got := e.plugin.RevokedLoginGrantPostHosts(e.id); len(got) != 2 || got[0] != "" || got[1] != "api.example.com" {
		t.Fatalf("plugin post hosts = %q", got)
	}
	if code, _, _ := call(t, c, http.MethodDelete, base+"/not-a-host", m.CSRF, nil); code != http.StatusBadRequest {
		t.Fatalf("revoke of a bad host = %d", code)
	}
	// Another user gets "no such computer" and the plugin hears nothing.
	e.is.as("sub-bob", userBob)
	bob := client(t)
	bm := login(t, e.hubEnv, bob)
	if code, _, _ := call(t, bob, http.MethodGet, base, "", nil); code != http.StatusNotFound {
		t.Fatalf("bob lists = %d", code)
	}
	if code, _, _ := call(t, bob, http.MethodDelete, base+"/portal.example.com", bm.CSRF, nil); code != http.StatusNotFound {
		t.Fatalf("bob revokes = %d", code)
	}
	if got := e.plugin.RevokedLoginGrants(e.id); len(got) != 2 {
		t.Fatalf("bob's revoke reached the plugin: %v", got)
	}
	// An offline computer, and one whose talaria is too old.
	e.plugin.Disconnect(e.id)
	var off map[string]any
	if s := apiJSON(t, c, http.MethodGet, base, "", nil, &off); s != http.StatusConflict {
		t.Fatalf("offline list = %d %v", s, off)
	}
}

func TestLoginGrantsAPIOldComputer(t *testing.T) {
	t.Parallel()
	e := setupComputers(t)
	c := client(t)
	login(t, e.hubEnv, c)
	e.plugin.UnsupportedLoginGrants()
	if code, _, _ := call(t, c, http.MethodGet, e.url+"/api/computers/"+e.id+"/login-grants", "", nil); code != http.StatusNotImplemented {
		t.Fatalf("list on an old computer = %d", code)
	}
}

const (
	methodPass  = "Password"
	keyMethod   = "method"
	keyChoice   = "choice"
	keySession  = "session_id"
	grantPrompt = "lg-1"
	grantSite   = "portal.example.com"
)

func askLogin(t *testing.T, e *computersEnv, promptID, device string) {
	t.Helper()
	cmd := "browser_login"
	n := 1
	e.gw.Ask("s1", gateway.Prompt{Kind: gateway.PromptApproval, PromptID: promptID, Command: &cmd, Choices: []string{hub.ChoiceOnce, hub.ChoiceDevice, hub.ChoiceDeny},
		LoginGrant: &gateway.LoginGrant{DeviceID: device, DeviceName: "the pod's name", Host: grantSite, SavedLogins: &n, Methods: []string{methodPass, "Email link"}}})
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, err := e.svc.PendingPrompt(context.Background(), userAlice, "pc", "s1", promptID); err == nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the sign-in card never arrived")
		}
	}
}

// An answer that allows a sign-in signs a grant for the computer and has the
// plugin take it before the approval is answered. A computer that is not
// the user's, or is offline, leaves the card waiting with the reason.
func TestAnswerLoginGrantCard(t *testing.T) {
	t.Parallel()
	e := setupComputers(t)
	e.svc.SetLoginGrants(e.opts.LoginGrants)
	c := client(t)
	m := login(t, e.hubEnv, c)
	answer := e.url + "/api/sessions/pc/s1/prompts/" + grantPrompt + "/answer"
	askLogin(t, e, grantPrompt, "d_not_mine")
	if code, body, _ := call(t, c, http.MethodPost, answer, m.CSRF, map[string]string{keyChoice: hub.ChoiceOnce}); code != http.StatusNotFound || errText(body) == "" {
		t.Fatalf("answer for another computer = %d %v", code, body)
	}
	if _, err := e.svc.PendingPrompt(context.Background(), userAlice, "pc", "s1", grantPrompt); err != nil {
		t.Fatalf("the card was answered: %v", err)
	}
	if toks := e.plugin.LoginGrantTokens("d_not_mine"); len(toks) != 0 {
		t.Fatalf("a grant went out: %v", toks)
	}
	// A card for the user's own computer: offline first.
	answer = e.url + "/api/sessions/pc/s1/prompts/" + grantPrompt + "-own/answer"
	askLogin(t, e, grantPrompt+"-own", e.id)
	e.plugin.Disconnect(e.id)
	if code, body, _ := call(t, c, http.MethodPost, answer, m.CSRF, map[string]string{keyChoice: hub.ChoiceDevice, keyMethod: methodPass}); code != http.StatusConflict {
		t.Fatalf("answer for an offline computer = %d %v", code, body)
	}
	if _, err := e.svc.PendingPrompt(context.Background(), userAlice, "pc", "s1", grantPrompt+"-own"); err != nil {
		t.Fatalf("the card was answered while the computer was offline: %v", err)
	}
	e.plugin.Connect(e.id, pcName, protocol.Hello{Home: homeAlice, Roots: []string{homeAlice}})
	// A method the card does not offer is refused before anything is signed.
	if code, _, _ := call(t, c, http.MethodPost, answer, m.CSRF, map[string]string{keyChoice: hub.ChoiceDevice, keyMethod: "Magic"}); code != http.StatusBadRequest {
		t.Fatalf("answer with a made-up method = %d", code)
	}
	if toks := e.plugin.LoginGrantTokens(e.id); len(toks) != 0 {
		t.Fatalf("a refused answer signed: %v", toks)
	}
	if code, _, text := call(t, c, http.MethodPost, answer, m.CSRF, map[string]string{keyChoice: hub.ChoiceDevice, keyMethod: methodPass}); code != http.StatusAccepted {
		t.Fatalf("answer = %d %s", code, text)
	}
	toks := e.plugin.LoginGrantTokens(e.id)
	if len(toks) != 1 {
		t.Fatalf("tokens = %v", toks)
	}
	parts := strings.Split(toks[0], ".")
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims logingrant.Claims
	if err != nil || json.Unmarshal(raw, &claims) != nil || claims.Sub != userAlice || claims.DeviceID != e.id || claims.Host != grantSite ||
		claims.Method != methodPass || claims.Scope != logingrant.ScopeDevice || claims.SessionID != "s1" || claims.Via != "web" {
		t.Fatalf("claims = %+v, %v", claims, err)
	}
}
