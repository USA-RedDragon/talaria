package web_test

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// oneChatStep is one row of the sequence the chat and its subagent both
// have: what a turn shows (thinking, replies, a group of commands, notices
// Hermes put in, another agent's message, a failed turn, the user's steer).
type oneChatStep struct {
	role, text, think, kind string
	calls                   []parityCall
}

// oneChatSteps is the sequence after the first user row (the chat's prompt,
// the subagent's task).
func oneChatSteps() []oneChatStep {
	ok := func(out string) string { return `{"output": "` + out + `", "exit_code": 0}` }
	return []oneChatStep{
		{role: roleAssistant, think: "I should look at the pods first.", text: "Checking the cluster.", calls: []parityCall{
			{ID: "oc1", Name: toolTerminal, Args: map[string]any{kCommand: "kubectl get pods -A"}, Result: ok("NAME READY"), DurationMS: 1200},
			{ID: "oc2", Name: toolTerminal, Args: map[string]any{kCommand: "kubectl get nodes"}, Result: ok("node1 Ready"), DurationMS: 800},
		}},
		{role: roleUser, text: "A process you were waiting on finished. Continue your task with its result.\n\n" +
			"`OLD=$(kubectl get pods -A)` (proc_3f2a9c1d0b) exited with code 0 (exited).\nOutput tail:\nNAME READY"},
		{role: roleUser, text: "[Agent message am_0123456789abcdef from build]\nHold the push."},
		{role: roleAssistant, think: "The push is on hold.", text: "Waiting for build."},
		{role: roleUser, text: "The model provider failed: 529 overloaded.", kind: "failed_turn"},
		{role: roleUser, text: gatewaytest.SteerOpen + "\nAlso check the nodes.\n" + gatewaytest.SteerClose, kind: stepSteer},
		{role: roleAssistant, text: "Done. **Two pods** restarted."},
	}
}

// The chat and a subagent's steps in Activity are one view (chatview.js):
// the same rows draw the same DOM in both, for thinking, replies, a group of
// commands, a finished background command, another agent's message, a
// failed turn and the user's steer. run.js drives Chrome on a Pixel-sized
// phone and Firefox on a desktop, one browser at a time.
// ONECHAT_SHOTS=dir (Chrome) saves the chat and the subagent's steps at 412
// and 1280 px, light and dark: onechat-<main|mini>-<w>-<light|dark>.png.
func TestOneChatChrome(t *testing.T) {
	t.Parallel()
	oneChat(t, chromePath(t))
}

func TestOneChatFirefox(t *testing.T) {
	t.Parallel()
	oneChat(t, firefoxPath(t))
}

func oneChat(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	const goal = "Check the cluster"
	rows := []map[string]any{{kRole: roleUser, kText: "go", kTimestamp: 1763000000.0}}
	child := []map[string]any{{kRole: roleUser, keyText: goal, kTimestamp: 1763000000.0}}
	at := 1763000000.0
	for _, s := range oneChatSteps() {
		at += 10
		row := map[string]any{kRole: s.role, kText: s.text, kTimestamp: at}
		kid := map[string]any{kRole: s.role, keyText: s.text, kTimestamp: at}
		if s.kind != "" {
			row[keyDisplayKind] = s.kind
			kid[keyDisplayKind] = s.kind
		}
		if s.think != "" {
			row[ilThink] = s.think
			kid[ilThink] = s.think
		}
		var mainCalls, kidCalls []map[string]any
		for _, c := range s.calls {
			args, err := json.Marshal(c.Args)
			if err != nil {
				t.Fatal(err)
			}
			mainCalls = append(mainCalls, map[string]any{"id": c.ID, fnKey: map[string]any{fieldName: c.Name, ilArgs: string(args)}})
			kidCalls = append(kidCalls, map[string]any{"id": c.ID, fieldName: c.Name, kArgs: c.Args})
		}
		if len(s.calls) > 0 {
			row[kCalls] = mainCalls
			kid[kCalls] = kidCalls
		}
		rows = append(rows, row)
		child = append(child, kid)
		for i, c := range s.calls {
			end := at + float64(i+1)
			res, _ := c.Result.(string)
			meta := map[string]any{keyToolOutcome: map[string]any{keyDurationMS: c.DurationMS, keyIsError: false}}
			rows = append(rows, map[string]any{kRole: stepTool, kCallID: c.ID, fieldName: c.Name, kText: res, kTimestamp: end, keyDisplayMeta: meta})
			child = append(child, map[string]any{kRole: stepTool, fieldName: c.Name, kCallID: c.ID, kTimestamp: end, kArgs: c.Args, sjResult: res,
				keyResultSize: len(res), keyDisplayMeta: meta})
		}
	}
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "One chat", StartedAt: 900, Messages: rows,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.AddChildRows("s9", subA, child...)
	e.gw.SetChildBrief("s9", subA, goal, "")
	// run.js reads ONECHAT_SHOTS from the environment it inherits.
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "onechat", "run.js"), bin, e.url, t.TempDir()).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
