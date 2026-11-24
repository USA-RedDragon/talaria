//go:build unix

package firefoxtest_test

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// desktopE2E reports whether the end-to-end tests run Firefox on the
// desktop session (HERMES_BROWSER_E2E_DESKTOP=1) instead of headless, for
// window states a headless Firefox does not have.
func desktopE2E() bool { return os.Getenv("HERMES_BROWSER_E2E_DESKTOP") == "1" }

// TestFirefoxDesktopMinimizedLogin signs in from a tab whose window the
// compositor minimized. On Wayland Firefox is not told about that: the
// extension sees the window as normal or maximized, the page stays hidden,
// and Firefox does not fill saved logins in a hidden page. It needs a KDE
// Plasma session (kdotool) and HERMES_BROWSER_E2E_DESKTOP=1.
func TestFirefoxDesktopMinimizedLogin(t *testing.T) { //nolint:paralleltest // one Firefox at a time
	if os.Getenv("HERMES_BROWSER_E2E") != "1" || !desktopE2E() {
		t.Skip("set HERMES_BROWSER_E2E=1 and HERMES_BROWSER_E2E_DESKTOP=1 in a desktop session")
	}
	if _, err := exec.LookPath("kdotool"); err != nil {
		t.Skip("kdotool is not installed")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	_, bc, gr := startFirefoxGrants(ctx, t)
	password := "pw-" + rand.Text()
	caDER, cert := testCA(t, loginHost)
	main := &loginServer{}
	mainSrv := serveTLSOn(ctx, t, loginHost, cert, main.handler(""))
	seedLogins(ctx, t, bc, caDER, [][3]string{{mainSrv.URL, loginUser, password}})
	rig := &loginRig{r: &recorded{b: gr.gate}, main: main, mainURL: mainSrv.URL}

	pid, err := strconv.Atoi(chromeEval(ctx, t, bc, "Services.appinfo.processID"))
	if err != nil {
		t.Fatal(err)
	}
	minimizeFirefox(ctx, t, pid)
	time.Sleep(3 * time.Second)
	tab := rig.open(ctx, t, mainSrv.URL+"/")
	time.Sleep(5 * time.Second)

	res := rig.login(ctx, t, map[string]any{keyTab: tab.TabID, keyGuard: approve(loginHost), keyTimeout: 10000})
	t.Logf("login from a minimized window: %+v", res)
	if !res.Filled || !res.Submitted || res.Reason != "" || res.ShownBy == "" {
		t.Errorf("login from a minimized window = %+v", res)
	}
	// The tab is the agent's again (its group was the tab alone, so the
	// group is a new one), and the window it used is gone.
	var list struct {
		Tabs []struct {
			TabID int  `json:"tab_id"`
			Agent bool `json:"agent"`
		} `json:"tabs"`
	}
	rig.r.must(ctx, t, "tabs_list", map[string]any{}, &list)
	back := false
	for _, x := range list.Tabs {
		back = back || x.TabID == tab.TabID && x.Agent
	}
	if !back {
		t.Errorf("after the login tab %d is not in the Talaria tab group: %+v", tab.TabID, list.Tabs)
	}
	if n := chromeEval(ctx, t, bc, `[...Services.wm.getEnumerator("navigator:browser")].length`); n != "1" {
		t.Errorf("browser windows after the login = %s, want 1", n)
	}
	want := "POST user=" + url.QueryEscape(loginUser) + "&pass=" + url.QueryEscape(password)
	if got := main.got(); len(got) != 1 || got[0] != want {
		t.Errorf("login server got %d posts", len(got))
	}
	for _, out := range rig.r.out {
		if strings.Contains(out, password) {
			t.Errorf("a browser answer holds the password")
		}
	}
}

// minimizeFirefox minimizes the windows of the test's Firefox, which is the
// process given by pid, through a KWin script that matches the window's pid
// exactly, so no other window of the session changes.
func minimizeFirefox(ctx context.Context, t *testing.T, pid int) {
	t.Helper()
	dir := t.TempDir()
	tag := "hxmin" + strconv.Itoa(pid)
	script := dir + "/min.js"
	js := `const ws = workspace.stackingOrder; let n = 0;
for (let i = 0; i < ws.length; i++) { if (ws[i].pid === ` + strconv.Itoa(pid) + ` && ws[i].normalWindow) { ws[i].minimized = true; n++; } }
print("` + tag + ` " + n);`
	if err := os.WriteFile(script, []byte(js), 0o600); err != nil {
		t.Fatal(err)
	}
	q := func(args ...string) string {
		out, err := exec.CommandContext(ctx, "qdbus6", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("qdbus6 %v: %v %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	since := time.Now().Add(-time.Second).Format("2006-01-02 15:04:05")
	id := q("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", script, tag)
	q("org.kde.KWin", "/Scripting/Script"+id, "org.kde.kwin.Script.run")
	q("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", tag)
	time.Sleep(time.Second)
	out, _ := exec.CommandContext(ctx, "journalctl", "--user", "--since", since, "-o", "cat").Output()
	n := ""
	for _, line := range strings.Split(string(out), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), tag+" "); ok {
			n = rest
		}
	}
	if n == "" || n == "0" {
		t.Fatalf("minimized %q windows of firefox pid %d", n, pid)
	}
	t.Logf("minimized %s window(s) of firefox pid %d", n, pid)
}
