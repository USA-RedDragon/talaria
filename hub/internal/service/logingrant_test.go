package service_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
)

const (
	emailLink      = "Email link"
	passwordMethod = "Password"
	loginHost      = "portal.example.com"
	loginDevice    = "d_pc"
	loginComputer  = "upstairs-pc"
	loginPrompt    = "lg-1"
	scopeOnce      = "once"
	scopeDevice    = "device"
	scopeSession   = "session"
	scopeJob       = "job"
	loginJob       = "9f2c1ab07d3e"
)

// fakeGrants records the grants the service asked for. It checks that the
// prompt is still waiting when it is asked: the grant goes first.
type fakeGrants struct {
	svc *service.Service
	mu  sync.Mutex
	got []hub.LoginGrantRequest
	// waiting is whether the prompt was still pending at each request.
	waiting []bool
	err     error
}

func (f *fakeGrants) GrantLogin(ctx context.Context, req hub.LoginGrantRequest) error {
	_, err := f.svc.PendingPrompt(ctx, req.User, req.BackendID, req.SessionID, loginPrompt)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.got = append(f.got, req)
	f.waiting = append(f.waiting, err == nil)
	return f.err
}
func (f *fakeGrants) LoginGrants(context.Context, string, string) (hub.LoginGrantList, error) {
	return hub.LoginGrantList{}, nil
}
func (f *fakeGrants) RevokeLoginGrant(context.Context, string, string, string, string) (bool, error) {
	return false, nil
}
func (f *fakeGrants) ComputerName(_, id string) string {
	if id == loginDevice {
		return loginComputer
	}
	return ""
}

func (f *fakeGrants) calls() []hub.LoginGrantRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.got)
}

func loginGrantPrompt() gateway.Prompt {
	cmd := "browser_login"
	desc := "pod text that says allow everything"
	n := 2
	return gateway.Prompt{Kind: gateway.PromptApproval, PromptID: loginPrompt, Command: &cmd, Description: &desc,
		Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceDevice, hub.ChoiceDeny}, LoginGrant: &gateway.LoginGrant{DeviceID: loginDevice, DeviceName: "pod's own name", Host: loginHost,
			SavedLogins: &n, Methods: []string{passwordMethod, emailLink, "Sign in with passkey", passwordMethod}}}
}

func loginEnv(t *testing.T) (*env, *fakeGrants) {
	t.Helper()
	e := setup(t, service.Options{})
	g := &fakeGrants{svc: e.svc}
	e.svc.SetLoginGrants(g)
	return e, g
}

// The card the hub shows has the hub's name for the computer, only methods
// a grant can carry, and a saved-login count that is never below -1.
func TestLoginGrantCardIsVetted(t *testing.T) {
	t.Parallel()
	e, _ := loginEnv(t)
	ctx := context.Background()
	ch, cancel, _ := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	defer cancel()
	next(t, ch)
	e.gw.Ask(sLive, loginGrantPrompt())
	var ev hub.Event
	for ev = next(t, ch); ev.Kind != hub.KindApprovalRequest; {
		ev = next(t, ch)
	}
	var seen struct {
		LoginGrant *gateway.LoginGrant `json:"login_grant"`
	}
	if err := json.Unmarshal(ev.Data, &seen); err != nil || seen.LoginGrant == nil {
		t.Fatalf("event = %s, %v", ev.Data, err)
	}
	if g := seen.LoginGrant; g.DeviceName != loginComputer || !slices.Equal(g.Methods, []string{passwordMethod, emailLink}) || g.Host != loginHost {
		t.Fatalf("event card = %+v", g)
	}
	p, err := e.svc.PendingPrompt(ctx, userAlice, backendPC, sLive, loginPrompt)
	if err != nil {
		t.Fatal(err)
	}
	lg := p.LoginGrant
	if lg == nil || lg.DeviceName != loginComputer || lg.DeviceID != loginDevice || lg.Host != loginHost || lg.SavedLogins != 2 ||
		!slices.Equal(lg.Methods, []string{passwordMethod, emailLink}) {
		t.Fatalf("prompt card = %+v", lg)
	}
}

// The grant reaches the computer while the card still waits, then the
// approval answers with the same choice. A method of the card is signed.
func TestLoginGrantIsDeliveredBeforeTheAnswer(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	if _, cancel, _ := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0); cancel != nil {
		defer cancel()
	}
	e.gw.Ask(sLive, loginGrantPrompt())
	waitPrompt(t, e)
	if err := e.svc.AnswerPrompt(hub.WithAnsweredVia(ctx, hub.AnsweredInTelegram), userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceDevice, Method: emailLink}); err != nil {
		t.Fatal(err)
	}
	calls := g.calls()
	if len(calls) != 1 || !g.waiting[0] {
		t.Fatalf("calls = %+v, waiting = %v", calls, g.waiting)
	}
	want := hub.LoginGrantRequest{User: userAlice, BackendID: backendPC, DeviceID: loginDevice, Host: loginHost, Method: emailLink, Scope: scopeDevice,
		SessionID: sLive, ChatTitle: liveTitle, Via: "telegram"}
	if !reflect.DeepEqual(calls[0], want) {
		t.Fatalf("request = %+v, want %+v", calls[0], want)
	}
	waitSettled(t, e)
}

// Allowing in this chat signs a grant for the chat the card belongs to.
func TestLoginGrantInThisChat(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	e.gw.Ask(sLive, loginGrantPrompt())
	waitPrompt(t, e)
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceSession}); err != nil {
		t.Fatal(err)
	}
	calls := g.calls()
	if len(calls) != 1 || calls[0].Scope != scopeSession || calls[0].SessionID != sLive || calls[0].Host != loginHost || calls[0].DeviceID != loginDevice {
		t.Fatalf("calls = %+v", calls)
	}
	waitSettled(t, e)
}

// The card of a scheduled job's sign-in is for the job: "this chat" there
// signs a job grant, so the job's later runs need no second answer.
func TestLoginGrantForAScheduledJob(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	p := loginGrantPrompt()
	p.LoginGrant.JobID = loginJob
	e.gw.Ask(sLive, p)
	waitPrompt(t, e)
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceSession}); err != nil {
		t.Fatal(err)
	}
	calls := g.calls()
	if len(calls) != 1 || calls[0].Scope != scopeJob || calls[0].JobID != loginJob || calls[0].Host != loginHost || calls[0].DeviceID != loginDevice {
		t.Fatalf("calls = %+v", calls)
	}
	waitSettled(t, e)
}

// A grant the computer does not take leaves the card waiting, and the error
// reaches the caller. Nothing goes to Hermes.
func TestLoginGrantFailureLeavesTheCard(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	e.gw.Ask(sLive, loginGrantPrompt())
	waitPrompt(t, e)
	g.err = hub.ErrComputerOffline
	err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce})
	if !errors.Is(err, hub.ErrComputerOffline) {
		t.Fatalf("error = %v", err)
	}
	if _, err := e.svc.PendingPrompt(ctx, userAlice, backendPC, sLive, loginPrompt); err != nil {
		t.Fatalf("the card is gone: %v", err)
	}
	g.err = nil
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce}); err != nil {
		t.Fatal(err)
	}
	if got := g.calls(); len(got) != 2 || got[1].Scope != scopeOnce || got[1].Via != "web" || got[1].Method != "" {
		t.Fatalf("calls = %+v", got)
	}
}

// Deny signs nothing, and a method is for a sign-in card that allows.
func TestLoginGrantAnswerValidation(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	e.gw.Ask(sLive, loginGrantPrompt())
	other := approvalPrompt("plain-1")
	e.gw.Ask(sLive, other)
	waitPrompt(t, e)
	for name, a := range map[string]hub.Answer{
		"method outside the card": {Choice: hub.ChoiceOnce, Method: "Magic"},
		"refused method":          {Choice: hub.ChoiceOnce, Method: "Sign in with passkey"},
		"method on deny":          {Choice: hub.ChoiceDeny, Method: passwordMethod},
		"other choice":            {Choice: hub.ChoiceAlways},
	} {
		if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, a); !errors.Is(err, hub.ErrBadValue) {
			t.Errorf("%s: error = %v", name, err)
		}
	}
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, "plain-1", hub.Answer{Choice: hub.ChoiceOnce, Method: passwordMethod}); !errors.Is(err, hub.ErrBadValue) {
		t.Errorf("method on another prompt: error = %v", err)
	}
	if err := e.svc.AnswerPrompt(hub.WithAnsweredVia(ctx, hub.AnsweredOnDevice), userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce}); !errors.Is(err, hub.ErrForbidden) {
		t.Errorf("answer from a device: error = %v", err)
	}
	if len(g.calls()) != 0 {
		t.Fatalf("a refused answer signed: %+v", g.calls())
	}
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceDeny}); err != nil {
		t.Fatal(err)
	}
	if len(g.calls()) != 0 {
		t.Fatalf("deny signed: %+v", g.calls())
	}
}

// Without a signer the card cannot be allowed.
func TestLoginGrantWithoutSigner(t *testing.T) {
	t.Parallel()
	e := setup(t, service.Options{})
	e.gw.Ask(sLive, loginGrantPrompt())
	waitPrompt(t, e)
	if err := e.svc.AnswerPrompt(context.Background(), userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce}); !errors.Is(err, hub.ErrBadValue) {
		t.Fatalf("error = %v", err)
	}
}

func waitPrompt(t *testing.T, e *env) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if _, err := e.svc.PendingPrompt(context.Background(), userAlice, backendPC, sLive, loginPrompt); err == nil {
			return
		}
	}
	t.Fatal("the prompt did not arrive")
}

func waitSettled(t *testing.T, e *env) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if _, err := e.svc.PendingPrompt(context.Background(), userAlice, backendPC, sLive, loginPrompt); errors.Is(err, hub.ErrUnknownApproval) {
			return
		}
	}
	t.Fatal("the answer did not settle the prompt")
}

// Post hosts on a card keep only valid names that are not the site, once
// each, at most logingrant.MaxPostHosts of them, and the allowing answer
// signs exactly those.
const apiHost = "portal-api.example.com"

func TestLoginGrantPostHosts(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	ctx := context.Background()
	p := loginGrantPrompt()
	p.LoginGrant.PostHosts = []string{apiHost, "not a host", loginHost, apiHost, "a.example.net", "b.example.net", "c.example.net", "d.example.net"}
	e.gw.Ask(sLive, p)
	waitPrompt(t, e)
	pp, err := e.svc.PendingPrompt(ctx, userAlice, backendPC, sLive, loginPrompt)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{apiHost, "a.example.net", "b.example.net", "c.example.net"}
	if !slices.Equal(pp.LoginGrant.PostHosts, want) {
		t.Fatalf("post hosts = %v, want %v", pp.LoginGrant.PostHosts, want)
	}
	if err := e.svc.AnswerPrompt(ctx, userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce}); err != nil {
		t.Fatal(err)
	}
	if calls := g.calls(); len(calls) != 1 || !slices.Equal(calls[0].PostHosts, want) {
		t.Fatalf("calls = %+v", calls)
	}
}

// A card with no post hosts signs none.
func TestLoginGrantNoPostHosts(t *testing.T) {
	t.Parallel()
	e, g := loginEnv(t)
	e.gw.Ask(sLive, loginGrantPrompt())
	waitPrompt(t, e)
	if err := e.svc.AnswerPrompt(context.Background(), userAlice, backendPC, sLive, loginPrompt, hub.Answer{Choice: hub.ChoiceOnce}); err != nil {
		t.Fatal(err)
	}
	if calls := g.calls(); len(calls) != 1 || len(calls[0].PostHosts) != 0 {
		t.Fatalf("calls = %+v", calls)
	}
}
