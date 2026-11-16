// Package grants is the device's store of sign-in grants and the gate in
// front of the browser extension that enforces them (docs/browser.md
// section 7.4). A grant is the hub's signed statement that the user allowed
// browser_login on one host of this computer (package logingrant). The store
// keeps the verified grants in login-grants.json (mode 0600); the gate merges
// them with browser.autologin-hosts and refuses a login on any other host.
package grants

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/logingrant"
)

// FileName is the store's file name in the state directory.
const FileName = "login-grants.json"

// Grant is one host the user allowed.
type Grant struct {
	Host      string `json:"host"`
	Method    string `json:"method"`
	Scope     string `json:"scope"`
	GrantedAt int64  `json:"granted_at"`
	SessionID string `json:"session_id"`
	ChatTitle string `json:"chat_title"`
	Via       string `json:"via"`
	User      string `json:"user"`
	LastUsed  int64  `json:"last_used"`
	// ExpiresAt is set for a once grant only.
	ExpiresAt int64 `json:"expires_at,omitempty"`
}

// state is the file's content.
type state struct {
	Grants []Grant `json:"grants"`
	// Nonces maps the nonce of every grant this device took to the time
	// (unix seconds) after which the grant would no longer verify, so a
	// replayed grant is refused for as long as it could still verify.
	Nonces map[string]int64 `json:"nonces"`
}

func (s state) clone() state {
	return state{Grants: slices.Clone(s.Grants), Nonces: cloneMap(s.Nonces)}
}

func cloneMap(m map[string]int64) map[string]int64 {
	out := make(map[string]int64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ErrNonceUsed is returned when a grant's nonce was seen before.
var ErrNonceUsed = errors.New("sign-in grant was already used")

// Store keeps grants on disk.
type Store struct {
	path string
	now  func() time.Time

	mu sync.Mutex
	st state
}

// OpenStore reads the store at path. A missing file is an empty store; a
// file that does not parse is an error rather than silently dropping grants.
func OpenStore(path string, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	s := &Store{path: path, now: now, st: state{Nonces: map[string]int64{}}}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(data, &s.st); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if s.st.Nonces == nil {
		s.st.Nonces = map[string]int64{}
	}
	s.pruneLocked(&s.st)
	return s, nil
}

// pruneLocked drops expired once grants and nonces that can no longer
// verify from st.
func (s *Store) pruneLocked(st *state) {
	now := s.now().Unix()
	st.Grants = slices.DeleteFunc(st.Grants, func(g Grant) bool {
		return g.Scope == logingrant.ScopeOnce && g.ExpiresAt <= now
	})
	for n, exp := range st.Nonces {
		if exp < now {
			delete(st.Nonces, n)
		}
	}
}

// mutate applies fn to a copy of the state, writes it and only then makes it
// current, so a failed write changes nothing.
func (s *Store) mutate(fn func(*state) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.st.clone()
	s.pruneLocked(&next)
	if err := fn(&next); err != nil {
		return err
	}
	if err := s.writeLocked(next); err != nil {
		return err
	}
	s.st = next
	return nil
}

func (s *Store) writeLocked(st state) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, FileName+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmp)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	ok = true
	return nil
}

// Add stores the grant c describes, which the caller verified, and remembers
// its nonce. A device grant is never replaced by a once grant.
func (s *Store) Add(c *logingrant.Claims) (Grant, error) {
	now := s.now()
	g := Grant{Host: c.Host, Method: c.Method, Scope: c.Scope, GrantedAt: now.Unix(), SessionID: c.SessionID,
		ChatTitle: c.ChatTitle, Via: c.Via, User: c.Sub}
	if c.Scope == logingrant.ScopeOnce {
		g.ExpiresAt = now.Add(logingrant.OnceLifetime).Unix()
	}
	var out Grant
	err := s.mutate(func(st *state) error {
		if _, used := st.Nonces[c.Nonce]; used {
			return ErrNonceUsed
		}
		st.Nonces[c.Nonce] = c.Expires + int64(logingrant.ClockSkew/time.Second) + 1
		out = g
		for i, old := range st.Grants {
			if old.Host != g.Host {
				continue
			}
			if old.Scope == logingrant.ScopeDevice && g.Scope == logingrant.ScopeOnce {
				out = old
				return nil
			}
			if old.Scope == logingrant.ScopeDevice {
				g.LastUsed = old.LastUsed
				out = g
			}
			st.Grants[i] = g
			return nil
		}
		st.Grants = append(st.Grants, g)
		return nil
	})
	return out, err
}

// Revoke removes the grant for host and reports whether there was one.
func (s *Store) Revoke(host string) (bool, error) {
	found := false
	err := s.mutate(func(st *state) error {
		before := len(st.Grants)
		st.Grants = slices.DeleteFunc(st.Grants, func(g Grant) bool { return g.Host == host })
		found = len(st.Grants) != before
		if !found {
			return errNoChange
		}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return false, nil
	}
	return found, err
}

var errNoChange = errors.New("no change")

// Used records a submitted sign-in on host: it sets last_used and removes a
// once grant.
func (s *Store) Used(host string) error {
	err := s.mutate(func(st *state) error {
		changed := false
		now := s.now().Unix()
		st.Grants = slices.DeleteFunc(st.Grants, func(g Grant) bool {
			if g.Host == host && g.Scope == logingrant.ScopeOnce {
				changed = true
				return true
			}
			return false
		})
		for i := range st.Grants {
			if st.Grants[i].Host == host {
				st.Grants[i].LastUsed, changed = now, true
			}
		}
		if !changed {
			return errNoChange
		}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return nil
	}
	return err
}

// Grants returns the unexpired grants, sorted by host.
func (s *Store) Grants() []Grant {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.st.clone()
	s.pruneLocked(&next)
	out := next.Grants
	slices.SortFunc(out, func(a, b Grant) int { return strings.Compare(a.Host, b.Host) })
	if out == nil {
		out = []Grant{}
	}
	return out
}

// Get returns the unexpired grant for host.
func (s *Store) Get(host string) (Grant, bool) {
	for _, g := range s.Grants() {
		if g.Host == host {
			return g, true
		}
	}
	return Grant{}, false
}

// NextExpiry returns the earliest expiry of a once grant, if any.
func (s *Store) NextExpiry() (time.Time, bool) {
	var best int64
	for _, g := range s.Grants() {
		if g.ExpiresAt != 0 && (best == 0 || g.ExpiresAt < best) {
			best = g.ExpiresAt
		}
	}
	return time.Unix(best, 0), best != 0
}
