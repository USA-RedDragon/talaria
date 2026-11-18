package web_test

import (
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// A page whose event stream moves to the other replica (a rollout, or a
// load balancer that does not pin it) while a turn runs goes on where it
// was: the other replica reads the cursor in its last event id, a place
// in the backend's own stream that both replicas follow, and sends only
// the events after it. Before, the other replica could not read the id
// and sent the whole chat again, on every reconnect.
func TestStreamResumesOnTheOtherReplicaWithoutTheChatAgain(t *testing.T) {
	t.Parallel()
	e := setup(t)
	c := client(t)
	login(t, e, c)
	e.gw.SetRunning("s1", true)
	e.gw.Publish("s1", "message.start", map[string]any{})
	r, stop := stream(t, c, e.url+"/api/sessions/pc/s1/events", "")
	readFreshSnapshot(t, r)
	e.gw.Publish("s1", "message.delta", map[string]any{kText: "a"})
	e.gw.Publish("s1", "message.delta", map[string]any{kText: "b"})
	evs := readEvents(t, r, "message.delta")
	evs = append(evs, readEvents(t, r, "message.delta")...)
	last := evs[len(evs)-1]
	if !strings.Contains(string(last.data), `"b"`) || !strings.Contains(last.id, "~") {
		t.Fatalf("last event = %+v, want delta b with a cursor in its id", last)
	}
	stop()
	// The page reconnects to the other replica, which has not followed
	// the chat; one more delta came meanwhile.
	e.front.to(e.replica(t))
	e.gw.Publish("s1", "message.delta", map[string]any{kText: "c"})
	r2, stop2 := stream(t, c, e.url+"/api/sessions/pc/s1/events", last.id)
	defer stop2()
	e.gw.Publish("s1", "message.delta", map[string]any{kText: "d"})
	var got []string
	lastID := ""
	for len(got) < 2 {
		ev := readEvents(t, r2, "message.delta")
		for _, x := range ev {
			if x.kind == hub.KindSnapshot || x.kind == "snapshot.same" {
				t.Fatalf("the other replica sent %s on a resume", x.kind)
			}
		}
		x := ev[len(ev)-1]
		got = append(got, string(x.data))
		lastID = x.id
	}
	if !strings.Contains(got[0], `"c"`) || !strings.Contains(got[1], `"d"`) {
		t.Fatalf("deltas after the move = %v, want c then d", got)
	}
	stop2()
	// And back: the first replica, which followed the chat all along,
	// resumes from the second one's id too.
	e.front.to(e.ui.Handler())
	r3, stop3 := stream(t, c, e.url+"/api/sessions/pc/s1/events", lastID)
	defer stop3()
	e.gw.Publish("s1", "message.delta", map[string]any{kText: "e"})
	back := readEvents(t, r3, "message.delta")
	if len(back) != 1 || !strings.Contains(string(back[0].data), `"e"`) {
		t.Fatalf("back on the first replica = %+v, want only delta e", back)
	}
}
