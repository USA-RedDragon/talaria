//go:build unix

package executor

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/USA-RedDragon/talaria/internal/filelock"
)

// HolderCommand is the first argument that makes talaria a command holder.
const HolderCommand = "__command-holder"

// HolderArgs is the command line of the holder in the binary exe, without
// the command's directory.
func HolderArgs(exe string) []string { return []string{exe, HolderCommand} }

// HolderInvocation reports whether args (os.Args) start a holder, and the
// command's directory.
func HolderInvocation(args []string) (string, bool) {
	if len(args) == 3 && args[1] == HolderCommand {
		return args[2], true
	}
	return "", false
}

// exitLinger is how long a holder reads output after the shell ended,
// while background children keep the output pipe open.
const exitLinger = 500 * time.Millisecond

// RunHolder runs the command in dir as its holder and returns the holder's
// exit status. It starts the shell of spec.json in a process group of its
// own, writes the shell's pid to stdout and to the pid file, appends the
// shell's output to the out file, and writes exit.json when the shell has
// ended and its output is in the file. It holds the lock file while it
// runs. It outlives the daemon: it ignores the signals that stop a
// session or a service, which the shell does not inherit.
func RunHolder(dir string) int {
	logf := func(format string, args ...any) {
		f, err := os.OpenFile(filepath.Join(dir, holderLog), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err == nil {
			_, _ = fmt.Fprintf(f, format+"\n", args...)
			_ = f.Close()
		}
	}
	// A holder waits on one pipe and one process: one thread for Go code
	// is enough, and keeps the holder small. The command does not inherit
	// this.
	runtime.GOMAXPROCS(1)
	fail := func(err error) int {
		logf("%v", err)
		_, _ = fmt.Fprintf(os.Stdout, "err %s\n", err)
		return 1
	}
	// Notify, not Ignore: an ignored signal stays ignored in the shell.
	sigs := make(chan os.Signal, 8)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGPIPE)
	go func() {
		for range sigs {
		}
	}()

	var spec holdSpec
	if err := readJSONFile(filepath.Join(dir, specFile), &spec); err != nil {
		return fail(err)
	}
	if spec.V != spoolV || len(spec.Argv) == 0 {
		return fail(fmt.Errorf("spec version %d with %d arguments", spec.V, len(spec.Argv)))
	}
	lock, err := os.OpenFile(filepath.Join(dir, lockFile), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return fail(err)
	}
	if err := filelock.TryLock(lock, filelock.Exclusive); err != nil {
		return fail(fmt.Errorf("lock: %w", err))
	}
	out, err := os.OpenFile(filepath.Join(dir, outFile), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return fail(err)
	}
	path, err := exec.LookPath(spec.Argv[0])
	if err != nil {
		return fail(err)
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return fail(err)
	}
	cmd := &exec.Cmd{Path: path, Args: spec.Argv, Dir: spec.Cwd, Env: os.Environ(), Stdout: pw, Stderr: pw,
		SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}
	if spec.Stdin {
		in, err := os.Open(filepath.Join(dir, stdinFile))
		if err != nil {
			return fail(err)
		}
		cmd.Stdin = in
	}
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	_ = pw.Close()
	pid := cmd.Process.Pid
	if err := writeFileAtomic(filepath.Join(dir, pidFile), strconv.Itoa(os.Getpid())+" "+strconv.Itoa(pid)+"\n"); err != nil {
		logf("write the pid file: %v", err)
	}
	_, _ = fmt.Fprintf(os.Stdout, "%d\n", pid)
	// The daemon's end of stdout goes away with the daemon; nothing more
	// is written to it, nor to stderr.
	if devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0); err == nil {
		_ = syscall.Dup2(int(devnull.Fd()), 1)
		_ = syscall.Dup2(int(devnull.Fd()), 2)
		_ = devnull.Close()
	}

	copied := make(chan struct{})
	go func() {
		defer close(copied)
		buf := make([]byte, 32*1024)
		failed := false
		for {
			n, err := pr.Read(buf)
			if n > 0 && !failed {
				if _, werr := out.Write(buf[:n]); werr != nil {
					// Keep reading, so the command does not block on a
					// full pipe.
					logf("write the output: %v", werr)
					failed = true
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed) {
					logf("read the output: %v", err)
				}
				return
			}
		}
	}()
	werr := cmd.Wait()
	select {
	case <-copied:
	case <-time.After(exitLinger):
		_ = pr.Close()
		<-copied
	}
	_ = out.Close()
	ex := holdExit{Code: exitCode(werr)}
	if sig := signalOf(werr); sig != 0 {
		ex.Code, ex.Signal = -1, int(sig)
	}
	if err := writeJSONFile(filepath.Join(dir, exitFile), ex); err != nil {
		logf("write the exit: %v", err)
		return 1
	}
	return 0
}

func writeFileAtomic(path, data string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(data), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
