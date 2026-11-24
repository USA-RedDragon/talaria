package telegram

import (
	"slices"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// The smart approval card's "this source in this chat" choice gets words,
// not its token.
func TestApprovalSourceChoiceWords(t *testing.T) {
	t.Parallel()

	if got := approvalLabel(hub.PromptInfo{}, hub.ChoiceSource); got != "Allow code from this source in this chat" {
		t.Fatalf("label = %q", got)
	}
	if got := approvalVerdict(hub.ChoiceSource); got != "Approved code from this source in this chat" {
		t.Fatalf("verdict = %q", got)
	}
	o := hub.ApprovalOutcome{Allowed: true, Choice: hub.ChoiceSource, Via: hub.AnsweredInHub}
	if got := outcomeHead(o); got != "Allowed for this source in this chat (in the hub)" {
		t.Fatalf("outcome = %q", got)
	}
}

// The card for outside code names its source on the button, in a row of its
// own, and the choice it sends is the source choice.
func TestPromptKeyboardNamesTheSource(t *testing.T) {
	t.Parallel()

	p := hub.PromptInfo{ID: "p1", Kind: hub.PromptApproval,
		Choices:     []string{hub.ChoiceOnce, hub.ChoiceDeny, hub.ChoiceSource},
		GrantSource: "github.com/AppImage/appimagetool"}
	kb := promptKeyboard("ap", "k", p, nil)
	last := kb.InlineKeyboard[len(kb.InlineKeyboard)-1]
	const want = "Allow code from github.com/AppImage/appimagetool in this chat"
	if len(last) != 1 || last[0].Text != want || last[0].CallbackData != "ap:k:2" {
		t.Fatalf("source row = %+v", last)
	}
	if len(kb.InlineKeyboard) != 2 || len(kb.InlineKeyboard[0]) != 2 {
		t.Fatalf("rows = %+v", kb.InlineKeyboard)
	}
	p.GrantSource = ""
	if got := promptKeyboard("ap", "k", p, nil).InlineKeyboard[1][0].Text; got != "Allow code from this source in this chat" {
		t.Fatalf("unnamed source label = %q", got)
	}
}

func keyboardTexts(kb *InlineKeyboard) []string {
	var out []string
	for _, row := range kb.InlineKeyboard {
		for _, b := range row {
			out = append(out, b.Text)
		}
	}
	return out
}

func TestSmartApprovalKeyboardNamesTheCodeSource(t *testing.T) {
	t.Parallel()
	p := hub.PromptInfo{ID: "p1", Kind: hub.PromptApproval, Rule: "Code from External",
		Reason: "The command runs binaries from a sysroot", Subagent: "unpack the sysroot", GrantSource: "docker.io/hashicorp/tfe-agent",
		Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceAlways, hub.ChoiceDeny}}
	want := []string{"Allow once", "Deny", "Allow code from docker.io/hashicorp/tfe-agent in this chat", "Always allow code from docker.io/hashicorp/tfe-agent"}
	if got := keyboardTexts(promptKeyboard("ap", "k", p, nil)); !slices.Equal(got, want) {
		t.Fatalf("buttons = %q", got)
	}
}

func TestEveryApprovalKeyboardOffersTheChatChoice(t *testing.T) {
	t.Parallel()
	cards := map[string]hub.PromptInfo{
		"plain":      {ID: "a", Kind: hub.PromptApproval, Command: "ls", Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceAlways, hub.ChoiceDeny}},
		"no choices": {ID: "b", Kind: hub.PromptApproval, Command: "ls"},
		"login":      {ID: "c", Kind: hub.PromptApproval, LoginGrant: &hub.LoginGrantCard{DeviceName: "upstairs-pc", Host: "example.com"}, Choices: []string{hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceDevice, hub.ChoiceDeny}},
		"login bare": {ID: "d", Kind: hub.PromptApproval, LoginGrant: &hub.LoginGrantCard{DeviceName: "upstairs-pc", Host: "example.com"}},
	}
	for name, p := range cards {
		got := keyboardTexts(promptKeyboard("ap", "k", p, nil))
		if !slices.Contains(got, "Allow once") || !slices.Contains(got, "Deny") || !slices.ContainsFunc(got, func(s string) bool { return strings.Contains(s, "in this chat") }) {
			t.Errorf("%s: buttons = %q", name, got)
		}
		if p.LoginGrant == nil && !slices.ContainsFunc(got, func(s string) bool { return strings.HasPrefix(s, "Always allow") }) {
			t.Errorf("%s: no always button in %q", name, got)
		}
		if p.LoginGrant != nil && !slices.Contains(got, "Allow on upstairs-pc") {
			t.Errorf("%s: no device button in %q", name, got)
		}
	}
}
