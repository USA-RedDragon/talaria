package device

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
	"unicode/utf8"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/logingrant"
)

// grantLifetime is how long the device has to take a signed grant.
const grantLifetime = 2 * time.Minute

// LoginGrants lists the sign-in grants of a computer.
func (p *Plugin) LoginGrants(ctx context.Context, deviceID string) (hub.LoginGrantList, error) {
	var out hub.LoginGrantList
	return out, p.call(ctx, http.MethodGet, "/devices/"+url.PathEscape(deviceID)+"/login-grants", nil, &out)
}

// AddLoginGrant sends a signed grant to a computer.
func (p *Plugin) AddLoginGrant(ctx context.Context, deviceID, token string) error {
	return p.call(ctx, http.MethodPost, "/devices/"+url.PathEscape(deviceID)+"/login-grants", map[string]string{"token": token}, nil)
}

// RevokeLoginGrant takes back the grant of a host on a computer.
func (p *Plugin) RevokeLoginGrant(ctx context.Context, deviceID, host string) (bool, error) {
	var out struct {
		Revoked bool `json:"revoked"`
	}
	err := p.call(ctx, http.MethodDelete, "/devices/"+url.PathEscape(deviceID)+"/login-grants/"+url.PathEscape(host), nil, &out)
	return out.Revoked, err
}

// loginGrantError turns a plugin refusal into a hub error.
func loginGrantError(err error) error {
	var pe *PluginError
	if !errors.As(err, &pe) {
		return err
	}
	switch {
	case pe.Status == http.StatusConflict, pe.Code == codeOffline, pe.Code == codeUnknownDevice:
		return hub.ErrComputerOffline
	case pe.Status == http.StatusNotImplemented, pe.Code == "unsupported":
		return hub.ErrLoginGrantsUnsupported
	case pe.Status == http.StatusBadRequest && pe.Code == "refused":
		msg := "the computer did not accept the grant"
		if pe.Message != "" {
			msg = pe.Message
		}
		return fmt.Errorf("%w: %s", hub.ErrLoginGrantRefused, msg)
	}
	return err
}

var _ hub.LoginGrants = (*Server)(nil)

// GrantLogin signs a sign-in grant for the computer and sends it to the
// plugin. See hub.LoginGrants.
func (s *Server) GrantLogin(ctx context.Context, req hub.LoginGrantRequest) error {
	d, b, err := s.computer(ctx, req.User, req.DeviceID)
	if err != nil {
		return err
	}
	if d.BackendID != req.BackendID {
		return hub.ErrUnknownDevice
	}
	now := s.opts.Now()
	title := req.ChatTitle
	if utf8.RuneCountInString(title) > logingrant.MaxTitleLen {
		title = string([]rune(title)[:logingrant.MaxTitleLen])
	}
	token, err := logingrant.Sign(s.opts.Key, logingrant.Claims{Sub: req.User, DeviceID: d.ID, Host: req.Host, Method: req.Method,
		Scope: req.Scope, SessionID: req.SessionID, ChatTitle: title, Via: req.Via, IssuedAt: now.Unix(), Expires: now.Add(grantLifetime).Unix()})
	if err != nil {
		return fmt.Errorf("%w: %w", hub.ErrBadValue, err)
	}
	cctx, cancel := context.WithTimeout(ctx, pluginTimeout)
	defer cancel()
	return loginGrantError(b.plugin.AddLoginGrant(cctx, d.ID, token))
}

// LoginGrants lists what one of user's computers allows. See hub.LoginGrants.
func (s *Server) LoginGrants(ctx context.Context, user, deviceID string) (hub.LoginGrantList, error) {
	_, b, err := s.computer(ctx, user, deviceID)
	if err != nil {
		return hub.LoginGrantList{}, err
	}
	cctx, cancel := context.WithTimeout(ctx, pluginTimeout)
	defer cancel()
	out, err := b.plugin.LoginGrants(cctx, deviceID)
	if err != nil {
		return hub.LoginGrantList{}, loginGrantError(err)
	}
	if out.Grants == nil {
		out.Grants = []hub.LoginGrant{}
	}
	if out.ConfigHosts == nil {
		out.ConfigHosts = []hub.LoginGrantHost{}
	}
	out.DeviceID = deviceID
	return out, nil
}

// RevokeLoginGrant takes back a grant of one of user's computers. See
// hub.LoginGrants.
func (s *Server) RevokeLoginGrant(ctx context.Context, user, deviceID, host string) (bool, error) {
	_, b, err := s.computer(ctx, user, deviceID)
	if err != nil {
		return false, err
	}
	if !logingrant.ValidHost(host) {
		return false, fmt.Errorf("%w: that is not a site name", hub.ErrBadValue)
	}
	cctx, cancel := context.WithTimeout(ctx, pluginTimeout)
	defer cancel()
	ok, err := b.plugin.RevokeLoginGrant(cctx, deviceID, host)
	return ok, loginGrantError(err)
}

// ComputerName is the hub's name for a paired computer. See hub.LoginGrants.
func (s *Server) ComputerName(backendID, deviceID string) string {
	ctx, cancel := context.WithTimeout(context.Background(), pluginTimeout)
	defer cancel()
	d, ok, err := s.store.Device(ctx, deviceID)
	if err != nil || !ok || !d.Paired || d.Service || d.BackendID != backendID {
		return ""
	}
	return d.Name
}

// handleHubKeys answers with the public keys the hub signs with, so a
// device can check what the hub signed for it.
func (s *Server) handleHubKeys(w http.ResponseWriter, _ *http.Request) {
	pub, _ := s.opts.Key.Public().(ed25519.PublicKey)
	writeJSON(w, http.StatusOK, map[string][]string{"keys": {base64.StdEncoding.EncodeToString(pub)}})
}
