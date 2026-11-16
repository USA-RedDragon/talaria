package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// An agent_send card and an agent message card name the other end in words:
// a subagent by its goal, a chat by its title, the parent as "the parent",
// never "subagent subagent sa-...". testdata/peernames/run.js drives the real
// page in headless Chrome, phone and desktop, light and dark, and checks
// the names after a reload and a chat switch. PEERNAMES_SHOT=prefix writes
// screenshots.
func TestPeerNamesInAgentCards(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	goal := "relift lane android-apk: rebuild the APK and sign it with the release key, then upload the result to the share\nSecond line of the brief."
	call := func(id, to string) map[string]any {
		return map[string]any{"id": id, "function": map[string]any{"name": "agent_send", "arguments": `{"to":"` + to + `","text":"status?"}`}}
	}
	res := func(id, to string) map[string]any {
		return map[string]any{"role": "tool", "tool_call_id": id, "name": "agent_send", "timestamp": 1763000000.0,
			"text": `{"message_id": "am_0123456789abcdef", "to": "` + to + `", "delivery": "steered into the subagent: it reads it after its current step"}`}
	}
	tc := func(id, name, args string) map[string]any {
		return map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": args}}
	}
	tr := func(id, name, text string) map[string]any {
		return map[string]any{"role": "tool", "tool_call_id": id, "name": name, "timestamp": 1763000000.0, "text": text}
	}
	msgs := []map[string]any{
		{"role": "user", "text": "tell them", "timestamp": 1763000000.0},
		{"role": "assistant", "text": "Sending.", "timestamp": 1763000000.0, "tool_calls": []map[string]any{
			call("c1", "sa-0-edd20c0e"), call("c2", "sa-0-ffff0000"), call("c3", "parent"), call("c4", "20261112_103549_47fb42"),
		}},
		res("c1", "subagent sa-0-edd20c0e"), res("c2", "subagent sa-0-ffff0000"), res("c3", "parent"), res("c4", "chat 'Other chat' (session 20261112_103549_47fb42)"),
		// The ledger is the agent's notebook: calls that worked show no card.
		{"role": "assistant", "text": "Noting it.", "timestamp": 1763000000.0, "tool_calls": []map[string]any{
			tc("l1", "ledger", `{"action":"add","kind":"note","text":"x"}`), tc("l2", "ledger", `{"action":"list"}`), tc("l3", "clarify", `{"question":"ok?"}`),
		}},
		tr("l1", "ledger", `{"ok": true, "id": "L1"}`), tr("l2", "ledger", `{"entries": []}`), tr("l3", "clarify", `{"user_response": "yes"}`),
		{"role": "assistant", "text": "Again.", "timestamp": 1763000000.0, "tool_calls": []map[string]any{tc("l4", "ledger", `{"action":"close","id":"L1"}`)}},
		tr("l4", "ledger", `{"ok": true}`),
		{"role": "assistant", "text": "Once more.", "timestamp": 1763000000.0, "tool_calls": []map[string]any{tc("l5", "ledger", `{"action":"close","id":"L9"}`)}},
		tr("l5", "ledger", `{"error": "no such entry L9"}`),
		{"role": "user", "text": "[Agent message am_00000000000000cc from chat sa-0-edd20c0e]\n\nHalf done: the APK builds.", "timestamp": 1763000001.0},
		{"role": "user", "text": "[Agent message am_00000000000000cd from parent]\n\nStop and report.", "timestamp": 1763000002.0},
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Names", Live: true, StartedAt: 900, Messages: msgs,
		Subagents: []gateway.SubagentRow{{SubagentID: "sa-0-edd20c0e", Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.AddSession(&gatewaytest.Session{ID: "20261112_103549_47fb42", Title: "Other chat", Live: true, StartedAt: 800,
		Messages: []map[string]any{{"role": "user", "text": "hi", "timestamp": 1763000000.0}}})
	prof, err := os.MkdirTemp("", "peernames-profile-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(prof) })
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "peernames", "run.js"), chrome, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
