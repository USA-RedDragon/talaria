package service_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
)

// takeover is a backend whose gateway hands over to the next one in
// another pod, behind a Service (Front) that routes to the old one first.
type takeover struct {
	old, next *gatewaytest.Gateway
	front     *gatewaytest.Front
	svc       *service.Service
}

const (
	sCarried = "s-carried"
	sIdle    = "s-idle"
	// idleChats is how many idle chats the hub watches besides the
	// carried one.
	idleChats = 7
	// resumeCost is what one session.resume costs the gateway that just
	// took over: 0.1 to 0.4 s each on a CPU-starved one (Hermes patch 0153).
	resumeCost = 100 * time.Millisecond
	// logLevelInfo is the hub's log level in these tests.
	logLevelInfo = "info"
)

func newTakeover(t *testing.T) *takeover {
	t.Helper()
	old := gatewaytest.New(hubName, "pw")
	next := gatewaytest.New(hubName, "pw")
	front := gatewaytest.NewFront(old)
	t.Cleanup(front.Close)
	t.Cleanup(old.Close)
	t.Cleanup(next.Close)
	old.AddSession(&gatewaytest.Session{ID: sCarried, Title: "Carried", Live: true, Running: true, StartedAt: 2000,
		Messages: []map[string]any{{keyRole: roleUser, kText: "go"}}})
	for i := range idleChats {
		id := sIdle
		if i > 0 {
			id = fmt.Sprintf("%s-%d", sIdle, i)
		}
		old.AddSession(&gatewaytest.Session{ID: id, Title: "Idle", Live: true, StartedAt: float64(1000 + i),
			Messages: []map[string]any{{keyRole: roleUser, kText: "hi"}, {keyRole: roleAsst, kText: "hi back"}}})
	}
	cfg := &config.Config{LogLevel: logLevelInfo, Users: []config.User{{Sub: "s1", Name: userAlice}}, Backends: []config.Backend{
		{ID: backendPC, Name: nameDesktop, URL: front.URL(), Username: hubName, Password: "pw", Users: []string{userAlice}},
	}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := service.New(cfg.Backends, groups{}, service.Options{})
	t.Cleanup(svc.Close)
	return &takeover{old: old, next: next, front: front, svc: svc}
}

// watch reads a viewer's events until message.complete into a list with
// the time each arrived.
type arrival struct {
	at time.Time
	ev hub.Event
}

func watchUntilComplete(t *testing.T, ch <-chan hub.Event) <-chan []arrival {
	t.Helper()
	out := make(chan []arrival, 1)
	go func() {
		var got []arrival
		defer func() { out <- got }()
		timeout := time.After(15 * time.Second)
		for {
			select {
			case e, ok := <-ch:
				if !ok {
					return
				}
				got = append(got, arrival{time.Now(), e})
				if e.Kind == hub.KindMessageComplete {
					return
				}
			case <-timeout:
				return
			}
		}
	}()
	return out
}

// streamAcross streams a carried reply of n deltas, one every step, and
// hands the gateway over after half of them. It returns the reply's text.
func (tk *takeover) streamAcross(n int, step time.Duration, hint bool) string {
	var want strings.Builder
	for i := range n {
		if i == n/2 {
			tk.front.Route(tk.next)
			tk.old.HandOver(tk.next, hint)
		}
		d := fmt.Sprintf("%d,", i)
		want.WriteString(d)
		tk.old.Carry(tk.next, sCarried, "message.delta", map[string]any{kText: d})
		time.Sleep(step)
	}
	// The turn reached its boundary on the old gateway and ended on the next one.
	tk.next.FinishReply(sCarried, want.String())
	return want.String()
}

// attachIdle opens every idle chat but the first and returns their streams
// after their snapshots.
func (tk *takeover) attachIdle(ctx context.Context, t *testing.T) []<-chan hub.Event {
	t.Helper()
	var out []<-chan hub.Event
	for i := 1; i < idleChats; i++ {
		ch, stop, err := tk.svc.Attach(ctx, userAlice, backendPC, fmt.Sprintf("%s-%d", sIdle, i), 0)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(stop)
		next(t, ch)
		out = append(out, ch)
	}
	return out
}

func deltaText(t *testing.T, got []arrival) (string, time.Duration, []string) {
	t.Helper()
	var text strings.Builder
	var gap time.Duration
	var last time.Time
	var other []string
	for _, a := range got {
		switch a.ev.Kind {
		case hub.KindMessageDelta:
			var p struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(a.ev.Data, &p)
			text.WriteString(p.Text)
			if !last.IsZero() {
				gap = max(gap, a.at.Sub(last))
			}
			last = a.at
		case hub.KindMessageComplete:
		default:
			other = append(other, a.ev.Kind)
		}
	}
	return text.String(), gap, other
}

// A carried turn streams on across the takeover: every delta once, in
// order, with no pause, and no snapshot is sent again.
func TestTakeoverMovesTheStreamWithoutAGapOrASnapshot(t *testing.T) {
	t.Parallel()
	tk := newTakeover(t)
	ctx := context.Background()
	ch, stop, err := tk.svc.Attach(ctx, userAlice, backendPC, sCarried, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if k := next(t, ch).Kind; k != hub.KindSnapshot {
		t.Fatalf("first event = %s", k)
	}
	idle, stopIdle, err := tk.svc.Attach(ctx, userAlice, backendPC, sIdle, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stopIdle()
	next(t, idle)
	others := tk.attachIdle(ctx, t)
	tk.next.SlowResume(func(string) time.Duration { return resumeCost })
	done := watchUntilComplete(t, ch)
	const n, step = 300, 5 * time.Millisecond
	want := tk.streamAcross(n, step, true)
	got := <-done
	text, gap, other := deltaText(t, got)
	t.Logf("takeover: %d events, longest pause between deltas %s, other events %v", len(got), gap, other)
	if text != want {
		t.Fatalf("reply across the takeover =\n%q\nwant\n%q", text, want)
	}
	if len(other) > 0 {
		t.Fatalf("events besides the reply across the takeover: %v (want none: no snapshot, no status)", other)
	}
	// The move itself takes about a second here (eight resumes at 100 ms);
	// the reply must not wait for it. The bound leaves room for a slow,
	// race-instrumented runner; a re-subscribe paused it longer and also
	// sent a snapshot (checked above).
	if gap > 500*time.Millisecond {
		t.Fatalf("the reply paused %s at the takeover", gap)
	}
	if got[len(got)-1].ev.Kind != hub.KindMessageComplete {
		t.Fatalf("the turn's end did not arrive: last %s", got[len(got)-1].ev.Kind)
	}
	// The idle chats moved too, without anything sent again.
	for _, c := range append(others, idle) {
		select {
		case e := <-c:
			t.Fatalf("idle chat got %s at the takeover", e.Kind)
		case <-time.After(50 * time.Millisecond):
		}
	}
	if tk.old.ConnCount() != 0 {
		t.Fatalf("the hub kept %d sockets to the old gateway", tk.old.ConnCount())
	}
	if tk.old.HandedRequests() != 0 {
		t.Fatalf("the hub sent %d requests to the old gateway after it handed over", tk.old.HandedRequests())
	}
	// Both chats are served by the gateway that took over: a new frame there arrives.
	tk.next.Publish(sIdle, "session.updated", map[string]any{"title": "Renamed"})
	if e := next(t, idle); e.Kind != "session.updated" {
		t.Fatalf("idle chat after the takeover got %s", e.Kind)
	}
}

// The successor_ready hint names the next pod; the hub dials it there,
// not through the Service, which still routes to the old pod (whose relay
// would close the socket again when its window ends).
func TestTakeoverDialsTheNextGatewayAtItsAddress(t *testing.T) {
	t.Parallel()
	tk := newTakeover(t)
	ctx := context.Background()
	ch, stop, err := tk.svc.Attach(ctx, userAlice, backendPC, sIdle, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	next(t, ch)
	tk.old.HandOver(tk.next, true) // the Service still routes to the old gateway
	deadline := time.Now().Add(5 * time.Second)
	for tk.next.ConnCount() == 0 || tk.old.ConnCount() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("sockets: old %d, next %d", tk.old.ConnCount(), tk.next.ConnCount())
		}
		time.Sleep(10 * time.Millisecond)
	}
	tk.next.Publish(sIdle, "session.updated", map[string]any{"title": "Renamed"})
	if e := next(t, ch); e.Kind != "session.updated" {
		t.Fatalf("after the move got %s", e.Kind)
	}
}

// A gateway that closes the socket instead of hinting (no patch 0155, or
// a hub dial without the hint) still works as before: the hub reconnects
// through the Service and takes a new snapshot.
func TestTakeoverWithoutAHintReconnectsAsBefore(t *testing.T) {
	t.Parallel()
	tk := newTakeover(t)
	ctx := context.Background()
	ch, stop, err := tk.svc.Attach(ctx, userAlice, backendPC, sCarried, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	next(t, ch)
	done := watchUntilComplete(t, ch)
	tk.streamAcross(40, 2*time.Millisecond, false)
	got := <-done
	_, _, other := deltaText(t, got)
	if !containsKind(other, hub.KindSnapshot) {
		t.Fatalf("events after a takeover without a hint = %v, want a new snapshot", other)
	}
}

func containsKind(list []string, k string) bool {
	for _, x := range list {
		if x == k {
			return true
		}
	}
	return false
}

// A move whose frames the next gateway cannot replay from its start falls
// back to a new snapshot.
func TestTakeoverFallsBackToASnapshotWhenTheReplayIsGone(t *testing.T) {
	t.Parallel()
	tk := newTakeover(t)
	tk.next.ReplayMax = 4
	ctx := context.Background()
	ch, stop, err := tk.svc.Attach(ctx, userAlice, backendPC, sCarried, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	next(t, ch)
	// The next gateway relayed more of the turn than it replays before it was ready.
	tk.front.Route(tk.next)
	tk.old.HandOff(tk.next)
	for i := range 10 {
		tk.old.Carry(tk.next, sCarried, "message.delta", map[string]any{kText: fmt.Sprint(i)})
	}
	tk.old.Notify(tk.next, true)
	evs := until(t, ch, hub.KindSnapshot)
	if evs[len(evs)-1].Kind != hub.KindSnapshot {
		t.Fatal("no snapshot")
	}
	// Served by the gateway that took over from here.
	tk.next.FinishReply(sCarried, "0123456789")
	until(t, ch, hub.KindMessageComplete)
}
