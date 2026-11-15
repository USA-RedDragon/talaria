package service_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
)

// A viewer that opens a chat the replica has held for a while gets the
// transcript as it is now in one snapshot, not the old snapshot and every
// event of the turns since.
func TestFreshOpenOfWarmChatGetsNewSnapshot(t *testing.T) {
	t.Parallel()
	e := setup(t, service.Options{})
	ctx := context.Background()
	first, stop, err := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	until(t, first, hub.KindSnapshot)
	const turns = 5
	for range turns {
		e.gw.Publish(sLive, hub.KindMessageStart, map[string]any{})
		for range 50 {
			e.gw.Publish(sLive, hub.KindMessageDelta, map[string]any{kText: "words "})
		}
		e.gw.Publish(sLive, hub.KindMessageComplete, map[string]any{kStatus: "complete"})
	}
	for n := 0; n < turns; {
		if next(t, first).Kind == hub.KindMessageComplete {
			n++
		}
	}
	second, stop2, err := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop2()
	// The held snapshot comes at once to show while the fresh one is
	// taken, then the fresh one, and nothing of the old turns.
	evs := until(t, second, hub.KindSnapshot)
	if len(evs) != 1 || !evs[0].Provisional || evs[0].Seq != 0 {
		t.Fatalf("a fresh open began with %v, want the held snapshot marked provisional", kinds(evs))
	}
	evs = until(t, second, hub.KindSnapshot)
	if len(evs) != 1 || evs[0].Provisional {
		t.Fatalf("after the held snapshot came %v, want one fresh snapshot", kinds(evs))
	}
	e.gw.Publish(sLive, hub.KindMessageStart, map[string]any{})
	e.gw.Publish(sLive, hub.KindMessageDelta, map[string]any{kText: "marker"})
	var after []hub.Event
	for {
		ev := next(t, second)
		after = append(after, ev)
		if ev.Kind == hub.KindMessageDelta && text(t, ev) == "marker" {
			break
		}
	}
	if len(after) != 2 {
		t.Fatalf("%d events after the snapshot before the live one, want 2: the old turns were replayed", len(after))
	}
}

// A viewer that opens a chat whose running turn holds steers gets a fresh
// snapshot: Hermes stores a steer where the turn reads it and sends no
// event then, so only its transcript has the steer's place. The held
// snapshot and the buffered events would put the page's steers after the
// held rows, before the turn's tool cards.
func TestOpenWhileTurnHoldsSteersGetsNewSnapshot(t *testing.T) {
	t.Parallel()
	e := setup(t, fastSteer())
	ctx := context.Background()
	first, stop, err := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	until(t, first, hub.KindSnapshot)
	running(t, e)
	until(t, first, hub.KindMessageStart)
	res, err := e.svc.Prompt(hub.WithSteer(ctx), userAlice, backendPC, sLive, textSteer)
	if err != nil || !res.Steered {
		t.Fatalf("prompt = %+v %v", res, err)
	}
	e.gw.ToolRound(sLive, "call-1", "terminal")
	until(t, first, hub.KindToolComplete)
	second, stop2, err := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop2()
	evs := until(t, second, hub.KindSnapshot)
	if len(evs) != 1 || !evs[0].Provisional {
		t.Fatalf("an open began with %v, want the held snapshot marked provisional", kinds(evs))
	}
	evs = until(t, second, hub.KindSnapshot)
	if len(evs) != 1 || evs[0].Provisional {
		t.Fatalf("after the held snapshot came %v, want one fresh snapshot", kinds(evs))
	}
	var snap hub.Snapshot
	if err := json.Unmarshal(evs[0].Data, &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.Pending) != 1 || snap.Pending[0].Status != hub.PendingSteering {
		t.Fatalf("pending = %+v, want the steer the turn holds", snap.Pending)
	}
	last := string(snap.Messages[len(snap.Messages)-1])
	if !strings.Contains(last, gatewaytest.SteerOpen) || !strings.Contains(last, textSteer) {
		t.Fatalf("last row = %s, want the steer where the turn read it", last)
	}
}
