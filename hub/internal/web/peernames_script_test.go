package web_test

import (
	"encoding/json"
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
	const sessionJSON = `[
 {"role":"user","text":"tell them","timestamp":1763000000},
 {"role":"assistant","text":"Sending.","timestamp":1763000000,"tool_calls":[
  {"id":"c1","function":{"name":"agent_send","arguments":"{\"to\":\"sa-0-edd20c0e\",\"text\":\"status?\"}"}},
  {"id":"c2","function":{"name":"agent_send","arguments":"{\"to\":\"sa-0-ffff0000\",\"text\":\"status?\"}"}},
  {"id":"c3","function":{"name":"agent_send","arguments":"{\"to\":\"parent\",\"text\":\"status?\"}"}},
  {"id":"c4","function":{"name":"agent_send","arguments":"{\"to\":\"20261112_103549_47fb42\",\"text\":\"status?\"}"}}]},
 {"role":"tool","tool_call_id":"c1","name":"agent_send","text":"{\"message_id\": \"am_0123456789abcdef\", \"to\": \"subagent sa-0-edd20c0e\", \"delivery\": \"steered\"}"},
 {"role":"tool","tool_call_id":"c2","name":"agent_send","text":"{\"message_id\": \"am_0123456789abcdef\", \"to\": \"subagent sa-0-ffff0000\", \"delivery\": \"steered\"}"},
 {"role":"tool","tool_call_id":"c3","name":"agent_send","text":"{\"message_id\": \"am_0123456789abcdef\", \"to\": \"parent\", \"delivery\": \"steered\"}"},
 {"role":"tool","tool_call_id":"c4","name":"agent_send","text":"{\"message_id\": \"am_0123456789abcdef\", \"to\": \"chat 'Other chat' (session 20261112_103549_47fb42)\", \"delivery\": \"queued\"}"},
 {"role":"assistant","text":"Noting it.","timestamp":1763000000,"tool_calls":[
  {"id":"l1","function":{"name":"ledger","arguments":"{\"action\":\"add\",\"kind\":\"note\",\"text\":\"x\"}"}},
  {"id":"l2","function":{"name":"ledger","arguments":"{\"action\":\"list\"}"}},
  {"id":"l3","function":{"name":"clarify","arguments":"{\"question\":\"ok?\"}"}}]},
 {"role":"tool","tool_call_id":"l1","name":"ledger","text":"{\"ok\": true, \"id\": \"L1\"}"},
 {"role":"tool","tool_call_id":"l2","name":"ledger","text":"{\"entries\": []}"},
 {"role":"tool","tool_call_id":"l3","name":"clarify","text":"{\"user_response\": \"yes\"}"},
 {"role":"assistant","text":"Again.","timestamp":1763000000,"tool_calls":[{"id":"l4","function":{"name":"ledger","arguments":"{\"action\":\"close\",\"id\":\"L1\"}"}}]},
 {"role":"tool","tool_call_id":"l4","name":"ledger","text":"{\"ok\": true}"},
 {"role":"assistant","text":"Once more.","timestamp":1763000000,"tool_calls":[{"id":"l5","function":{"name":"ledger","arguments":"{\"action\":\"close\",\"id\":\"L9\"}"}}]},
 {"role":"tool","tool_call_id":"l5","name":"ledger","text":"{\"error\": \"no such entry L9\"}"},
 {"role":"user","text":"[Agent message am_00000000000000cc from subagent sa-0-edd20c0e (goal: relift lane android-apk: rebuild the APK and sign it with the...) of chat 'Names' (session s9)]\n\nHalf done: the APK builds.","timestamp":1763000001},
 {"role":"user","text":"[Agent message am_00000000000000ce from chat sa-0-edd20c0e]\n\nOld style label.","timestamp":1763000002},
 {"role":"user","text":"[Agent message am_00000000000000cf from subagent sa-0-ffff0000 (goal: measure the antenna) of chat 'Other chat' (session 20261112_103549_47fb42)]\n\nA subagent of another chat.","timestamp":1763000003},
 {"role":"user","text":"[Agent message am_00000000000000cd from parent]\n\nStop and report.","timestamp":1763000004}]`
	var msgs []map[string]any
	if err := json.Unmarshal([]byte(sessionJSON), &msgs); err != nil {
		t.Fatal(err)
	}
	var other []map[string]any
	if err := json.Unmarshal([]byte(`[{"role":"user","text":"hi","timestamp":1763000000}]`), &other); err != nil {
		t.Fatal(err)
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Names", Live: true, StartedAt: 900, Messages: msgs,
		Subagents: []gateway.SubagentRow{{SubagentID: "sa-0-edd20c0e", Goal: goal, Status: optr(statusRunning), AcceptingSteer: optr(true)}}})
	e.gw.AddSession(&gatewaytest.Session{ID: "20261112_103549_47fb42", Title: "Other chat", Live: true, StartedAt: 800, Messages: other})
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
