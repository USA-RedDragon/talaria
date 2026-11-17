// Package logingrant signs and verifies sign-in grants: the hub's signed
// statement that the user allowed browser_login to use Firefox's saved login
// on one host of one computer (docs/browser.md section 7.4).
//
// Only the hub signs a grant, with the same Ed25519 key that signs its device
// assertions, and only after the user answered a sign-in card on the hub. The
// device stores a grant only when its signature verifies with the hub's
// public key, so neither the agent nor the device plugin can add a host.
package logingrant

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Prefix starts every encoded grant and names its format version. It
// differs from the device assertion's, so one can never pass for the other.
const Prefix = "lg1."

// Type is the value of the typ field.
const Type = "talaria-login-grant"

// Scopes of a grant.
const (
	// ScopeOnce allows one sign-in, within OnceLifetime.
	ScopeOnce = "once"
	// ScopeDevice allows sign-ins on the host on that computer until the
	// user revokes the grant.
	ScopeDevice = "device"
)

// MaxDelivery is the longest allowed exp - iat: the device must receive the
// grant within this time after the hub signed it.
const MaxDelivery = 5 * time.Minute

// OnceLifetime is how long a once grant stays usable after it arrived.
const OnceLifetime = 10 * time.Minute

// ClockSkew is the clock difference a verifier tolerates on iat and exp.
const ClockSkew = 30 * time.Second

// MaxEncodedLen is the longest encoded grant a verifier reads.
const MaxEncodedLen = 4096

// MaxMethodLen is the longest sign-in method label.
const MaxMethodLen = 80

// MaxTitleLen is the longest chat title a grant carries.
const MaxTitleLen = 120

// MaxPostHosts is the most extra hosts one grant lets the login form send
// to.
const MaxPostHosts = 4

// RefusedMethodPattern matches sign-in method labels that browser_login
// never clicks: passkeys, security keys and anything that waits for the
// user on another device (an approval prompt, a push notification, a code
// sent by text message), whatever the identity provider calls them.
const RefusedMethodPattern = `passkey|pass key|security key|verify|verification|push|approve|approval|authenticator|biometric|fingerprint|face id|touch id|windows hello|sms|text message|one-time|otp|phone|notification|another device|other device`

var refusedMethod = regexp.MustCompile(`(?i)` + RefusedMethodPattern)

// RefusedMethod reports whether label names a method browser_login never
// chooses.
func RefusedMethod(label string) bool { return refusedMethod.MatchString(label) }

// Errors returned by Verify.
var (
	ErrMalformed = errors.New("malformed sign-in grant")
	ErrSignature = errors.New("sign-in grant signature does not verify")
	ErrClaims    = errors.New("sign-in grant claims refused")
	ErrExpired   = errors.New("sign-in grant expired or not yet valid")
	ErrNoKeys    = errors.New("no hub public key")
)

var (
	deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	noncePattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{22,128}$`)
	hostLabel       = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
)

// Claims is the signed payload.
type Claims struct {
	Typ      string `json:"typ"`
	Sub      string `json:"sub"`
	DeviceID string `json:"device_id"`
	Host     string `json:"host"`
	// Method is the visible label of the sign-in method button
	// browser_login clicks on a method picker, "" for none.
	Method string `json:"method,omitempty"`
	Scope  string `json:"scope"`
	// PostHosts are other https hosts the login form of Host may send the
	// login to (a sign-in API on its own host name), which the user allowed
	// on the same card. The extension allows them for a login on Host only.
	PostHosts []string `json:"post_hosts,omitempty"`
	// SessionID and ChatTitle name the chat whose card the user answered.
	SessionID string `json:"session_id,omitempty"`
	ChatTitle string `json:"chat_title,omitempty"`
	// Via is where the user answered: web or telegram.
	Via      string `json:"via,omitempty"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
	Nonce    string `json:"nonce"`
}

// ValidHost reports whether h is a lower-case DNS host name with at least
// two labels, as browser_login takes: no port, no IP address literal, no
// trailing dot.
func ValidHost(h string) bool {
	if len(h) > 253 || !strings.Contains(h, ".") {
		return false
	}
	labels := strings.Split(h, ".")
	for _, l := range labels {
		if !hostLabel.MatchString(l) {
			return false
		}
	}
	last := labels[len(labels)-1]
	return strings.Trim(last, "0123456789") != ""
}

// ValidPostHosts reports whether hosts may be the post hosts of a grant for
// host: at most MaxPostHosts valid host names, none of them host itself and
// none twice.
func ValidPostHosts(host string, hosts []string) bool {
	if len(hosts) > MaxPostHosts {
		return false
	}
	for i, h := range hosts {
		if !ValidHost(h) || h == host || slices.Contains(hosts[:i], h) {
			return false
		}
	}
	return true
}

// ValidMethod reports whether label may be a grant's method: empty, or
// short visible text that RefusedMethod does not match.
func ValidMethod(label string) bool {
	if label == "" {
		return true
	}
	return len(label) <= MaxMethodLen && strings.TrimSpace(label) == label && !strings.ContainsAny(label, "\r\n\t") &&
		!RefusedMethod(label)
}

// NewNonce returns 16 random bytes, base64url encoded without padding.
func NewNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Sign encodes and signs c. It fills Typ, and Nonce when empty, and checks
// the claims as Verify would.
func Sign(key ed25519.PrivateKey, c Claims) (string, error) {
	c.Typ = Type
	if c.Nonce == "" {
		c.Nonce = NewNonce()
	}
	if err := checkClaims(&c); err != nil {
		return "", err
	}
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signed := Prefix + base64.RawURLEncoding.EncodeToString(payload)
	return signed + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(signed))), nil
}

// Verify checks encoded with keys at now and returns its claims. It does not
// check the device id or remember nonces; the caller does.
func Verify(keys []ed25519.PublicKey, encoded string, now time.Time) (*Claims, error) {
	if len(keys) == 0 {
		return nil, ErrNoKeys
	}
	if len(encoded) > MaxEncodedLen || !strings.HasPrefix(encoded, Prefix) {
		return nil, ErrMalformed
	}
	signed, sigText, ok := strings.Cut(strings.TrimPrefix(encoded, Prefix), ".")
	if !ok || strings.Contains(sigText, ".") {
		return nil, ErrMalformed
	}
	payload, err := base64.RawURLEncoding.DecodeString(signed)
	if err != nil {
		return nil, ErrMalformed
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigText)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, ErrMalformed
	}
	msg := []byte(Prefix + signed)
	good := false
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, msg, sig) {
			good = true
			break
		}
	}
	if !good {
		return nil, ErrSignature
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, ErrMalformed
	}
	if err := checkClaims(&c); err != nil {
		return nil, err
	}
	iat, exp := time.Unix(c.IssuedAt, 0), time.Unix(c.Expires, 0)
	if exp.Before(iat) || exp.Sub(iat) > MaxDelivery || iat.After(now.Add(ClockSkew)) || now.After(exp.Add(ClockSkew)) {
		return nil, ErrExpired
	}
	return &c, nil
}

func checkClaims(c *Claims) error {
	switch {
	case c.Typ != Type:
		return fmt.Errorf("%w: typ", ErrClaims)
	case c.Sub == "" || len(c.Sub) > 256:
		return fmt.Errorf("%w: sub", ErrClaims)
	case !deviceIDPattern.MatchString(c.DeviceID):
		return fmt.Errorf("%w: device_id", ErrClaims)
	case !ValidHost(c.Host):
		return fmt.Errorf("%w: host", ErrClaims)
	case !ValidMethod(c.Method):
		return fmt.Errorf("%w: method", ErrClaims)
	case c.Scope != ScopeOnce && c.Scope != ScopeDevice:
		return fmt.Errorf("%w: scope", ErrClaims)
	case !ValidPostHosts(c.Host, c.PostHosts):
		return fmt.Errorf("%w: post_hosts", ErrClaims)
	case len(c.SessionID) > 256 || len(c.ChatTitle) > MaxTitleLen*4 || len(c.Via) > 32:
		return fmt.Errorf("%w: chat", ErrClaims)
	case !noncePattern.MatchString(c.Nonce):
		return fmt.Errorf("%w: nonce", ErrClaims)
	}
	return nil
}
