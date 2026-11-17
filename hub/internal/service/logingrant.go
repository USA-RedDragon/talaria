package service

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/logingrant"
)

const (
	// maxGrantMethods is how many sign-in methods a card lists.
	maxGrantMethods = 12
)

// SetLoginGrants makes g sign the sign-in grants that cards ask for and
// name the computers on them. Without it such a card cannot be answered
// with a grant.
func (s *Service) SetLoginGrants(g hub.LoginGrants) { s.loginGrants.Store(&g) }

func (s *Service) granter() hub.LoginGrants {
	if g := s.loginGrants.Load(); g != nil {
		return *g
	}
	return nil
}

// vetLoginGrant makes the sign-in grant part of a prompt safe to show: only
// an approval carries one, its lists are bounded, and the computer has the
// hub's own name, not the pod's. ls.mu may be held.
func (s *Service) vetLoginGrant(backendID string, p *gateway.Prompt) bool {
	g := p.LoginGrant
	if g == nil {
		return false
	}
	if p.Kind != gateway.PromptApproval {
		p.LoginGrant = nil
		return true
	}
	v := &gateway.LoginGrant{DeviceID: truncateRunes(g.DeviceID, 64), Host: truncateRunes(g.Host, 253), JobID: truncateRunes(g.JobID, 64)}
	if g.SavedLogins != nil && *g.SavedLogins >= -1 {
		n := min(*g.SavedLogins, 1000)
		v.SavedLogins = &n
	} else {
		n := -1
		v.SavedLogins = &n
	}
	for _, m := range g.Methods {
		if m != "" && logingrant.ValidMethod(m) && !slices.Contains(v.Methods, m) && len(v.Methods) < maxGrantMethods {
			v.Methods = append(v.Methods, m)
		}
	}
	v.PostHosts = vetPostHosts(v.Host, g.PostHosts)
	if logingrant.ValidMethod(g.Method) {
		v.Method = g.Method
	}
	if g.Existing == hub.LoginGrantExistingDevice {
		v.Existing = g.Existing
	}
	if gr := s.granter(); gr != nil && v.DeviceID != "" {
		v.DeviceName = gr.ComputerName(backendID, v.DeviceID)
	}
	p.LoginGrant = v
	return true
}

// withLoginGrant puts g in the login_grant field of an approval event's
// payload, or takes the field out when g is nil, and keeps every other
// field as it is.
func withLoginGrant(payload json.RawMessage, g *gateway.LoginGrant) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(payload, &m) != nil {
		return payload
	}
	if g == nil {
		delete(m, "login_grant")
	} else {
		raw, err := json.Marshal(g)
		if err != nil {
			return payload
		}
		m["login_grant"] = raw
	}
	out, err := json.Marshal(m)
	if err != nil {
		return payload
	}
	return out
}

// vetPostHosts keeps the post hosts a card may show: valid names that are
// not the site itself, without duplicates. More than logingrant.MaxPostHosts
// is not a card the hub can sign, so the extra ones are dropped.
func vetPostHosts(host string, in []string) []string {
	var out []string
	for _, h := range in {
		if logingrant.ValidHost(h) && h != host && !slices.Contains(out, h) && len(out) < logingrant.MaxPostHosts {
			out = append(out, h)
		}
	}
	return out
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func loginGrantCard(g *gateway.LoginGrant) *hub.LoginGrantCard {
	if g == nil {
		return nil
	}
	n := -1
	if g.SavedLogins != nil {
		n = *g.SavedLogins
	}
	return &hub.LoginGrantCard{DeviceID: g.DeviceID, DeviceName: g.DeviceName, Host: g.Host, SavedLogins: n, Methods: slices.Clone(g.Methods),
		Method: g.Method, Existing: g.Existing, JobID: g.JobID, PostHosts: slices.Clone(g.PostHosts)}
}

// grantScope is the scope of the grant a sign-in card's choice gives.
func grantScope(choice string) string {
	switch choice {
	case hub.ChoiceOnce:
		return logingrant.ScopeOnce
	case hub.ChoiceDevice:
		return logingrant.ScopeDevice
	}
	return ""
}

// grantVia is where a sign-in card was answered, as a grant records it.
// Only the hub's page and its Telegram bot may answer one.
func grantVia(ctx context.Context) (string, bool) {
	switch hub.AnsweredVia(ctx) {
	case hub.AnsweredInHub:
		return "web", true
	case hub.AnsweredInTelegram:
		return "telegram", true
	}
	return "", false
}

// answerLoginGrant checks an answer to a sign-in grant card and, for a
// choice that allows, signs the grant and has the computer take it. It
// returns before anything reaches Hermes, so a card whose grant failed stays
// open. ls.title is read under ls.mu.
func (s *Service) answerLoginGrant(ctx context.Context, user, backendID, sessionID, title string, p gateway.Prompt, a hub.Answer) error {
	g := p.LoginGrant
	switch a.Choice {
	case hub.ChoiceDeny:
		if a.Method != "" {
			return fmt.Errorf("%w: a denied sign-in has no method", hub.ErrBadValue)
		}
		return nil
	case hub.ChoiceOnce, hub.ChoiceDevice:
	default:
		return fmt.Errorf("%w: this approval does not offer %q", hub.ErrBadValue, a.Choice)
	}
	if !logingrant.ValidMethod(a.Method) || a.Method != "" && !slices.Contains(g.Methods, a.Method) {
		return fmt.Errorf("%w: that is not one of the sign-in methods this card offers", hub.ErrBadValue)
	}
	if !logingrant.ValidHost(g.Host) {
		return fmt.Errorf("%w: that is not a site name Talaria can sign in on", hub.ErrBadValue)
	}
	via, ok := grantVia(ctx)
	if !ok {
		return fmt.Errorf("%w: only the hub's page or its Telegram bot can allow a sign-in", hub.ErrForbidden)
	}
	gr := s.granter()
	if gr == nil {
		return fmt.Errorf("%w: this hub does not keep sign-in grants. Turn computers on in the hub's config", hub.ErrBadValue)
	}
	return gr.GrantLogin(ctx, hub.LoginGrantRequest{User: user, BackendID: backendID, DeviceID: g.DeviceID, Host: g.Host, Method: a.Method,
		Scope: grantScope(a.Choice), SessionID: sessionID, ChatTitle: strings.TrimSpace(title), Via: via, PostHosts: g.PostHosts})
}
