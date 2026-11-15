package telegram

import (
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// The smart approval card's "this source in this chat" choice gets words,
// not its token.
func TestApprovalSourceChoiceWords(t *testing.T) {
	t.Parallel()

	if got := approvalLabel(hub.ChoiceSource); got != "Allow code from this source in this chat" {
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
