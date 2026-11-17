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
	// PostHosts are the other hosts the login form of Host may send the
	// login to, for as long as the grant lasts.
	PostHosts []string `json:"post_hosts,omitempty"`
	// OncePostHosts are post hosts the user allowed once on a host that
	// has a device grant: for the next sign-in only, until
	// OncePostExpiresAt.
	OncePostHosts     []string `json:"once_post_hosts,omitempty"`
	OncePostExpiresAt int64    `json:"once_post_expires_at,omitempty"`
}

// AllPostHosts returns the grant's post hosts and its once post hosts.
func (g Grant) AllPostHosts() []string {
	return union(g.PostHosts, g.OncePostHosts)
}

// union returns a followed by the hosts of b that a lacks, nil when both
// are empty.
func union(a, b []string) []string {
	var out []string
	for _, h := range slices.Concat(a, b) {
		if !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out
}

// without returns a without the hosts in drop, nil when nothing is left.
func without(a []string, drop ...string) []string {
	var out []string
	for _, h := range a {
		if !slices.Contains(drop, h) {
			out = append(out, h)
		}
	}
	return out
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
	grants := slices.Clone(s.Grants)
	for i := range grants {
		grants[i].PostHosts = slices.Clone(grants[i].PostHosts)
		grants[i].OncePostHosts = slices.Clone(grants[i].OncePostHosts)
	}
	return state{Grants: grants, Nonces: cloneMap(s.Nonces)}
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
	for i := range st.Grants {
		if g := &st.Grants[i]; g.OncePostExpiresAt != 0 && g.OncePostExpiresAt <= now {
			g.OncePostHosts, g.OncePostExpiresAt = nil, 0
		}
	}
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
// its nonce. A device grant is never replaced by a once grant; the once
// grant's post hosts then hold for the device grant's next sign-in only.
// Post hosts add up: a new grant keeps those the user allowed before.
func (s *Store) Add(c *logingrant.Claims) (Grant, error) {
	now := s.now()
	g := Grant{Host: c.Host, Method: c.Method, Scope: c.Scope, GrantedAt: now.Unix(), SessionID: c.SessionID,
		ChatTitle: c.ChatTitle, Via: c.Via, User: c.Sub, PostHosts: union(c.PostHosts, nil)}
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
			switch {
			case old.Scope == logingrant.ScopeDevice && g.Scope == logingrant.ScopeOnce:
				if extra := without(g.PostHosts, old.PostHosts...); len(extra) > 0 {
					old.OncePostHosts = union(old.OncePostHosts, extra)
					old.OncePostExpiresAt = g.ExpiresAt
					st.Grants[i] = old
				}
				out = old
				return nil
			case old.Scope == logingrant.ScopeDevice:
				g.LastUsed = old.LastUsed
				if g.Method == "" && len(c.PostHosts) > 0 {
					// A card that allowed a post host leaves the method as it was.
					g.Method = old.Method
				}
				g.PostHosts = union(old.PostHosts, g.PostHosts)
				if once := without(old.OncePostHosts, g.PostHosts...); len(once) > 0 {
					g.OncePostHosts, g.OncePostExpiresAt = once, old.OncePostExpiresAt
				}
			case g.Scope == logingrant.ScopeOnce:
				// A once grant on a host with an unused once grant.
				g.PostHosts = union(old.PostHosts, g.PostHosts)
			default:
				// A device grant on a host with an unused once grant: the once
				// post hosts still hold for the next sign-in.
				if once := without(old.PostHosts, g.PostHosts...); len(once) > 0 {
					g.OncePostHosts, g.OncePostExpiresAt = once, old.ExpiresAt
				}
			}
			out = g
			st.Grants[i] = g
			return nil
		}
		st.Grants = append(st.Grants, g)
		return nil
	})
	return out, err
}

// Revoke removes the grant for host and reports whether there was one. With
// postHost set it removes only that post host from the grant.
func (s *Store) Revoke(host, postHost string) (bool, error) {
	found := false
	err := s.mutate(func(st *state) error {
		if postHost != "" {
			for i := range st.Grants {
				g := &st.Grants[i]
				if g.Host != host || !slices.Contains(g.AllPostHosts(), postHost) {
					continue
				}
				g.PostHosts, g.OncePostHosts = without(g.PostHosts, postHost), without(g.OncePostHosts, postHost)
				if g.OncePostHosts == nil {
					g.OncePostExpiresAt = 0
				}
				found = true
			}
			if !found {
				return errNoChange
			}
			return nil
		}
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
// once grant and once post hosts.
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
				st.Grants[i].OncePostHosts, st.Grants[i].OncePostExpiresAt = nil, 0
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

// NextExpiry returns the earliest expiry of a once grant or of once post
// hosts, if any.
func (s *Store) NextExpiry() (time.Time, bool) {
	var best int64
	for _, g := range s.Grants() {
		for _, at := range []int64{g.ExpiresAt, g.OncePostExpiresAt} {
			if at != 0 && (best == 0 || at < best) {
				best = at
			}
		}
	}
	return time.Unix(best, 0), best != 0
}
