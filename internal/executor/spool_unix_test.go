//go:build unix

package executor_test

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/executor"
)

// TestMain runs this test binary as the command holder when the spool
// starts it so.
func TestMain(m *testing.M) {
	if dir, ok := executor.HolderInvocation(os.Args); ok {
		os.Exit(executor.RunHolder(dir))
	}
	os.Exit(m.Run())
}

func newSpool(t *testing.T, dir string, scope *executor.Scope) *executor.Spool {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sp, err := executor.NewSpool(dir, exe, scope)
	if err != nil {
		t.Fatal(err)
	}
	return sp
}

// collector gathers output from the tail goroutine.
type collector struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (c *collector) write(b []byte) {
	c.mu.Lock()
	c.buf.Write(b)
	c.mu.Unlock()
}

func (c *collector) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitResult(t *testing.T, p *executor.Process) executor.Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	res, err := p.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func adoptOne(t *testing.T, sp *executor.Spool, id string) executor.Adoptable {
	t.Helper()
	list := sp.Adoptable()
	if len(list) != 1 || list[0].ID != id {
		t.Fatalf("adoptable = %+v, want one with id %q", list, id)
	}
	return list[0]
}

const startedLine = "started\n"

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestSpoolOutputAndExit(t *testing.T) {
	t.Parallel()
	spoolDir := t.TempDir()
	sp := newSpool(t, spoolDir, nil)
	var out collector
	p, err := sp.Start("1", "bash", executor.Request{Cmd: "echo a; echo err >&2; sleep 0.2; echo b; exit 3", Cwd: t.TempDir()}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Durable() {
		t.Error("a spooled command is not durable")
	}
	res := waitResult(t, p)
	if res.Code != 3 || res.Killed || out.String() != "a\nerr\nb\n" {
		t.Errorf("result %+v, output %q", res, out.String())
	}
	p.Forget()
	waitUntil(t, "the spool entry to go", func() bool {
		e, _ := os.ReadDir(spoolDir)
		return len(e) == 0
	})
}

func TestSpoolRefusesMissingCwd(t *testing.T) {
	t.Parallel()
	spoolDir := t.TempDir()
	sp := newSpool(t, spoolDir, nil)
	_, err := sp.Start("1", "bash", executor.Request{Cmd: "true", Cwd: filepath.Join(t.TempDir(), "gone")}, func([]byte) {})
	if err == nil {
		t.Error("started a command in a missing directory")
	}
	if e, _ := os.ReadDir(spoolDir); len(e) != 0 {
		t.Errorf("left %d spool entries", len(e))
	}
}

// TestSpoolAdoptAfterRelease is a daemon restart: the first daemon lets
// go of a running command, and a second one adopts it from the spool and
// gets all its output and its exit code.
func TestSpoolAdoptAfterRelease(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	gate := filepath.Join(root, "gate")
	pidPath := filepath.Join(root, "pid")
	var out1 collector
	p1, err := newSpool(t, spoolDir, nil).Start("cmd-1", "bash", executor.Request{Cwd: root, Timeout: time.Minute,
		Cmd: "echo $$ > pid; echo first; while [ ! -e gate ]; do sleep 0.02; done; echo second; exit 7"}, out1.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first line", func() bool { return out1.String() == "first\n" })
	p1.Release()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if _, err := p1.Wait(ctx); err != executor.ErrReleased { //nolint:errorlint // the exact error
		t.Errorf("Wait after Release = %v", err)
	}
	cancel()
	pidData, _ := os.ReadFile(pidPath)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(pidData)))
	if pid <= 0 || !alive(pid) {
		t.Fatalf("the command (pid %d) did not outlive the release", pid)
	}

	sp2 := newSpool(t, spoolDir, nil)
	a := adoptOne(t, sp2, "cmd-1")
	var out2 collector
	p2 := sp2.Adopt(a, out2.write)
	if p2.Pid() != pid {
		t.Errorf("adopted pid %d, want %d", p2.Pid(), pid)
	}
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	res := waitResult(t, p2)
	if res.Code != 7 || out2.String() != "first\nsecond\n" {
		t.Errorf("result %+v, output %q", res, out2.String())
	}
}

// TestSpoolConfirmedPoint checks that the next daemon starts at the point
// the plugin confirmed, with its wire offset.
func TestSpoolConfirmedPoint(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "echo 0123456789; while [ ! -e gate ]; do sleep 0.02; done; echo tail"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first line", func() bool { return out.String() == "0123456789\n" })
	p.Confirm(11, 14)
	p.Release()
	sp2 := newSpool(t, spoolDir, nil)
	a := adoptOne(t, sp2, "c")
	if a.File != 11 || a.Wire != 14 {
		t.Errorf("confirmed point %d/%d, want 11/14", a.File, a.Wire)
	}
	var out2 collector
	p2 := sp2.Adopt(a, out2.write)
	if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, p2); res.Code != 0 || out2.String() != "tail\n" {
		t.Errorf("result %+v, output %q", res, out2.String())
	}
}

// TestSpoolFinishedWhileAway: the command ends while no daemon runs; the
// next daemon still gets its last output and its exit.
func TestSpoolFinishedWhileAway(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "echo one; while [ ! -e gate ]; do sleep 0.02; done; echo two; exit 42"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first line", func() bool { return out.String() == "one\n" })
	p.Release()
	if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the exit record", func() bool {
		m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "exit.json"))
		return len(m) == 1
	})
	sp2 := newSpool(t, spoolDir, nil)
	var out2 collector
	p2 := sp2.Adopt(adoptOne(t, sp2, "c"), out2.write)
	if res := waitResult(t, p2); res.Code != 42 || out2.String() != "one\ntwo\n" {
		t.Errorf("result %+v, output %q", res, out2.String())
	}
}

// TestSpoolStdinAfterAdopt: a command that reads its stdin only after the
// daemon restarted still gets all of it.
func TestSpoolStdinAfterAdopt(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	in := "line one\nline two\n"
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root, Stdin: &in,
		Cmd: "echo ready; while [ ! -e gate ]; do sleep 0.02; done; cat; echo done"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "ready", func() bool { return out.String() == "ready\n" })
	p.Release()
	sp2 := newSpool(t, spoolDir, nil)
	var out2 collector
	p2 := sp2.Adopt(adoptOne(t, sp2, "c"), out2.write)
	if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, p2); res.Code != 0 || out2.String() != "ready\n"+in+"done\n" {
		t.Errorf("result %+v, output %q", res, out2.String())
	}
}

// TestSpoolKillAfterAdopt: the adopting daemon kills the whole process
// group, and the result says killed.
func TestSpoolKillAfterAdopt(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "sleep 60 & echo $! > child; echo started; wait"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "started", func() bool { return out.String() == startedLine })
	data, _ := os.ReadFile(filepath.Join(root, "child"))
	child, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	p.Release()
	sp2 := newSpool(t, spoolDir, nil)
	p2 := sp2.Adopt(adoptOne(t, sp2, "c"), func([]byte) {})
	p2.Kill()
	res := waitResult(t, p2)
	if !res.Killed || res.Code != executor.ExitKilled {
		t.Errorf("result %+v", res)
	}
	waitUntil(t, "the background child to die", func() bool { return child > 0 && !alive(child) })
}

// TestSpoolKillSurvivesRestart: a daemon that killed a command and
// stopped before the command ended leaves the kill to the next daemon.
func TestSpoolKillSurvivesRestart(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "trap '' TERM; echo started; while :; do sleep 0.05; done"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "started", func() bool { return out.String() == startedLine })
	p.Kill()
	p.Release()
	sp2 := newSpool(t, spoolDir, nil)
	p2 := sp2.Adopt(adoptOne(t, sp2, "c"), func([]byte) {})
	res := waitResult(t, p2)
	if !res.Killed || res.Code != executor.ExitKilled {
		t.Errorf("result %+v", res)
	}
}

// TestSpoolHolderLost: a holder that dies without recording the exit
// ends the command with a note, not a hang.
func TestSpoolHolderLost(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "echo started; sleep 60"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "started", func() bool { return out.String() == startedLine })
	m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "pid"))
	if len(m) != 1 {
		t.Fatalf("pid files %v", m)
	}
	data, _ := os.ReadFile(m[0])
	holder, _ := strconv.Atoi(strings.Fields(string(data))[0])
	if err := syscall.Kill(holder, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	res := waitResult(t, p)
	if res.Killed || res.Code != 137 || !strings.Contains(res.Note, "without recording") {
		t.Errorf("result %+v", res)
	}
	_ = syscall.Kill(-p.Pid(), syscall.SIGKILL)
}

// TestSpoolHolderIgnoresStopSignals: the holder outlives a SIGTERM or
// SIGHUP sent to everything of the daemon's, while the shell does not
// inherit that.
func TestSpoolHolderIgnoresStopSignals(t *testing.T) {
	t.Parallel()
	spoolDir, root := t.TempDir(), t.TempDir()
	var out collector
	p, err := newSpool(t, spoolDir, nil).Start("c", "bash", executor.Request{Cwd: root,
		Cmd: "echo started; while [ ! -e gate ]; do sleep 0.02; done; echo end"}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "started", func() bool { return out.String() == startedLine })
	m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "pid"))
	data, _ := os.ReadFile(m[0])
	holder, _ := strconv.Atoi(strings.Fields(string(data))[0])
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGHUP, syscall.SIGINT} {
		if err := syscall.Kill(holder, sig); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(200 * time.Millisecond)
	if !alive(holder) {
		t.Fatal("the holder died of a stop signal")
	}
	if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, p); res.Code != 0 || out.String() != "started\nend\n" {
		t.Errorf("result %+v, output %q", res, out.String())
	}
	// The shell gets SIGTERM's default action.
	p2, err := newSpool(t, spoolDir, nil).Start("d", "bash", executor.Request{Cwd: root, Cmd: "kill -TERM $$; sleep 5"}, func([]byte) {})
	if err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, p2); res.Signal != syscall.SIGTERM {
		t.Errorf("shell result %+v, want SIGTERM", res)
	}
}

func TestSpoolLockIsExclusive(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	release, err := newSpool(t, dir, nil).Lock(time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newSpool(t, dir, nil).Lock(200 * time.Millisecond); err == nil {
		t.Error("a second daemon took the spool")
	}
	release()
	release2, err := newSpool(t, dir, nil).Lock(time.Second)
	if err != nil {
		t.Errorf("after release: %v", err)
	} else {
		release2()
	}
}

// TestSpoolInScopeIsNotPartOfTheService: the holder runs in the scope,
// and the scope is not part of the daemon's service.
func TestSpoolInScopeIsNotPartOfTheService(t *testing.T) {
	t.Parallel()
	bin, args := fakeSystemd(t, "", "")
	s := scopeIn(bin)
	s.PartOf = "talaria.service"
	var out collector
	p, err := newSpool(t, t.TempDir(), s).Start("c", "bash", executor.Request{Cmd: "echo hi; exit 5", Cwd: t.TempDir(), Env: os.Environ()}, out.write)
	if err != nil {
		t.Fatal(err)
	}
	if res := waitResult(t, p); res.Code != 5 || out.String() != "hi\n" {
		t.Errorf("result %+v, output %q", res, out.String())
	}
	got := strings.Join(readArgs(t, args), " ")
	if strings.Contains(got, "PartOf=") || !strings.Contains(got, "-p OOMPolicy=kill") || !strings.Contains(got, executor.HolderCommand) {
		t.Errorf("args %q", got)
	}
}
