package telegram

import (
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// Every question has the Other row, whatever the agent sent: a question with
// choices has the button, one without has a button to type, and a question
// with more choices than buttons has it too.
func TestKeyboardOfEveryQuestionHasTheOtherRow(t *testing.T) {
	t.Parallel()
	with := promptKeyboard(cbApproval, "k", hub.PromptInfo{Kind: hub.PromptClarify, Choices: []string{"a", "b"}}, nil)
	multi := promptKeyboard(cbApproval, "k", hub.PromptInfo{Kind: hub.PromptClarify, Choices: []string{"a", "b"}, Multi: true}, nil)
	none := promptKeyboard(cbApproval, "k", hub.PromptInfo{Kind: hub.PromptClarify}, nil)
	many := make([]string, maxButtons+3)
	for i := range many {
		many[i] = "c" + strconv.Itoa(i)
	}
	over := promptKeyboard(cbApproval, "k", hub.PromptInfo{Kind: hub.PromptClarify, Choices: many}, nil)
	for name, kb := range map[string]*InlineKeyboard{"choices": with, "multi-select": multi, "many choices": over} {
		last := kb.InlineKeyboard[len(kb.InlineKeyboard)-1]
		if !slices.ContainsFunc(last, func(b InlineButton) bool {
			return b.Text == otherLabel && strings.HasSuffix(b.CallbackData, ":"+tokOther)
		}) {
			t.Errorf("%s: no Other button in %+v", name, last)
		}
	}
	if last := none.InlineKeyboard[len(none.InlineKeyboard)-1]; !strings.HasSuffix(last[0].CallbackData, ":"+tokOther) {
		t.Errorf("an open question has no way to type: %+v", last)
	}
}

func TestQuestionCardTimeIsInTheConfiguredZone(t *testing.T) {
	t.Parallel()
	zone := time.FixedZone("CST", -6*3600)
	at := time.Date(2026, 11, 15, 18, 56, 0, 0, time.UTC)
	got := questionCardHTML(hub.PromptInfo{Question: "Q?", Choices: []string{"a"}}, answerEnd(hub.PromptInfo{Choices: []string{"a"}}, hub.Answer{Picks: []string{"a"}}, at), zone)
	if !strings.Contains(got, "Answered at 12:56 PM (on Telegram)") || !strings.Contains(got, "☑ a") {
		t.Fatalf("card = %q", got)
	}
}
