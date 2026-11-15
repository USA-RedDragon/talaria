package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A pending question always shows an answerable card: a chat opened fresh,
// shown again after another (parked), and reloaded, for a question with
// several picks and for the next one of a call with several questions
// (here a subagent's). The answers reach the gateway.
// testdata/clarifylive/run.js drives the real page on a phone in headless
// Chrome and Firefox. Each skips where node or its browser is missing.
func TestPendingQuestionShowsAnswerableCardChrome(t *testing.T) {
	t.Parallel()
	clarifyLive(t, chromePath(t))
}

func TestPendingQuestionShowsAnswerableCardFirefox(t *testing.T) {
	t.Parallel()
	clarifyLive(t, firefoxPath(t))
}

func clarifyLive(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	q1, q2, who := "Switch stick clicks (L3 and R3), which some games use?", "Anything else to map?", "check the mapping"
	e.gw.AddSession(&gatewaytest.Session{ID: "ask", Title: "Asking", Live: true, Running: true, StartedAt: 900,
		Messages: []map[string]any{
			{kRole: roleUser, kText: "plan the controls"},
			{kRole: roleAssistant, kText: "", kCalls: []map[string]any{{"id": "c1", fnKey: map[string]any{fieldName: "clarify", ilArgs: `{"questions": [{"question": "` + q1 + `", "choices": ["yes", "no", "later"]}]}`}}}},
		},
		Prompts:     []gateway.Prompt{{Kind: "clarify", PromptID: "cl-1", Question: &q1, Choices: []string{"L3", "R3", "none"}, MultiSelect: true}},
		NextPrompts: []gateway.Prompt{{Kind: "clarify", PromptID: "cl-2", Question: &q2, Choices: []string{}, Subagent: &who}}})
	e.gw.AddSession(&gatewaytest.Session{ID: "elsewhere", Title: titleOther, Live: true, StartedAt: 700,
		Messages: []map[string]any{{kRole: roleUser, kText: "hello"}, {kRole: roleAssistant, kText: "hi"}}})
	prof, err := os.MkdirTemp("", "clarifylive-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "clarifylive", "run.js"), bin, e.url, prof, q1, q2).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	var got []string
	for range 100 {
		if got = e.gw.ClarifyAnswers(); len(got) >= 2 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if want := []string{`["L3","none"]`, "keep defaults"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %q, want %q", got, want)
	}
}
