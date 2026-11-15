package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A question keeps its card once it is over: every choice that was offered
// with the answer checked, a typed answer in the Other row, when and where it
// was answered, a subagent's chip, or that nobody answered. Every open
// question has the Other row with a text box. The cards stand the same after
// a reload and a switch to another chat, as they come from what Hermes stored
// and not from the page. testdata/questioncard/run.js drives the real page on
// a phone in headless Chrome and Firefox. Each skips where node or its
// browser is missing.
func TestQuestionCardsKeepChoicesAndAnswerChrome(t *testing.T) {
	t.Parallel()
	questionCards(t, chromePath(t))
}

func TestQuestionCardsKeepChoicesAndAnswerFirefox(t *testing.T) {
	t.Parallel()
	questionCards(t, firefoxPath(t))
}

func questionCards(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapClarifyCard)
	str := func(s string) *string { return &s }
	goal := "relift lane android-apk: on-screen controller"
	prompt := func(id, q string, choices []string, multi bool, subagent *string) gateway.Prompt {
		return gateway.Prompt{Kind: gateway.PromptClarify, PromptID: id, Question: str(q), Choices: choices, MultiSelect: multi, Subagent: subagent, Timeout: 1800}
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "ask", Title: "Asking", Live: true, Running: true, StartedAt: 900,
		Messages: []map[string]any{{kRole: roleUser, kText: "plan it"}},
		Prompts:  []gateway.Prompt{prompt("cl-1", "What should cpus/a64 be renamed to?", []string{"cpus/aarch64", "cpus/arm64", "Keep cpus/a64"}, false, nil)},
		NextPrompts: []gateway.Prompt{
			prompt("cl-2", "Which layouts should ship?", []string{"Switch", "Game Boy", "NDS"}, true, nil),
			prompt("cl-3", "What should the release notes call this feature?", []string{}, false, nil),
			prompt("cl-4", "Subagent \""+goal+"\" asks: Switch stick clicks (L3 and R3), which some games use?", []string{"Double-tap the stick", "Separate buttons", "Leave them out"}, false, &goal),
			prompt("cl-5", "Ship it?", []string{"yes", "no", "later"}, false, nil)}})
	e.gw.AddSession(&gatewaytest.Session{ID: "away", Title: titleOther, Live: true, StartedAt: 700,
		Messages: []map[string]any{{kRole: roleUser, kText: "hello"}, {kRole: roleAssistant, kText: "hi"}}})
	// Nobody answers the last question: it runs out once the fourth is answered.
	go func() {
		for range 600 {
			if len(e.gw.ClarifyAnswers()) >= 4 {
				time.Sleep(300 * time.Millisecond)
				e.gw.SettleClarify("ask", "cl-5", "timed_out", 1800)
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "questioncard", "run.js"), bin, e.url, t.TempDir())
	// QCARD_SHOTS names a folder for the screenshots of the cards (Chrome).
	if d := os.Getenv("QCARD_SHOTS"); d != "" {
		cmd.Env = append(os.Environ(), "SHOT_DIR="+d)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
