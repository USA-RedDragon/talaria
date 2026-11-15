//go:build unix

package device_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/device"
	"github.com/USA-RedDragon/talaria/internal/executor"
	"github.com/USA-RedDragon/talaria/protocol"
	"github.com/coder/websocket"
)

// daemon is one run of the device client, as one talaria run process.
type daemon struct {
	c      *device.Client
	cancel context.CancelFunc
	done   chan error
}

func spoolOptions(t *testing.T, url, root, spoolDir string) device.Options {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sp, err := executor.NewSpool(spoolDir, exe, nil)
	if err != nil {
		t.Fatal(err)
	}
	opts := options(t, url, root)
	opts.Spool = sp
	return opts
}

func startDaemon(t *testing.T, opts device.Options) *daemon {
	t.Helper()
	c, err := device.New(opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &daemon{c: c, cancel: cancel, done: make(chan error, 1)}
	go func() {
		if err := c.Run(ctx); err != nil {
			t.Logf("Run: %v", err)
		}
		close(d.done)
	}()
	t.Cleanup(d.stop)
	return d
}

// stop stops the daemon as a service stop does.
func (d *daemon) stop() {
	d.cancel()
	select {
	case <-d.done:
	case <-time.After(10 * time.Second):
	}
}

func joined(r resumed) (string, int64) {
	var out string
	first := int64(-1)
	for _, o := range r.outputs {
		if first < 0 {
			first = o.Offset
		}
		out += o.Data
	}
	return out, first
}

// TestRestartAdoptsRunningCommand is a restart of the daemon in the middle
// of a command: the command keeps running, and the next daemon resumes it
// to the plugin with the output the plugin is missing and the real exit
// code.
func TestRestartAdoptsRunningCommand(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	gate := filepath.Join(root, "gate")
	gotFirst, finished := make(chan struct{}), make(chan struct{})
	f := &resumeHub{grace: 30}
	f.resumeFor = func(n int32) []protocol.ResumeCommand {
		if n == 2 {
			return []protocol.ResumeCommand{{ID: "1", Offset: 6}}
		}
		return nil
	}
	f.handle = func(ctx context.Context, n int32, conn *websocket.Conn) {
		switch n {
		case 1:
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root,
				Cmd: "echo first; while [ ! -e gate ]; do sleep 0.02; done; echo second; exit 7"})
			waitOutput(ctx, t, conn, "1", "first\n")
			close(gotFirst)
		case 2:
			if err := os.WriteFile(gate, nil, 0o600); err != nil {
				t.Error(err)
			}
			r := readResumed(ctx, t, conn, "1")
			out, first := joined(r)
			if out != "second\n" || first != 6 || r.exit.Code != 7 || r.exit.Error != "" {
				t.Errorf("resumed output %q from %d, exit %+v", out, first, r.exit)
			}
			close(finished)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d1 := startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, gotFirst)
	d1.stop()
	startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, finished)
}

func spoolEmpty(dir string) bool {
	e, _ := os.ReadDir(dir)
	for _, x := range e {
		if x.IsDir() {
			return false
		}
	}
	return true
}

// TestRestartWhileFinished: the command ends while no daemon runs, and the
// plugin has none of its output; the next daemon sends it all.
func TestRestartWhileFinished(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	gotFirst, finished := make(chan struct{}), make(chan struct{})
	f := &resumeHub{grace: 30}
	f.resumeFor = func(n int32) []protocol.ResumeCommand {
		if n == 2 {
			return []protocol.ResumeCommand{{ID: "1", Offset: 0}}
		}
		return nil
	}
	f.handle = func(ctx context.Context, n int32, conn *websocket.Conn) {
		switch n {
		case 1:
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root,
				Cmd: "echo first; while [ ! -e gate ]; do sleep 0.02; done; echo second; exit 3"})
			waitOutput(ctx, t, conn, "1", "first\n")
			close(gotFirst)
		case 2:
			r := readResumed(ctx, t, conn, "1")
			out, first := joined(r)
			if out != "first\nsecond\n" || first != 0 || r.exit.Code != 3 {
				t.Errorf("resumed output %q from %d, exit %+v", out, first, r.exit)
			}
			close(finished)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d1 := startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, gotFirst)
	d1.stop()
	if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the command to end", func() bool {
		m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "exit.json"))
		return len(m) == 1
	})
	startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, finished)
}

// TestRestartKillAfterAdopt: the plugin kills a command the next daemon
// adopted; the whole command ends and the exit says killed.
func TestRestartKillAfterAdopt(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	pidFile := filepath.Join(root, "pid")
	started, finished := make(chan struct{}), make(chan struct{})
	f := &resumeHub{grace: 30}
	f.resumeFor = func(n int32) []protocol.ResumeCommand {
		if n == 2 {
			return []protocol.ResumeCommand{{ID: "1", Offset: 8}}
		}
		return nil
	}
	f.handle = func(ctx context.Context, n int32, conn *websocket.Conn) {
		switch n {
		case 1:
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root,
				Cmd: "sleep 60 & echo $! > " + pidFile + "; echo started; wait"})
			waitOutput(ctx, t, conn, "1", "started\n")
			close(started)
		case 2:
			writeJSON(ctx, conn, protocol.Kill{Type: protocol.TypeKill, ID: "1"})
			r := readUntilExit(ctx, t, conn, "1")
			if !r.exit.Killed || r.exit.Code != protocol.ExitKilled {
				t.Errorf("exit %+v", r.exit)
			}
			close(finished)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d1 := startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, started)
	child := readPid(t, pidFile)
	d1.stop()
	if !alive(child) {
		t.Fatal("the command died with the daemon")
	}
	startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, finished)
	waitFor(t, "the background child to die", func() bool { return !alive(child) })
}

// TestRestartStdin: a command that reads its stdin after the restart gets
// all of it.
func TestRestartStdin(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	in := "from the agent\n"
	ready, finished := make(chan struct{}), make(chan struct{})
	f := &resumeHub{grace: 30}
	f.resumeFor = func(n int32) []protocol.ResumeCommand {
		if n == 2 {
			return []protocol.ResumeCommand{{ID: "stdin-1", Offset: 6}}
		}
		return nil
	}
	f.handle = func(ctx context.Context, n int32, conn *websocket.Conn) {
		switch n {
		case 1:
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "stdin-1", Timeout: 60, Cwd: root, Stdin: &in,
				Cmd: "echo ready; while [ ! -e gate ]; do sleep 0.02; done; read -r line; echo \"got: $line\""})
			waitOutput(ctx, t, conn, "stdin-1", "ready\n")
			close(ready)
		case 2:
			if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
				t.Error(err)
			}
			r := readResumed(ctx, t, conn, "stdin-1")
			if out, _ := joined(r); out != "got: from the agent\n" || r.exit.Code != 0 {
				t.Errorf("output %q, exit %+v", out, r.exit)
			}
			close(finished)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d1 := startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, ready)
	d1.stop()
	startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, finished)
}

// TestRestartUnlistedIsKilled: a plugin that no longer waits for an
// adopted command (a new gateway) gets it killed, as before a restart.
func TestRestartUnlistedIsKilled(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	pidFile := filepath.Join(root, "pid")
	started := make(chan struct{})
	f := &resumeHub{grace: 30}
	f.handle = func(ctx context.Context, n int32, conn *websocket.Conn) {
		if n == 1 {
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root,
				Cmd: "echo $$ > " + pidFile + "; sleep 60"})
			readPid(t, pidFile)
			close(started)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d1 := startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	wait(t, started)
	pid := readPid(t, pidFile)
	d1.stop()
	if !alive(pid) {
		t.Fatal("the command died with the daemon")
	}
	startDaemon(t, spoolOptions(t, srv.URL, root, spoolDir))
	waitFor(t, "the command to die", func() bool { return !alive(pid) })
	waitFor(t, "the spool entry to go", func() bool { return spoolEmpty(spoolDir) })
}

// TestSpooledCommandsDoNotBlockDrain: a daemon whose commands are in the
// spool may restart for an update while they run.
func TestSpooledCommandsDoNotBlockDrain(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	for _, spooled := range []bool{false, true} {
		// A directory per round, so the second never reads the first's
		// pid.
		root := t.TempDir()
		pidFile := filepath.Join(root, "pid")
		f := &resumeHub{grace: 30}
		f.handle = func(ctx context.Context, _ int32, conn *websocket.Conn) {
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root, Cmd: "echo $$ > pid; echo up; sleep 30"})
			waitOutput(ctx, t, conn, "1", "up\n")
			started <- struct{}{}
			<-ctx.Done()
		}
		f.t = t
		srv := httptest.NewServer(f)
		opts := options(t, srv.URL, root)
		spoolDir := t.TempDir()
		if spooled {
			opts = spoolOptions(t, srv.URL, root, spoolDir)
		}
		d := startDaemon(t, opts)
		<-started
		if busy := d.c.Busy(); busy == spooled {
			t.Errorf("spooled %v: Busy() = %v", spooled, busy)
		}
		d.stop()
		srv.Close()
		if spooled {
			_ = syscall.Kill(-readPid(t, pidFile), syscall.SIGKILL)
			waitFor(t, "the holder to record the exit", func() bool {
				m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "exit.json"))
				return len(m) == 1
			})
		}
	}
}

// pongLoop reads messages until ctx ends or until stop returns true for
// one, answering every ping.
func pongLoop(ctx context.Context, conn *websocket.Conn, stop func(typ string, data []byte) bool) {
	for {
		typ, data, err := readMsg(ctx, conn)
		if err != nil {
			return
		}
		if typ == protocol.TypePing {
			var p protocol.Ping
			_ = json.Unmarshal(data, &p)
			writeJSON(ctx, conn, protocol.Ping{Type: protocol.TypePong, Seq: p.Seq})
			continue
		}
		if stop != nil && stop(typ, data) {
			return
		}
	}
}

// TestRestartKeepsConfirmedPoint: what the plugin confirmed before the
// restart is not sent again, and the spool entry goes once the plugin
// confirms the exit.
func TestRestartKeepsConfirmedPoint(t *testing.T) {
	t.Parallel()
	root, spoolDir := t.TempDir(), t.TempDir()
	const n = 5000
	confirmed, finished := make(chan struct{}), make(chan struct{})
	f := &resumeHub{grace: 30}
	f.resumeFor = func(c int32) []protocol.ResumeCommand {
		if c == 2 {
			return []protocol.ResumeCommand{{ID: "1", Offset: n + 1}}
		}
		return nil
	}
	f.handle = func(ctx context.Context, c int32, conn *websocket.Conn) {
		switch c {
		case 1:
			writeJSON(ctx, conn, protocol.Exec{Type: protocol.TypeExec, ID: "1", Timeout: 60, Cwd: root,
				Cmd: "printf 'a%.0s' $(seq " + strconv.Itoa(n) + "); echo; while [ ! -e gate ]; do sleep 0.02; done; echo end"})
			got := 0
			go pongLoop(ctx, conn, func(typ string, data []byte) bool {
				if typ == protocol.TypeOutput {
					var o protocol.Output
					_ = json.Unmarshal(data, &o)
					got += len(o.Data)
				}
				return false
			})
			waitFor(t, "the confirmed point in the spool", func() bool {
				m, _ := filepath.Glob(filepath.Join(spoolDir, "*", "state.json"))
				if len(m) != 1 {
					return false
				}
				b, _ := os.ReadFile(m[0])
				return strings.Contains(string(b), `"file":`+strconv.Itoa(n+1))
			})
			close(confirmed)
		case 2:
			if err := os.WriteFile(filepath.Join(root, "gate"), nil, 0o600); err != nil {
				t.Error(err)
			}
			var outs []protocol.Output
			var exit protocol.Exit
			pongLoop(ctx, conn, func(typ string, data []byte) bool {
				switch typ {
				case protocol.TypeOutput:
					var o protocol.Output
					_ = json.Unmarshal(data, &o)
					outs = append(outs, o)
				case protocol.TypeExit:
					_ = json.Unmarshal(data, &exit)
					return true
				}
				return false
			})
			if len(outs) != 1 || outs[0].Offset != n+1 || outs[0].Data != "end\n" || exit.Code != 0 {
				t.Errorf("outputs %+v, exit %+v", outs, exit)
			}
			go pongLoop(ctx, conn, nil)
			close(finished)
		}
		<-ctx.Done()
	}
	f.t = t
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	opts := spoolOptions(t, srv.URL, root, spoolDir)
	opts.PingInterval = 20 * time.Millisecond
	d1 := startDaemon(t, opts)
	wait(t, confirmed)
	d1.stop()
	opts = spoolOptions(t, srv.URL, root, spoolDir)
	opts.PingInterval = 20 * time.Millisecond
	startDaemon(t, opts)
	wait(t, finished)
	waitFor(t, "the spool entry to go", func() bool { return spoolEmpty(spoolDir) })
}
