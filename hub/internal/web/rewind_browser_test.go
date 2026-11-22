package web_test

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

const rowKindMessage = "message"

// gwInsights lists the rows that the fake gateway's rewinds took back, as
// the device plugin lists the rows Hermes hid.
type gwInsights struct {
	fakeInsights
	gw *gatewaytest.Gateway
}

func (g *gwInsights) Rewound(_ context.Context, user, _, sid string) (hub.Rewound, error) {
	if user != userAlice {
		return hub.Rewound{}, hub.ErrForbidden
	}
	var out hub.Rewound
	var group hub.RewoundGroup
	for _, m := range g.gw.RewoundRows(sid) {
		raw, err := json.Marshal(map[string]any{"row_kind": rowKindMessage, keyRowID: m[keyRowID], kRole: m[kRole], keyText: m[kText], "timestamp": 1.7e9})
		if err != nil {
			return hub.Rewound{}, err
		}
		id, _ := m[keyRowID].(int64)
		if group.Count == 0 {
			group.FirstRowID = id
		}
		group.LastRowID = id
		group.Count++
		group.Rows = append(group.Rows, raw)
	}
	if group.Count > 0 {
		out.Groups = []hub.RewoundGroup{group}
	}
	return out, nil
}

// Rewinding a chat to an earlier message of the user hides that message
// and the ones after it, shows a line where they were with a Show button,
// puts the message back in the box and leaves the running subagent and
// command alone. testdata/rewind/run.js drives the real page: Chrome on a
// Pixel-sized phone and Firefox on a desktop. REWIND_SHOTS, when set to a
// folder, makes the Chrome run save screenshots there.
func TestRewindToHereChrome(t *testing.T) {
	t.Parallel()
	rewindToHere(t, chromePath(t))
}

func TestRewindToHereFirefox(t *testing.T) {
	t.Parallel()
	rewindToHere(t, firefoxPath(t))
}

func rewindToHere(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	ins := &gwInsights{}
	e := setupWith(t, func(_ *config.Config, opts *web.Options, _ *store.Store) { opts.Insights = ins })
	ins.gw = e.gw
	ago := func(d time.Duration) *float64 { return todoPtr(float64(time.Now().Add(-d).Unix())) }
	e.gw.AddSession(&gatewaytest.Session{ID: "s1", Title: "Light culling", Live: true, StartedAt: 900, Model: "opus-5.5", Messages: []map[string]any{
		{kRole: roleUser, kText: "Port the light-culling pass to the new compute queue", keyRowID: 1},
		{kRole: roleAssistant, kText: "Sure, starting with the compute ordering.", keyRowID: 2},
		{kRole: roleUser, kText: "Now also check the shadow cascades", keyRowID: 3},
		{kRole: roleAssistant, kText: "The cascades split correctly.", keyRowID: 4},
		{kRole: roleUser, kText: "Add a test for the cascade split", keyRowID: 5},
		{kRole: roleAssistant, kText: "Added the test.", keyRowID: 6}},
		Subagents: []gateway.SubagentRow{{SubagentID: "sa-light", Goal: "profile the light pass", Status: todoPtr(statusRunning), AcceptingSteer: todoPtr(true), StartedAt: ago(12 * time.Minute)}},
		Processes: []gateway.ProcessRow{{SessionID: "proc_sleep", Command: "sleep 900", Status: statusRunning, StartedEpoch: ago(6 * time.Minute)}}})
	e.gw.SetTodos("s1", todoPlan(), false)
	e.gw.AddSession(&gatewaytest.Session{ID: "s2", Title: "Busy chat", Live: true, StartedAt: 800, Messages: []map[string]any{
		{kRole: roleUser, kText: "Start the long build"}, {kRole: roleAssistant, kText: "Building."}, {kRole: roleUser, kText: "And then deploy"}},
		Pending: []gateway.PendingAdmission{{AdmissionID: "adm-1", Sequence: 1, Status: "queued", Text: "And then deploy"}}})
	prof := t.TempDir()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "rewind", "run.js"), bin, e.url, prof)
	if shots := os.Getenv("REWIND_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "REWIND_SHOTS="+shots)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
