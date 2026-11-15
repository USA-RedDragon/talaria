//go:build linux

// Package restarte2e_test restarts and updates a real talaria run in the
// middle of agent commands, end to end: talaria run under a systemd user
// service of its own (not talaria.service), with its own config and state
// directory, connects through a relay that plays the hub to the real
// device plugin exec route, served by uvicorn in the Hermes runtime
// (plugin/device/tests/test_restart_e2e.py). The plugin starts commands,
// this test restarts the service with systemctl and then updates it to
// another build, and the plugin checks that every command's output and
// exit code arrive whole. It runs only with TALARIA_RESTART_E2E=1, hermes
// on PATH and a systemd user manager. TALARIA_E2E_BIN_A and
// TALARIA_E2E_BIN_B name the two builds; by default it builds this tree
// twice.
package restarte2e_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/assertion"
	"github.com/USA-RedDragon/talaria/internal/hubapi"
	"github.com/USA-RedDragon/talaria/internal/tokenstore"
	"github.com/USA-RedDragon/talaria/protocol"
	"github.com/coder/websocket"
)

const (
	backendID = "alice"
	deviceID  = "d_e2e"
)

// relay plays the hub: it takes the daemon's exec leg with the device
// token and opens one to the plugin with a fresh hub assertion, then
// copies messages both ways. A hop that ends without a close frame ends
// the other with 1001, as the hub does.
type relay struct {
	plugin string
	bearer string
	key    ed25519.PrivateKey
}

func (r relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	if req.URL.Path != hubapi.PathExecLeg || req.Header.Get("Authorization") != "Bearer "+r.bearer {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	now := time.Now()
	tok, err := assertion.Sign(r.key, assertion.Claims{
		Aud: backendID, Leg: assertion.LegExec, Method: http.MethodGet, Path: protocol.PluginExecPath,
		Sub: "alice", DeviceID: deviceID, DeviceName: "e2e", IssuedAt: now.Unix(), Expires: now.Add(30 * time.Second).Unix(),
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	hdr := http.Header{}
	hdr.Set(assertion.Header, tok)
	ctx := req.Context()
	up, _, err := websocket.Dial(ctx, r.plugin+protocol.PluginExecPath, &websocket.DialOptions{HTTPHeader: hdr})
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer func() { _ = up.CloseNow() }()
	up.SetReadLimit(64 << 20)
	down, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	defer func() { _ = down.CloseNow() }()
	down.SetReadLimit(64 << 20)
	done := make(chan struct{}, 2)
	pump := func(src, dst *websocket.Conn) {
		defer func() { done <- struct{}{} }()
		for {
			typ, data, err := src.Read(ctx)
			if err != nil {
				code := websocket.CloseStatus(err)
				if code == -1 || code == websocket.StatusNoStatusRcvd || code == websocket.StatusAbnormalClosure {
					code = websocket.StatusGoingAway
				}
				_ = dst.Close(code, "relay: other hop ended")
				return
			}
			if err := dst.Write(ctx, typ, data); err != nil {
				_ = src.Close(websocket.StatusGoingAway, "relay: other hop ended")
				return
			}
		}
	}
	go pump(down, up)
	go pump(up, down)
	<-done
}

// harness is one run of the test: the plugin side, the relay, and the
// daemon's service.
type harness struct {
	t      *testing.T
	ctx    context.Context //nolint:containedctx // the test's deadline
	dir    string
	root   string
	state  string
	repo   string
	target string
	unit   string
	pyOut  *syncBuilder
	pyDone chan error
}

// command runs program, which is configuration of the test, with args.
func command(ctx context.Context, program string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, program)
	cmd.Args = append(cmd.Args, args...)
	return cmd
}

func (h *harness) systemctl(args ...string) string {
	h.t.Helper()
	out, err := command(h.ctx, "systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
	if err != nil {
		h.t.Logf("systemctl %v: %v: %s", args, err, out)
	}
	return string(out)
}

func (h *harness) mainPID() int {
	h.t.Helper()
	pid, _ := strconv.Atoi(strings.TrimSpace(h.systemctl("show", "--property=MainPID", "--value", h.unit)))
	return pid
}

func (h *harness) build(out, version string) {
	h.t.Helper()
	cmd := command(h.ctx, "go", "build", "-o", out, "-ldflags", "-X main.version="+version, ".")
	cmd.Dir = h.repo
	if b, err := cmd.CombinedOutput(); err != nil {
		h.t.Fatalf("build %s: %v\n%s", version, err, b)
	}
}

// binary is the build named by env, or this tree built as version.
func (h *harness) binary(env, version string) string {
	h.t.Helper()
	if p := os.Getenv(env); p != "" {
		return filepath.Clean(p)
	}
	p := filepath.Join(h.dir, "talaria-"+version)
	h.build(p, version)
	return p
}

// install puts bin at the service's binary the way an update does: a copy
// next to it, then a rename over it.
func (h *harness) install(bin string) {
	h.t.Helper()
	data, err := os.ReadFile(filepath.Clean(bin))
	if err != nil {
		h.t.Fatal(err)
	}
	root, err := os.OpenRoot(filepath.Dir(h.target))
	if err != nil {
		h.t.Fatal(err)
	}
	defer root.Close()
	name := filepath.Base(h.target)
	if err := root.WriteFile(name+".new", data, 0o600); err != nil {
		h.t.Fatal(err)
	}
	if err := root.Chmod(name+".new", 0o700); err != nil {
		h.t.Fatal(err)
	}
	if err := root.Rename(name+".new", name); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) waitFile(name string) string {
	h.t.Helper()
	path := filepath.Join(h.dir, name)
	for {
		if b, err := os.ReadFile(path); err == nil {
			return string(b)
		}
		select {
		case err := <-h.pyDone:
			h.t.Fatalf("plugin side ended while waiting for %s: %v\n%s", name, err, h.pyOut)
		case <-h.ctx.Done():
			h.t.Fatalf("timed out waiting for %s\n%s", name, h.pyOut)
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// startPlugin runs the plugin side and returns its port.
func (h *harness) startPlugin(pub ed25519.PublicKey) string {
	h.t.Helper()
	py := command(h.ctx, "sh", "scripts/test-plugin.sh",
		"-s", "plugin/device/tests", "-t", "plugin/device/tests", "-p", "test_restart_e2e.py", "-v")
	py.Dir = h.repo
	py.Env = append(os.Environ(), "HERMES_RESTART_E2E_DIR="+h.dir, "HERMES_RESTART_E2E_ROOT="+h.root,
		"HERMES_RESTART_E2E_KEY="+base64.StdEncoding.EncodeToString(pub))
	py.Stdout, py.Stderr = h.pyOut, h.pyOut
	if err := py.Start(); err != nil {
		h.t.Fatal(err)
	}
	go func() { h.pyDone <- py.Wait() }()
	return strings.TrimSpace(h.waitFile("port"))
}

// startRelay serves the relay to the plugin on port and returns its
// address.
func (h *harness) startRelay(port, bearer string, key ed25519.PrivateKey) string {
	h.t.Helper()
	var lc net.ListenConfig
	ln, err := lc.Listen(h.ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		h.t.Fatal(err)
	}
	srv := &http.Server{Handler: relay{plugin: "ws://127.0.0.1:" + port, bearer: bearer, key: key}, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	h.t.Cleanup(func() { _ = srv.Close() })
	return ln.Addr().String()
}

// startService writes the daemon's config and a systemd user unit with
// the [Service] lines that talaria setup writes, links the unit for this
// login only, and starts it.
func (h *harness) startService(hub, bearer string) {
	h.t.Helper()
	// A device that logged in: its token in the state directory's token
	// file, as talaria login saves it without a keyring.
	if _, err := tokenstore.New(false, filepath.Join(h.state, "token")).Save(tokenstore.Record{
		Hub: "http://" + hub, Token: bearer, DeviceID: deviceID, DeviceName: "e2e", Backend: backendID,
	}); err != nil {
		h.t.Fatal(err)
	}
	cfgFile := filepath.Join(h.dir, "config.yaml")
	cfg := fmt.Sprintf(`log-level: debug
hub:
  url: http://%s
store:
  state-dir: %s
  keyring: false
device:
  roots: [%s]
gateway:
  splice: false
update:
  auto: false
usage:
  enabled: false
browser:
  enabled: false
reconnect:
  min-backoff: 200ms
  max-backoff: 2s
`, hub, h.state, h.root)
	if err := os.WriteFile(cfgFile, []byte(cfg), 0o600); err != nil {
		h.t.Fatal(err)
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	h.unit = "talaria-e2e-" + hex.EncodeToString(rnd[:]) + ".service"
	unitFile := filepath.Join(h.dir, h.unit)
	content := "[Unit]\nDescription=talaria restart e2e test\n\n[Service]\nExecStart=" + h.target + " run -c " + cfgFile +
		"\nRestart=always\nRestartSec=5\nOOMPolicy=continue\n"
	if err := os.WriteFile(unitFile, []byte(content), 0o600); err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() {
		h.ctx = context.Background()
		h.systemctl("stop", h.unit)
		killLeft(h.t, filepath.Join(h.state, "commands"))
		h.systemctl("disable", "--runtime", h.unit)
		h.systemctl("daemon-reload")
	})
	// A runtime link: the unit is gone at the next login at the latest.
	h.systemctl("link", "--runtime", unitFile)
	h.systemctl("daemon-reload")
	h.systemctl("start", h.unit)
}

// restart restarts the service as talaria update does after it installed
// a new binary.
func (h *harness) restart(what string) {
	h.t.Helper()
	before := h.mainPID()
	h.systemctl("restart", h.unit)
	h.t.Logf("%s %s: pid %d -> %d", what, h.unit, before, h.mainPID())
}

func (h *harness) report() {
	h.t.Helper()
	h.t.Logf("plugin side:\n%s", h.pyOut)
	if logs, err := command(h.ctx, "journalctl", "--user", "-u", h.unit, "--no-pager", "-o", "cat").CombinedOutput(); err == nil {
		h.t.Logf("daemon log:\n%s", tail(string(logs), 80))
	}
	res, err := os.ReadFile(filepath.Join(h.dir, "result.json"))
	if err != nil {
		return
	}
	var r map[string]struct {
		Code   int    `json:"code"`
		Output string `json:"output"`
	}
	_ = json.Unmarshal(res, &r)
	for name, v := range r {
		h.t.Logf("%s: exit %d, %d bytes, last line %q", name, v.Code, len(v.Output), lastLine(v.Output))
	}
}

// checkScope checks that the command pid runs in a scope of its own that
// is not part of the daemon's service.
func (h *harness) checkScope(pid int) {
	h.t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cgroup", pid))
	if err != nil {
		h.t.Errorf("command %d: %v", pid, err)
		return
	}
	scope := filepath.Base(strings.TrimSpace(string(data)))
	if !strings.HasPrefix(scope, "talaria-cmd-") || !strings.HasSuffix(scope, ".scope") {
		h.t.Logf("command %d runs in %s, not in a scope of its own (no systemd-run?)", pid, scope)
		return
	}
	partOf := strings.TrimSpace(h.systemctl("show", "--property=PartOf", "--value", scope))
	h.t.Logf("command %d runs in %s, PartOf=%q", pid, scope, partOf)
	if partOf != "" {
		h.t.Errorf("the command's scope is part of %s", partOf)
	}
}

func alive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }

func TestRestartAndUpdateKeepCommands(t *testing.T) { //nolint:paralleltest // one plugin server and unit at a time
	if os.Getenv("TALARIA_RESTART_E2E") != "1" {
		t.Skip("set TALARIA_RESTART_E2E=1 to restart a real talaria run under systemd")
	}
	if _, err := exec.LookPath("hermes"); err != nil {
		t.Skip("hermes is not on PATH; the plugin needs the Hermes runtime")
	}
	if os.Getenv("XDG_RUNTIME_DIR") == "" {
		t.Skip("no XDG_RUNTIME_DIR, so no systemd user manager")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	dir := t.TempDir()
	h := &harness{t: t, ctx: ctx, dir: dir, root: filepath.Join(dir, "root"), state: filepath.Join(dir, "state"),
		target: filepath.Join(dir, "bin", "talaria"), pyOut: &syncBuilder{}, pyDone: make(chan error, 1)}
	for _, d := range []string{h.root, h.state, filepath.Dir(h.target)} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	repo, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	h.repo = repo
	binA, binB := h.binary("TALARIA_E2E_BIN_A", "e2e-a"), h.binary("TALARIA_E2E_BIN_B", "e2e-b")

	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var tb [16]byte
	_, _ = rand.Read(tb[:])
	bearer := "hdt_" + hex.EncodeToString(tb[:])
	port := h.startPlugin(pub)
	hub := h.startRelay(port, bearer, key)
	h.install(binA)
	h.startService(hub, bearer)
	t.Logf("started %s (pid %d) with %s", h.unit, h.mainPID(), binA)

	victim, _ := strconv.Atoi(strings.TrimSpace(h.waitFile("started")))
	h.checkScope(victim)
	time.Sleep(2 * time.Second)
	h.restart("restarted")
	h.waitFile("connected-1")
	if !alive(victim) {
		t.Errorf("command %d did not survive the restart", victim)
	}
	time.Sleep(2 * time.Second)
	h.install(binB)
	h.restart("updated to " + binB + ":")
	version := h.waitFile("connected-2")

	var pyErr error
	select {
	case pyErr = <-h.pyDone:
	case <-ctx.Done():
		pyErr = ctx.Err()
	}
	h.report()
	if os.Getenv("TALARIA_E2E_BIN_B") == "" && !strings.Contains(version, "e2e-b") {
		t.Errorf("after the update the daemon reports version %q", version)
	}
	if pyErr != nil {
		t.Fatalf("plugin side failed: %v", pyErr)
	}
	deadline := time.Now().Add(10 * time.Second)
	for alive(victim) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if alive(victim) {
		t.Errorf("killed command %d still runs", victim)
	}
}

type syncBuilder struct {
	mu sync.Mutex
	sb strings.Builder
}

func (s *syncBuilder) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sb.Write(p)
}

func (s *syncBuilder) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sb.String()
}

// killLeft kills the holders and commands this test's daemons left in the
// spool, by the pids they recorded.
func killLeft(t *testing.T, spool string) {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(spool, "*", "pid"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		fields := strings.Fields(string(b))
		if len(fields) != 2 {
			continue
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(f), "exit.json")); err == nil {
			continue
		}
		holder, _ := strconv.Atoi(fields[0])
		shell, _ := strconv.Atoi(fields[1])
		if shell > 0 && syscall.Kill(-shell, syscall.SIGKILL) == nil {
			t.Logf("killed the left command group %d", shell)
		}
		if holder > 0 && syscall.Kill(holder, syscall.SIGKILL) == nil {
			t.Logf("killed the left holder %d", holder)
		}
	}
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func lastLine(s string) string {
	s = strings.TrimRight(s, "\n")
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return s[i+1:]
	}
	return s
}
