package web_test

import (
	"context"
	"errors"
	"flag"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"testing"
	"time"
)

// Every browser the tests drive is started by a node script (testdata/cdp.js
// or bidi.js), so the node process and the browser share one process group.
// browserCmd puts that group on its own, kills all of it when the test ends
// (or the context ends), and TestMain kills every live group on SIGTERM,
// SIGINT, SIGQUIT and just before the -timeout panic, which would otherwise
// skip t.Cleanup and leave the browsers running for days.

// killGroup SIGKILLs the whole process group of a started command.
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// browserCmd is exec.CommandContext for a node script that starts a browser.
// The test's profile directory must come from t.TempDir().
func browserCmd(ctx context.Context, t *testing.T, name string, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setPdeathsig(cmd.SysProcAttr)
	cmd.Cancel = func() error { return killGroup(cmd) }
	t.Cleanup(func() {
		_ = killGroup(cmd)
		// Wait for the group to be gone so the profile can be removed.
		if cmd.Process != nil {
			for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(20 * time.Millisecond) {
				if err := syscall.Kill(-cmd.Process.Pid, 0); err != nil {
					break
				}
				_ = killGroup(cmd)
			}
		}
	})
	return cmd
}

func TestMain(m *testing.M) {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGHUP)
	go func() {
		s := <-sigs
		killAllGroups()
		signal.Reset(s)
		if sig, ok := s.(syscall.Signal); ok {
			_ = syscall.Kill(os.Getpid(), sig)
		}
	}()
	// The -timeout panic skips every cleanup, so reap just before it.
	if f := flag.Lookup("test.timeout"); f != nil {
		if d, err := time.ParseDuration(f.Value.String()); err == nil && d > 2*time.Second {
			time.AfterFunc(d-time.Second, killAllGroups)
		}
	}
	os.Exit(m.Run())
}
