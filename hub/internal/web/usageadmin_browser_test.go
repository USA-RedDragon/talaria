package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/claude"
	"github.com/USA-RedDragon/talaria/hub/internal/claude/claudetest"
	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

// A user who is a Claude admin of a backend they may not use opens its
// Usage page: only the Claude accounts panel, and the sign-in works.
// testdata/usageadmin/run.js drives the real page in Chrome on a
// Pixel-sized phone. USAGEADMIN_SHOTS, when set to a folder, makes it save
// screenshots there.
func TestUsageAdminWithoutAccessChrome(t *testing.T) {
	t.Parallel()
	bin := chromePath(t)
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	var e *hubEnv
	e = setupWith(t, func(cfg *config.Config, opts *web.Options, _ *store.Store) {
		cfg.Backends[0].Users = []string{userAlice}
		cfg.Claude.Admins = []string{"bob=pc"}
		admins, _ := cfg.Claude.AdminMap()
		d := gateway.NewDialer(gateway.Credentials{BaseURL: cfg.Backends[0].URL, Provider: providerBasic, Username: clientID, Password: "pw"})
		opts.Claude = claude.New(claude.Options{Access: lateAccess{&e}, Admins: admins, Requesters: map[string]device.Requester{"pc": d},
			Names: map[string]string{"pc": "Kittykat"}})
		opts.Insights, opts.Files = fakeInsights{}, fakeFiles{}
	})
	claudetest.New(e.gw).SetLoggedIn("account1", true, "kat@example.com")
	// bob is in no group: he uses no backend.
	e.is.as("sub-bob", userBob, "guests")
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "usageadmin", "run.js"), bin, e.url, t.TempDir())
	if shots := os.Getenv("USAGEADMIN_SHOTS"); shots != "" {
		cmd.Env = append(os.Environ(), "USAGEADMIN_SHOTS="+shots)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
