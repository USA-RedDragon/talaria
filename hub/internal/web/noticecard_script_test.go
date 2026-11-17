package web_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// A finished subagent's notice, in the formats Hermes writes them (a batch,
// one of a batch, a resumed subagent, with and without its goal; made with
// Hermes' own formatter), is a card with a title in words and a status line
// that never breaks inside a word, at 412 and 1280 px.
// NOTICE_SHOTS=dir saves each card's PNG there.
func TestNoticeCardChrome(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	raw, err := os.ReadFile(filepath.Join("testdata", "noticecard", "notices.json"))
	if err != nil {
		t.Fatal(err)
	}
	var list []struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	msgs := make([]map[string]any, 0, 2*len(list)+1)
	msgs = append(msgs, map[string]any{kRole: roleUser, kText: "go", kTimestamp: 1763000000.0})
	for i, n := range list {
		msgs = append(msgs,
			map[string]any{kRole: roleUser, kText: n.Text, "display_kind": "async_delegation_complete", kTimestamp: 1763000100.0 + float64(i)},
			map[string]any{kRole: roleAssistant, kText: textOnIt, kTimestamp: 1763000101.0 + float64(i)})
	}
	e := setup(t)
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Notices", Live: true, StartedAt: 900, Messages: msgs})
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "noticecard", "run.js"), chrome, e.url, t.TempDir(), string(raw))
	cmd.Env = append(os.Environ(), "SHOT_DIR="+os.Getenv("NOTICE_SHOTS"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
