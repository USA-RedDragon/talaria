package web_test

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/scheduled"
	"github.com/USA-RedDragon/talaria/hub/internal/scheduled/scheduledtest"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

// The runs of one scheduled job share one row in Recent, with the count of
// runs not opened and the recent runs under a chevron; a failed run keeps
// its own row. testdata/jobrowsui/run.js drives the real page: Chrome on a
// Pixel-sized phone and Firefox on a desktop. JOBROWS_SHOTS, when set to a
// folder, makes the Chrome run save screenshots there.
func TestJobRunsOneRowChrome(t *testing.T) {
	t.Parallel()
	jobRows(t, chromePath(t))
}

func TestJobRunsOneRowFirefox(t *testing.T) {
	t.Parallel()
	jobRows(t, firefoxPath(t))
}

const (
	jobWatch  = "Chapter watch"
	jobDigest = "Morning digest"
)

func jobRows(t *testing.T, bin string) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	var e *hubEnv
	e = setupWith(t, func(cfg *config.Config, opts *web.Options, _ *store.Store) {
		d := gateway.NewDialer(gateway.Credentials{BaseURL: cfg.Backends[0].URL, Provider: providerBasic, Username: clientID, Password: "pw"})
		opts.Scheduled = scheduled.New(scheduled.Options{Access: lateAccess{&e}, Backends: cfg.Backends,
			Requesters: map[string]scheduled.Requester{"pc": d}})
	})
	dash := scheduledtest.New(e.gw)
	dash.Add(map[string]any{"id": "j1", fieldName: jobWatch, "schedule_display": "every 3 hours"})
	dash.Add(map[string]any{"id": "j2", fieldName: jobDigest, "schedule_display": "every day at 9:00 AM", "last_status": "error", "last_error": "no network"})
	now := time.Now()
	run := func(id string, ago time.Duration) map[string]any {
		at := float64(now.Add(-ago).Unix())
		return map[string]any{"id": id, "source": "cron", "started_at": at, "ended_at": at + 60, "title": jobWatch}
	}
	dash.Runs["j1"] = []map[string]any{run("r4", 1*time.Hour), run("r3", 4*time.Hour), run("r2", 7*time.Hour), run("r1", 10*time.Hour)}
	dash.Runs["j2"] = []map[string]any{run("d2", 2*time.Hour), run("d1", 26*time.Hour)}
	for id, ago := range map[string]time.Duration{"r1": 10 * time.Hour, "r2": 7 * time.Hour, "r3": 4 * time.Hour, "r4": time.Hour, "d1": 26 * time.Hour, "d2": 2 * time.Hour} {
		title := jobWatch
		if id[0] == 'd' {
			title = jobDigest
		}
		e.gw.AddSession(&gatewaytest.Session{ID: id, Title: title, Live: true, Source: "cron",
			StartedAt: float64(now.Add(-ago).Unix()),
			Messages:  []map[string]any{{kRole: roleUser, kText: "go"}, {kRole: roleAssistant, kText: "done " + id}}})
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "plain", Title: "Plain chat", Live: true, StartedAt: float64(now.Add(-2 * time.Hour).Unix()),
		Messages: []map[string]any{{kRole: roleUser, kText: "hi"}, {kRole: roleAssistant, kText: "hi there"}}})
	// None of the run chats has been opened.
	api := client(t)
	m := login(t, e, api)
	for _, id := range []string{"r1", "r2", "r3", "r4", "d1", "d2"} {
		if s := apiJSON(t, api, http.MethodPost, e.url+"/api/sessions/pc/"+id+"/read", m.CSRF, map[string]bool{"unread": true}, nil); s != http.StatusNoContent {
			t.Fatalf("mark %s unread = %d", id, s)
		}
	}
	prof := t.TempDir()
	args := []string{filepath.Join("testdata", "jobrowsui", "run.js"), bin, e.url, prof}
	cmd := browserCmd(t.Context(), t, node, args...)
	if shots := os.Getenv("JOBROWS_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "JOBROWS_SHOTS="+shots)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
