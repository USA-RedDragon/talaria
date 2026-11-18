package telegram_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/telegram"
)

const (
	tkPrompt  = "tk-ap"
	tkPartOne = "Part one."
	tkPartTwo = "Part two."
)

// runPeer runs a bot on the harness's fakes, as another hub replica does
// once it takes the bot over, and returns its stop.
func runPeer(t *testing.T, h *harness) func() {
	t.Helper()
	cfg := testConfig(h.tg)
	cfg.Drafts = true
	bot, err := telegram.New(cfg, telegram.Options{PublicURL: "https://hub.example/", Service: h.hub, Links: h.links,
		Tokens: h.tokens, State: h.state, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- bot.Run(ctx) }()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("bot did not stop")
		}
	}
	t.Cleanup(stop)
	return stop
}

func newPeerHarness(t *testing.T) *harness {
	t.Helper()
	return &harness{tg: newFakeTelegram(t), hub: newFakeHub(), state: newFakeState(), tokens: &fakeTokens{},
		links: &fakeLinks{users: map[int64]string{aliceTG: userAlice, bobTG: userBob}}}
}

// emitAt sends an event of sOld with its place in the backend's stream, as the
// hub does for every event of a session.
func (h *fakeHub) emitAt(t *testing.T, kind string, seq int64, data any) {
	t.Helper()
	raw, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	st := h.streams[sOld]
	h.seq++
	ev := hub.Event{Seq: h.seq, Kind: kind, Data: raw, Cursor: hub.Cursor{Epoch: "ep", Seq: seq}}
	h.mu.Unlock()
	if st == nil {
		t.Fatalf("no stream for %s", sOld)
	}
	st.ch <- ev
}

func (h *fakeHub) waitAttaches(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		h.mu.Lock()
		got := len(h.attaches)
		h.mu.Unlock()
		if got >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("wanted %d attaches", n)
}

func countSends(tg *fakeTelegram, contains string) int {
	return len(tg.find(mSend, contains))
}

// When another replica takes the bot over during a turn, it attaches the
// chat again and gets the running turn from its start. What the last
// leader sent for those events is not sent again: the reply's first part,
// the status line and the approval card show once, the card's buttons
// still work, and the new leader goes on editing the old status line.
// Before, the new leader sent each of them again and the old card's
// buttons answered that the request was no longer pending.
func TestTakeoverDoesNotResendWhatTheLastLeaderSent(t *testing.T) {
	t.Parallel()
	h := newPeerHarness(t)
	h.state.chats[aliceTG] = hub.TelegramChat{ChatID: aliceTG, User: userAlice, BackendID: beLaptop, SessionID: sOld}
	h.hub.pending = map[string]bool{tkPrompt: true}
	approval := map[string]any{kPromptID: tkPrompt, kCommand: "rm -rf out", "tool_name": toolTerminal}
	turn := func() {
		h.hub.emitAt(t, hub.KindMessageStart, 1, map[string]any{})
		h.hub.emitAt(t, hub.KindMessageDelta, 2, map[string]any{kText: tkPartOne})
		h.hub.emitAt(t, hub.KindToolStart, 3, map[string]any{kToolID: "t1", kName: toolTerminal, kContext: "rm -rf out"})
		h.hub.emitAt(t, hub.KindApprovalRequest, 4, approval)
	}
	stopA := runPeer(t, h)
	h.hub.waitAttaches(t, 1)
	h.hub.emitAt(t, hub.KindSnapshot, 0, hub.Snapshot{SessionID: sOld, BackendID: beLaptop})
	turn()
	card := h.tg.wait(mSend, "Needs you")
	h.tg.wait(mSend, tkPartOne)
	status := h.tg.wait(mSend, "Working")
	stopA()

	runPeer(t, h)
	h.hub.waitAttaches(t, 2)
	raw, err := json.Marshal(approval)
	if err != nil {
		t.Fatal(err)
	}
	h.hub.emitAt(t, hub.KindSnapshot, 4, hub.Snapshot{SessionID: sOld, BackendID: beLaptop, Running: true,
		Prompts: []json.RawMessage{raw}})
	turn()
	// The old card's button works on the new leader.
	data, _ := card.buttons()[0]["callback_data"].(string)
	h.tg.press(dm(aliceTG), aliceTG, card.ResultID, data)
	deadline := time.Now().Add(5 * time.Second)
	for len(h.hub.answersCopy()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if a := h.hub.answersCopy(); len(a) != 1 || a[0].PromptID != tkPrompt {
		t.Errorf("answers after pressing the old card = %+v, want one for %s", a, tkPrompt)
	}
	h.hub.emitAt(t, "approval.settled", 5, map[string]any{kPromptID: tkPrompt})
	h.hub.emitAt(t, hub.KindToolComplete, 6, map[string]any{kToolID: "t1", kName: toolTerminal})
	h.hub.emitAt(t, hub.KindMessageDelta, 7, map[string]any{kText: tkPartTwo})
	h.hub.emitAt(t, hub.KindMessageComplete, 8, map[string]any{kText: tkPartOne + " " + tkPartTwo, kStatus: statusComplete})
	h.tg.wait(mSend, tkPartTwo)
	final := h.tg.wait(mEdit, "Worked for")
	for _, s := range []string{tkPartOne, "Needs you", "Working", tkPartTwo} {
		if n := countSends(h.tg, s); n != 1 {
			t.Errorf("%q sent %d times, want once", s, n)
		}
	}
	if final.messageID() != status.ResultID {
		t.Errorf("final status edited message %d, want the old leader's status line %d", final.messageID(), status.ResultID)
	}
	if strings.Contains(h.tg.find(mSend, tkPartTwo)[0].text(), tkPartOne) {
		t.Error("the reply's end repeats its first part")
	}
}
