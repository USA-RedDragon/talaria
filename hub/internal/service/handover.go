package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
)

// A Hermes restart that carries running turns (Talaria Hermes patches 0136
// and 0155) hands the profile to the gateway in the next pod while the old
// one runs its claimed turns on to their boundaries. The old gateway keeps
// the hub's socket open and, once the next gateway is ready, sends
// gateway.successor_ready on it. The hub then opens a second connection to
// the next gateway, at the address in the event when it has one (the
// Service may still route to the old pod), moves every session to it, and
// only then closes the old socket: make before break. A session moves with
// session.resume and session.events.since from the start of the next
// gateway's stream, not with a new snapshot: viewers see neither a gap nor
// the chat sent again. The next gateway relays the carried turns' frames
// under its own epoch and names each carrier frame (carried_from), so the
// frames the hub already took from the old socket are dropped.

// successorDialer is a Dialer that reaches the gateway that took over at
// its own address (gateway.Dialer).
type successorDialer interface {
	DialSuccessor(ctx context.Context, host string, port int, onEvent func(gateway.Event)) (*gateway.Client, error)
}

// errMoveGap is a move whose frames the next gateway no longer replays from
// the start of its stream: the session takes a new snapshot instead.
var errMoveGap = errors.New("the gateway that took over cannot replay the session from its start")

// events returns the event callback of one connection and set, which names
// that connection once the dial returned it. Frames before set name none.
func (b *backend) events() (onEvent func(gateway.Event), set func(*gateway.Client)) {
	var mu sync.Mutex
	var from *gateway.Client
	onEvent = func(ev gateway.Event) {
		mu.Lock()
		c := from
		mu.Unlock()
		b.onEventFrom(c, ev)
	}
	set = func(c *gateway.Client) {
		mu.Lock()
		from = c
		mu.Unlock()
	}
	return onEvent, set
}

func (b *backend) onEventFrom(c *gateway.Client, ev gateway.Event) {
	if ev.Type == gateway.SuccessorReadyEvent {
		if c != nil {
			var to gateway.SuccessorReady
			_ = json.Unmarshal(ev.Payload, &to)
			go b.handover(c, to)
		}
		return
	}
	if ev.SessionID == "" {
		return
	}
	b.mu.Lock()
	ls := b.sessions[ev.SessionID]
	b.mu.Unlock()
	if ls != nil {
		ls.handleFrom(c, ev)
	}
}

func (b *backend) isHanded(c *gateway.Client) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.handed[c]
}

// handover moves the backend from old, whose gateway handed over, to the
// gateway that took over (see the top of this file). It outlives any
// request.
//
//nolint:contextcheck // see above
func (b *backend) handover(old *gateway.Client, to gateway.SuccessorReady) {
	sd, ok := b.dialer.(successorDialer)
	if !ok {
		return
	}
	start := time.Now()
	b.dialMu.Lock()
	b.mu.Lock()
	if b.closed || b.handed[old] || (b.client != old && b.client != nil) {
		b.mu.Unlock()
		b.dialMu.Unlock()
		return
	}
	b.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), b.svc.opts.CallTimeout)
	onEvent, set := b.events()
	c, err := sd.DialSuccessor(ctx, to.Host, to.Port, onEvent)
	if err != nil && to.Host != "" {
		b.log.Warn("dial the gateway that took over at its address, trying the backend URL", "error", err.Error())
		onEvent, set = b.events()
		c, err = sd.DialSuccessor(ctx, "", 0, onEvent)
	}
	cancel()
	if err != nil {
		// The old socket closes in the end, and the usual reconnect follows.
		b.log.Warn("dial the gateway that took over", "error", err.Error())
		b.dialMu.Unlock()
		return
	}
	set(c)
	c.SetStallAfter(b.svc.opts.StallAfter)
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		b.dialMu.Unlock()
		c.Close()
		return
	}
	if b.handed == nil {
		b.handed = map[*gateway.Client]bool{}
	}
	b.client, b.lastErr = c, ""
	b.handed[old] = true
	var sessions []*live
	for _, ls := range b.sessions {
		if !containsLive(sessions, ls) {
			sessions = append(sessions, ls)
		}
	}
	b.mu.Unlock()
	go b.watch(c)
	b.wake()
	b.dialMu.Unlock()
	moved := 0
	for _, ls := range sessions {
		if !ls.on(old) {
			continue
		}
		if _, err := b.ensure(context.Background(), ls); err != nil {
			b.log.Warn("move session to the gateway that took over", "session", ls.id, "error", err.Error())
			continue
		}
		moved++
	}
	old.Close()
	b.log.Info("moved to the gateway that took over", "sessions", moved, "took", time.Since(start).Round(time.Millisecond).String())
}

func containsLive(list []*live, ls *live) bool {
	for _, l := range list {
		if l == ls {
			return true
		}
	}
	return false
}

// move subscribes ls on c, the connection to the gateway that took over
// from the one ls is on (from), without a new snapshot: the frames of the
// next gateway's stream from its start, less the carrier's frames ls has
// (carried_from), then the live ones. Frames of from go on reaching
// viewers until the cut. ls.opMu is held.
func (b *backend) move(ctx context.Context, ls *live, from, c *gateway.Client) error {
	cctx, cancel := b.timeout(ctx)
	defer cancel()
	ls.mu.Lock()
	ls.moving, ls.moveEarly = c, nil
	ls.mu.Unlock()
	abort := func(sub string) {
		ls.mu.Lock()
		ls.moving, ls.moveEarly = nil, nil
		ls.mu.Unlock()
		if sub != "" {
			_ = c.Call(cctx, gateway.MethodSessionDetach, gateway.DetachParams{SessionID: ls.id, SubscriptionID: sub}, nil)
		}
	}
	var snap gateway.Snapshot
	if err := c.Call(cctx, gateway.MethodSessionResume, gateway.ResumeParams{SessionID: ls.id}, &snap); err != nil {
		abort("")
		return err
	}
	var r gateway.EventsSinceResult
	err := c.Call(cctx, gateway.MethodEventsSince, gateway.EventsSinceParams{SessionID: ls.id, ReplayEpoch: snap.ReplayEpoch}, &r)
	if err == nil && r.SnapshotRequired {
		err = errMoveGap
	}
	if err != nil {
		abort(snap.SubscriptionID)
		return err
	}
	b.reasoning(cctx, c, ls.id)
	ls.mu.Lock()
	early := ls.moveEarly
	ls.moving, ls.moveEarly = nil, nil
	ls.prevEpoch, ls.prevSeq = ls.epoch, ls.gwSeq
	ls.epoch, ls.gwSeq = snap.ReplayEpoch, 0
	ls.movedFrom = from
	// The frames up to the snapshot, its prompts and inputs, then the
	// frames after it, so each list is as the stream left it.
	var after []gateway.Event
	for _, ev := range r.Events {
		if ev.Seq > snap.LastSequence {
			after = append(after, ev)
			continue
		}
		ls.apply(ev)
	}
	ls.subID = snap.SubscriptionID
	ls.generation = max(ls.generation, snap.ExecutionGeneration)
	ls.revision = max(ls.revision, snap.Revision)
	// A prompt the carrier raised that this gateway has not relayed yet is
	// still open: only new ones are added here.
	ls.addPrompts(snap.Prompts)
	ls.setInputs(snap.Pending)
	for _, ev := range after {
		ls.apply(ev)
	}
	for _, ev := range early {
		ls.apply(ev)
	}
	ls.mu.Unlock()
	ls.setClient(c)
	b.markBack()
	return nil
}

// handleFrom passes a frame of connection c on (see handle): one of the
// connection a move subscribes on waits for the cut, and one of the
// connection a session moved off is dropped.
func (ls *live) handleFrom(c *gateway.Client, ev gateway.Event) {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	switch {
	case c != nil && c == ls.moving:
		ls.moveEarly = append(ls.moveEarly, ev)
		return
	case c != nil && c == ls.movedFrom:
		return
	case ls.pending:
		ls.early = append(ls.early, ev)
		return
	}
	ls.apply(ev)
}

// seen says whether the session has ev already: a frame at or before the
// last one it took from this stream, or a frame the gateway that took over
// relays from the one the session moved off that it took there
// (carriedSeen). Else ev's sequence is the last one taken. ls.mu is held.
func (ls *live) seen(ev gateway.Event) bool {
	if ev.Seq != 0 {
		if ev.Seq <= ls.gwSeq {
			return true
		}
		ls.gwSeq = ev.Seq
	}
	return ls.carriedSeen(ev)
}

// carriedSeen says whether ev is a frame of the gateway the session moved
// off that the hub took from there already. ls.mu is held.
func (ls *live) carriedSeen(ev gateway.Event) bool {
	cf := ev.CarriedFrom
	return cf != nil && ls.prevEpoch != "" && cf.ReplayEpoch == ls.prevEpoch && cf.Seq <= ls.prevSeq
}

// addPrompts adds the prompts of ps the session does not know, announced
// as Hermes would. ls.mu is held.
func (ls *live) addPrompts(ps []gateway.Prompt) {
	for _, p := range ps {
		if p.Kind != gateway.PromptApproval && p.Kind != gateway.PromptClarify {
			continue
		}
		if _, known := ls.prompts[p.PromptID]; known {
			continue
		}
		ls.b.svc.vetLoginGrant(ls.b.cfg.ID, &p)
		ls.prompts[p.PromptID] = p
		ls.promptNotice(p)
		ls.announcePrompt(p)
	}
}
