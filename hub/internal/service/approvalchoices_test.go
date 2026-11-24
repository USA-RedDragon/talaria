package service_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

func approvalKinds() map[string]gateway.Prompt {
	login := loginGrantPrompt()
	loginBare := loginGrantPrompt()
	loginBare.Choices = nil
	return map[string]gateway.Prompt{
		"plain command": {Kind: gateway.PromptApproval, PromptID: "k-plain", Command: ptr("rm -rf build"), Description: ptr("recursive delete"),
			Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceAlways, hub.ChoiceDeny}},
		"no choices": {Kind: gateway.PromptApproval, PromptID: "k-bare", Command: ptr("cleanup")},
		"provenance": {Kind: gateway.PromptApproval, PromptID: "k-prov", Command: ptr("run this command"), Rule: ptr("Code from External"),
			Reason: ptr("The command runs binaries through the ld-linux loader."), Subagent: ptr("unpack the sysroot"),
			GrantSource: ptr("docker.io/hashicorp/tfe-agent"), Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceAlways, hub.ChoiceDeny}},
		"login":            func() gateway.Prompt { login.PromptID = "k-login"; return login }(),
		"login no choices": func() gateway.Prompt { loginBare.PromptID = "k-login-bare"; return loginBare }(),
		"exempt": {Kind: gateway.PromptApproval, PromptID: "k-exempt", Command: ptr("echo"), AlwaysExempt: ptr("one-off"),
			Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceDeny}},
	}
}

func hasAll(have []string, want ...string) bool {
	for _, w := range want {
		if !slices.Contains(have, w) {
			return false
		}
	}
	return true
}

// Every approval the hub holds offers allow once, allow in this chat and
// deny, and always (device for a sign-in) unless the prompt says why a
// permanent grant means nothing.
func TestApprovalsAlwaysOfferTheChatChoice(t *testing.T) {
	t.Parallel()
	e, _ := loginEnv(t)
	ctx := context.Background()
	for _, p := range approvalKinds() {
		e.gw.Ask(sLive, p)
	}
	for name, p := range approvalKinds() {
		var got hub.PromptInfo
		for i := 0; i < 500; i++ {
			info, err := e.svc.PendingPrompt(ctx, userAlice, backendPC, sLive, p.PromptID)
			if err == nil {
				got = info
				break
			}
			waitMillis()
		}
		if got.ID == "" {
			t.Fatalf("%s: the prompt did not arrive", name)
		}
		if !hasAll(got.Choices, hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceDeny) {
			t.Errorf("%s: choices = %v, want once, session and deny", name, got.Choices)
		}
		perm := hub.ChoiceAlways
		if got.LoginGrant != nil {
			perm = hub.ChoiceDevice
		}
		if got.AlwaysExempt == "" && !slices.Contains(got.Choices, perm) {
			t.Errorf("%s: choices = %v, want %s", name, got.Choices, perm)
		}
	}
}

func TestPromptInfoCarriesScopeAndExemption(t *testing.T) {
	t.Parallel()
	e, _ := loginEnv(t)
	ctx := context.Background()
	p := approvalKinds()["exempt"]
	p.Scope = ptr("the dangerous-command pattern recursive delete")
	e.gw.Ask(sLive, p)
	var info hub.PromptInfo
	for i := 0; i < 500; i++ {
		var err error
		if info, err = e.svc.PendingPrompt(ctx, userAlice, backendPC, sLive, p.PromptID); err == nil {
			break
		}
		waitMillis()
	}
	if info.AlwaysExempt != "one-off" || info.Scope != "the dangerous-command pattern recursive delete" {
		t.Fatalf("info = %+v", info)
	}
}

func waitMillis() { time.Sleep(10 * time.Millisecond) }
