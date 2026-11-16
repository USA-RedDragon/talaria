package devicetest

import (
	"encoding/json"
	"net/http"
	"slices"
)

// loginGrants is the fake plugin's sign-in grant state.
type loginGrants struct {
	// tokens are the grants the POST route took, by device id.
	tokens map[string][]string
	// lists are the answers of the GET route, by device id.
	lists map[string]map[string]any
	// refuse is the code and status the POST route answers with.
	refuseCode   string
	refuseStatus int
	// unsupported makes every route answer 501.
	unsupported bool
	// revoked are the hosts the DELETE route took, by device id.
	revoked map[string][]string
}

func (p *Plugin) mountLoginGrants(base string) {
	p.lg = loginGrants{tokens: map[string][]string{}, lists: map[string]map[string]any{}, revoked: map[string][]string{}}
	p.gw.Handle("GET "+base+"/devices/{device}/login-grants", http.HandlerFunc(p.listLoginGrants), true)
	p.gw.Handle("POST "+base+"/devices/{device}/login-grants", http.HandlerFunc(p.addLoginGrant), true)
	p.gw.Handle("DELETE "+base+"/devices/{device}/login-grants/{host}", http.HandlerFunc(p.revokeLoginGrant), true)
}

// LoginGrantTokens returns the grants the plugin took for a device, in order.
func (p *Plugin) LoginGrantTokens(deviceID string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.lg.tokens[deviceID])
}

// SetLoginGrants sets the list of sign-in grants the plugin answers for a
// device: grants and config_hosts as the plugin sends them.
func (p *Plugin) SetLoginGrants(deviceID string, list map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lg.lists[deviceID] = list
}

// RefuseLoginGrants makes the plugin refuse grants with status and code.
func (p *Plugin) RefuseLoginGrants(status int, code string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lg.refuseStatus, p.lg.refuseCode = status, code
}

// UnsupportedLoginGrants makes the login grant routes answer 501, as a
// plugin whose device is too old does.
func (p *Plugin) UnsupportedLoginGrants() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lg.unsupported = true
}

// RevokedLoginGrants returns the hosts revoked on a device.
func (p *Plugin) RevokedLoginGrants(deviceID string) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.lg.revoked[deviceID])
}

// loginGrantGate answers the requests every login grant route refuses, and
// reports whether it did.
func (p *Plugin) loginGrantGate(w http.ResponseWriter, deviceID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	switch {
	case p.lg.unsupported:
		pluginError(w, http.StatusNotImplemented, "unsupported")
	case p.conns[deviceID] == nil:
		pluginError(w, http.StatusConflict, "not_connected")
	default:
		return false
	}
	return true
}

func (p *Plugin) listLoginGrants(w http.ResponseWriter, r *http.Request) {
	p.record(r, nil)
	id := r.PathValue("device")
	if p.loginGrantGate(w, id) {
		return
	}
	p.mu.Lock()
	list, ok := p.lg.lists[id]
	p.mu.Unlock()
	if !ok {
		list = map[string]any{"grants": []any{}, "config_hosts": []any{}}
	}
	out := map[string]any{"device_id": id}
	for k, v := range list {
		out[k] = v
	}
	answer(w, out)
}

func (p *Plugin) addLoginGrant(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		pluginError(w, http.StatusBadRequest, "bad_request")
		return
	}
	p.record(r, body)
	id := r.PathValue("device")
	if p.loginGrantGate(w, id) {
		return
	}
	p.mu.Lock()
	if p.lg.refuseStatus != 0 {
		status, code := p.lg.refuseStatus, p.lg.refuseCode
		p.mu.Unlock()
		pluginError(w, status, code)
		return
	}
	tok, _ := body["token"].(string)
	p.lg.tokens[id] = append(p.lg.tokens[id], tok)
	p.mu.Unlock()
	answer(w, map[string]any{"grant": map[string]any{}})
}

func (p *Plugin) revokeLoginGrant(w http.ResponseWriter, r *http.Request) {
	p.record(r, nil)
	id := r.PathValue("device")
	if p.loginGrantGate(w, id) {
		return
	}
	p.mu.Lock()
	p.lg.revoked[id] = append(p.lg.revoked[id], r.PathValue("host"))
	p.mu.Unlock()
	answer(w, map[string]any{"revoked": true})
}
