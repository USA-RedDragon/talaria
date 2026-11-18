package gatewaytest

import (
	"context"
	"maps"
	"net"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"slices"
	"sync/atomic"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/coder/websocket"
)

// Front is the Kubernetes Service in front of a gateway and the one that
// takes over from it: it forwards every request and socket to the gateway
// it routes to now (Route), keeping the Host the client dialed.
type Front struct {
	Server *httptest.Server
	to     atomic.Pointer[url.URL]
}

// NewFront starts a Front that routes to g.
func NewFront(g *Gateway) *Front {
	f := &Front{}
	f.Route(g)
	rp := &httputil.ReverseProxy{Rewrite: func(pr *httputil.ProxyRequest) {
		pr.SetURL(f.to.Load())
		pr.Out.Host = pr.In.Host
	}}
	f.Server = httptest.NewServer(rp)
	return f
}

// Route sends the next requests and sockets to g.
func (f *Front) Route(g *Gateway) {
	u, err := url.Parse(g.URL())
	if err != nil {
		panic(err)
	}
	f.to.Store(u)
}

// URL is the Front's base URL.
func (f *Front) URL() string { return f.Server.URL }

// Close stops the Front.
func (f *Front) Close() { f.Server.Close() }

// HandOver hands g's sessions to next, as a Hermes restart that carries
// its running turns does (Talaria Hermes patches 0136 and 0155), and tells
// g's sockets once next is ready: HandOff, then Notify.
func (g *Gateway) HandOver(next *Gateway, hint bool) {
	g.HandOff(next)
	g.Notify(next, hint)
}

// HandOff gives next each of g's sessions, transcript and state, under a
// new replay epoch. g's open sockets stay open; a request on one closes it
// with 1012.
func (g *Gateway) HandOff(next *Gateway) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.handedOver = true
	for _, s := range g.sessions {
		copied := &Session{ID: s.ID, Title: s.Title, Live: s.Live, Running: s.Running, StartedAt: s.StartedAt,
			Messages: slices.Clone(s.Messages), Generation: s.Generation, Revision: s.Revision, Model: s.Model,
			Provider: s.Provider, CWD: s.CWD, Pending: slices.Clone(s.Pending), Source: s.Source,
			Prompts: slices.Collect(maps.Values(s.prompts))}
		next.AddSession(copied)
	}
}

// Notify tells g's sockets that next is ready: with hint, a socket whose
// dial asked for it gets gateway.successor_ready with next's listener
// address; every other socket is closed with 1012.
func (g *Gateway) Notify(next *Gateway, hint bool) {
	g.mu.Lock()
	conns := make([]*conn, 0, len(g.conns))
	for c := range g.conns {
		conns = append(conns, c)
	}
	g.mu.Unlock()
	addr, _ := next.Server.Listener.Addr().(*net.TCPAddr)
	payload := map[string]any{}
	if addr != nil {
		payload = map[string]any{"host": addr.IP.String(), "port": addr.Port}
	}
	for _, c := range conns {
		if hint && c.hint {
			c.send(context.Background(), map[string]any{kJSONRPC: jsonRPCVersion, kMethod: kEvent, kParams: map[string]any{
				kType: gateway.SuccessorReadyEvent, kSessionID: "", kPayload: payload}})
			continue
		}
		_ = c.ws.Close(websocket.StatusServiceRestart, "")
	}
}

// HandedRequests is how many requests g's kept sockets got after HandOver.
func (g *Gateway) HandedRequests() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.handedRequests
}

// Carry publishes one frame of a running turn of g. After HandOver g
// carries it: the frame goes to the sockets g keeps, and next relays it
// under its own epoch and sequence with carried_from naming g's frame, as
// the gateway that took over relays it to its own viewers.
func (g *Gateway) Carry(next *Gateway, sessionID, typ string, payload any) {
	g.mu.Lock()
	s := g.sessions[sessionID]
	g.publishLocked(s, typ, payload)
	from := gateway.Cursor{ReplayEpoch: s.epoch, Seq: s.seq}
	handed := g.handedOver
	g.mu.Unlock()
	if !handed {
		return
	}
	next.mu.Lock()
	defer next.mu.Unlock()
	next.publishFromLocked(next.sessions[sessionID], typ, "", payload, &from)
}
