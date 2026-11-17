package logingrant_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/logingrant"
)

const testMethod = "Password"

func claims(now time.Time) logingrant.Claims {
	return logingrant.Claims{Sub: "jacob", DeviceID: "d_abc", Host: "login.example.com", Method: testMethod,
		Scope: logingrant.ScopeDevice, SessionID: "s1", ChatTitle: "chat", Via: "web",
		IssuedAt: now.Unix(), Expires: now.Add(2 * time.Minute).Unix()}
}

func TestSignVerify(t *testing.T) {
	t.Parallel()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	tok, err := logingrant.Sign(key, claims(now))
	if err != nil {
		t.Fatal(err)
	}
	c, err := logingrant.Verify([]ed25519.PublicKey{other, pub}, tok, now)
	if err != nil || c.Host != "login.example.com" || c.Method != testMethod || c.Scope != logingrant.ScopeDevice {
		t.Fatalf("verify: %+v %v", c, err)
	}
	if _, err := logingrant.Verify([]ed25519.PublicKey{other}, tok, now); !errors.Is(err, logingrant.ErrSignature) {
		t.Fatalf("other key: %v", err)
	}
	if _, err := logingrant.Verify(nil, tok, now); !errors.Is(err, logingrant.ErrNoKeys) {
		t.Fatalf("no keys: %v", err)
	}
	if _, err := logingrant.Verify([]ed25519.PublicKey{pub}, tok, now.Add(10*time.Minute)); !errors.Is(err, logingrant.ErrExpired) {
		t.Fatalf("late: %v", err)
	}
	// A changed payload no longer verifies.
	parts := strings.Split(tok, ".")
	forged := parts[0] + "." + parts[1][:len(parts[1])-2] + "AA." + parts[2]
	if _, err := logingrant.Verify([]ed25519.PublicKey{pub}, forged, now); err == nil {
		t.Fatal("forged grant verified")
	}
	// A device assertion prefix is not a grant.
	if _, err := logingrant.Verify([]ed25519.PublicKey{pub}, "v1."+strings.TrimPrefix(tok, logingrant.Prefix), now); !errors.Is(err, logingrant.ErrMalformed) {
		t.Fatalf("assertion prefix: %v", err)
	}
}

func TestSignVerifyPostHosts(t *testing.T) {
	t.Parallel()
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	c := claims(now)
	c.PostHosts = []string{"login-api.example.com"}
	tok, err := logingrant.Sign(key, c)
	if err != nil {
		t.Fatal(err)
	}
	got, err := logingrant.Verify([]ed25519.PublicKey{pub}, tok, now)
	if err != nil || len(got.PostHosts) != 1 || got.PostHosts[0] != "login-api.example.com" {
		t.Fatalf("verify: %+v %v", got, err)
	}
}

func TestSignRefusesBadClaims(t *testing.T) {
	t.Parallel()
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Now()
	for name, mut := range map[string]func(*logingrant.Claims){
		"ip host":        func(c *logingrant.Claims) { c.Host = "127.0.0.1" },
		"upper host":     func(c *logingrant.Claims) { c.Host = "Login.example.com" },
		"port":           func(c *logingrant.Claims) { c.Host = "login.example.com:443" },
		"one label":      func(c *logingrant.Claims) { c.Host = "localhost" },
		"passkey method": func(c *logingrant.Claims) { c.Method = "Sign in with a passkey" },
		"push method":    func(c *logingrant.Claims) { c.Method = "Approve on phone" },
		"scope":          func(c *logingrant.Claims) { c.Scope = "always" },
		"device id":      func(c *logingrant.Claims) { c.DeviceID = "d abc" },
		"no user":        func(c *logingrant.Claims) { c.Sub = "" },
		"post host ip":   func(c *logingrant.Claims) { c.PostHosts = []string{"10.0.0.1"} },
		"post host self": func(c *logingrant.Claims) { c.PostHosts = []string{c.Host} },
		"post host twice": func(c *logingrant.Claims) {
			c.PostHosts = []string{"api.example.com", "api.example.com"}
		},
		"post host port": func(c *logingrant.Claims) { c.PostHosts = []string{"api.example.com:8443"} },
		"post hosts many": func(c *logingrant.Claims) {
			c.PostHosts = []string{"a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com"}
		},
	} {
		c := claims(now)
		mut(&c)
		if _, err := logingrant.Sign(key, c); !errors.Is(err, logingrant.ErrClaims) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestRefusedMethod(t *testing.T) {
	t.Parallel()
	for _, l := range []string{"Passkey", "Use a security key", "Approve on phone", "Send a push notification",
		"Verify with the app", "Text message", "Use another device", "Windows Hello", "One-time code", "Authenticator app"} {
		if !logingrant.RefusedMethod(l) || logingrant.ValidMethod(l) {
			t.Errorf("%q not refused", l)
		}
	}
	for _, l := range []string{testMethod, "Sign in with password", "Email and password", ""} {
		if !logingrant.ValidMethod(l) {
			t.Errorf("%q refused", l)
		}
	}
}
