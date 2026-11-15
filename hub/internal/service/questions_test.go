package service_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
)

// A subagent's question is the child's: the chat's transcript does not say it
// was asked. Once it is answered the hub keeps what Hermes said of it (the
// question, the choices, the answer, when and where, the subagent) in its
// store, and a snapshot of the chat carries it, also to a hub that started
// after the answer. A Hermes that says nothing of how the question ended
// leaves nothing to keep.
func TestSubagentQuestionIsKeptAfterItIsAnswered(t *testing.T) {
	t.Parallel()
	gw := gatewaytest.New("hub", "pw")
	t.Cleanup(gw.Close)
	gw.SetCapabilities(gateway.CapClarifyCard)
	q, goal := "Stick clicks?", "relift lane android-apk"
	gw.AddSession(&gatewaytest.Session{ID: sLive, Title: liveTitle, Live: true, Running: true, StartedAt: 2000,
		Messages: []map[string]any{{"role": roleUser, "text": "hi"}},
		Prompts: []gateway.Prompt{{Kind: gateway.PromptClarify, PromptID: "sq", Question: &q, Choices: []string{"Double-tap", "Separate"},
			Subagent: &goal, Timeout: 1800}}})
	cfg := &config.Config{LogLevel: "info", Users: []config.User{{Sub: "s1", Name: userAlice}}, Backends: []config.Backend{
		{ID: backendPC, Name: "Desktop", URL: gw.URL(), Username: "hub", Password: "pw", Users: []string{userAlice}}}}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	open := func() *service.Service {
		svc := service.New(cfg.Backends, groups{userAlice: {"admins"}}, service.Options{Questions: st, IdleDetach: 20 * time.Millisecond})
		t.Cleanup(svc.Close)
		return svc
	}
	ctx := context.Background()
	first := open()
	ch, cancel, err := first.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	next(t, ch)
	if err := first.AnswerPrompt(hub.WithAnsweredVia(ctx, hub.AnsweredInTelegram), userAlice, backendPC, sLive, "sq", hub.Answer{Picks: []string{"Separate"}}); err != nil {
		t.Fatal(err)
	}
	until(t, ch, "clarify.settled")
	cancel()

	// A hub that starts later: its first snapshot carries the question with its answer.
	second := open()
	ch2, cancel2, err := second.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel2()
	var snap struct {
		Questions []struct {
			PromptID    string   `json:"prompt_id"`
			Outcome     string   `json:"outcome"`
			Question    string   `json:"question"`
			Choices     []string `json:"choices"`
			Answer      string   `json:"answer"`
			AnsweredVia string   `json:"answered_via"`
			AnsweredAt  float64  `json:"answered_at"`
			Subagent    string   `json:"subagent"`
		} `json:"questions"`
	}
	ev := next(t, ch2)
	if ev.Kind != hub.KindSnapshot {
		t.Fatalf("first event = %s", ev.Kind)
	}
	if err := json.Unmarshal(ev.Data, &snap); err != nil || len(snap.Questions) != 1 {
		t.Fatalf("snapshot questions = %+v, %v\n%s", snap.Questions, err, ev.Data)
	}
	got := snap.Questions[0]
	if got.PromptID != "sq" || got.Outcome != "answered" || got.Answer != "Separate" || got.AnsweredVia != hub.AnsweredInTelegram ||
		got.Subagent != goal || got.Question != q || len(got.Choices) != 2 || got.AnsweredAt == 0 {
		t.Fatalf("question = %+v", got)
	}
}

func TestQuestionCombinesPicksWithTheOtherText(t *testing.T) {
	t.Parallel()
	e := setup(t, service.Options{})
	ctx := context.Background()
	ch, cancel, _ := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	defer cancel()
	next(t, ch)
	_, _ = e.svc.Prompt(ctx, userAlice, backendPC, sLive, "pick many")
	until(t, ch, hub.KindClarifyRequest)
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, "cl-1", hub.Answer{Picks: []string{"red", "nope"}, Text: "teal"}); err == nil {
		t.Fatal("a pick that is no choice was taken")
	}
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, "cl-1", hub.Answer{Picks: []string{"red", "green"}, Text: " teal "}); err != nil {
		t.Fatal(err)
	}
	evs := until(t, ch, hub.KindMessageComplete)
	if got := text(t, evs[len(evs)-1]); got != `answered: ["red","green","teal"]` {
		t.Fatalf("answer = %q", got)
	}
}
