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

// A chat waits on its own question and on a subagent's, as Hermes sends
// them: the subagent's prompt keeps the older execution generation it was
// asked in. Answering the subagent's card leaves the chat's own question
// answerable (also after a reload), and each answer goes back with its own
// prompt's generation. testdata/subagentanswer/run.js drives the real page
// on a phone in headless Chrome and Firefox. Each skips where node or its
// browser is missing.
func TestSubagentAnswerKeepsChatQuestionChrome(t *testing.T) {
	t.Parallel()
	subagentAnswer(t, chromePath(t))
}

func TestSubagentAnswerKeepsChatQuestionFirefox(t *testing.T) {
	t.Parallel()
	subagentAnswer(t, firefoxPath(t))
}

func subagentAnswer(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	e := setup(t)
	qSub, qMain, who := "Which lane runs first?", "Ship the build now?", "run the lanes"
	e.gw.AddSession(&gatewaytest.Session{ID: "ask", Title: "Asking", Live: true, Running: true, StartedAt: 900, Generation: 2,
		Messages: []map[string]any{
			{kRole: roleUser, kText: "start the lanes"},
			{kRole: roleAssistant, kText: "", kCalls: []map[string]any{{"id": "c1", fnKey: map[string]any{fieldName: gateway.PromptClarify, ilArgs: `{"questions": [{"question": "` + qMain + `", "choices": ["ship", "hold"]}]}`}}}},
		},
		Prompts: []gateway.Prompt{
			{Kind: gateway.PromptClarify, PromptID: "sub-1", ExecutionGeneration: 1, Question: &qSub, Choices: []string{"lane-a", "lane-b"}, Subagent: &who},
			{Kind: gateway.PromptClarify, PromptID: "main-2", ExecutionGeneration: 2, Question: &qMain, Choices: []string{"ship", "hold"}},
		}})
	prof, err := os.MkdirTemp("", "subagentanswer-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := exec.CommandContext(t.Context(), node, filepath.Join("testdata", "subagentanswer", "run.js"), bin, e.url, prof, qSub, qMain).CombinedOutput()
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
	if want := []string{"lane-a", "ship"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("answers = %q, want %q", got, want)
	}
	gens := map[string]any{}
	for _, c := range e.gw.Calls() {
		if c.Method == gateway.MethodClarify {
			id, _ := c.Params["prompt_id"].(string)
			gens[id] = c.Params["execution_generation"]
		}
	}
	if want := map[string]any{"sub-1": float64(1), "main-2": float64(2)}; !reflect.DeepEqual(gens, want) {
		t.Fatalf("generations answered = %v, want %v", gens, want)
	}
}
