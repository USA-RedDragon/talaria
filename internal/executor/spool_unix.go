//go:build unix

package executor

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/USA-RedDragon/talaria/internal/filelock"
)

// A spooled command runs under a holder process (holder_unix.go), not as a
// child of the daemon. The holder writes the command's output to a file
// and its exit status to another, in a directory of its own in the spool,
// so the command keeps running and nothing it writes is lost when the
// daemon stops; the next daemon adopts it from the directory.
//
// Files in a command's directory:
//
//	spec.json   what to run; the daemon writes it before it starts the holder
//	state.json  what the plugin confirmed, the deadline, a kill; the daemon
//	stdin       the request's stdin, when it has one
//	lock        the holder holds a lock on it while it runs
//	pid         "<holder pid> <shell pid>"; the holder writes it once the shell runs
//	out         the command's stdout and stderr; the holder appends to it
//	exit.json   how the shell ended; the holder writes it after the last output
//	holder.log  what went wrong in the holder, if anything
const (
	specFile   = "spec.json"
	stateFile  = "state.json"
	stdinFile  = "stdin"
	lockFile   = "lock"
	pidFile    = "pid"
	outFile    = "out"
	exitFile   = "exit.json"
	holderLog  = "holder.log"
	spoolV     = 1
	holderWait = 30 * time.Second
)

// Poll intervals of a spooled command's output file: the shortest after
// new output, growing to the longest while it is quiet. liveCheck is how
// often a quiet command's holder is checked.
const (
	pollMin   = 5 * time.Millisecond
	pollMax   = 100 * time.Millisecond
	liveCheck = time.Second
)

// holdSpec is spec.json.
type holdSpec struct {
	V     int      `json:"v"`
	ID    string   `json:"id"`
	Argv  []string `json:"argv"`
	Cwd   string   `json:"cwd"`
	Stdin bool     `json:"stdin,omitempty"`
	Unit  string   `json:"unit,omitempty"`
}

// holdState is state.json.
type holdState struct {
	// File and Wire are the confirmed point: the plugin has the
	// command's output up to byte File of out, which was byte Wire on
	// the exec leg.
	File int64 `json:"file"`
	Wire int64 `json:"wire"`
	// Deadline is when the device kills the command, in Unix
	// nanoseconds; 0 for none.
	Deadline int64 `json:"deadline,omitempty"`
	Killed   bool  `json:"killed,omitempty"`
}

// holdExit is exit.json.
type holdExit struct {
	// Code is the exit status, or -1 when Signal ended the shell.
	Code   int `json:"code"`
	Signal int `json:"signal,omitempty"`
}

// Spool runs commands under holder processes in Dir, and adopts the ones
// an earlier daemon left there.
type Spool struct {
	// Dir is the spool directory. Each command gets a directory in it.
	Dir string
	// Holder is the command line of the holder program, to which the
	// command's directory is added (HolderArgs).
	Holder []string
	// Scope, when set, runs each holder and its command in a systemd
	// scope of its own.
	Scope *Scope
}

// NewSpool returns the spool in dir, created with mode 0700, whose holder
// runs as exe.
func NewSpool(dir, exe string, scope *Scope) (*Spool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Spool{Dir: dir, Holder: HolderArgs(exe), Scope: scope}, nil
}

// spooled is the spool side of a Process.
type spooled struct {
	dir   string
	scope *Scope
	unit  string

	mu        sync.Mutex
	state     holdState
	forgotten bool
	ended     bool

	released    chan struct{}
	releaseOnce sync.Once
}

func newDirName() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Start runs req for the command id under a new holder, like Start, with
// the command's output going to out from one goroutine in order.
func (sp *Spool) Start(id, shell string, req Request, out func([]byte)) (*Process, error) {
	return sp.start(id, shell, req, out, TimeoutGrace)
}

func (sp *Spool) start(id, shell string, req Request, out func([]byte), grace time.Duration) (*Process, error) {
	argv := []string{shell}
	if req.Login {
		argv = append(argv, "-l")
	}
	argv = append(argv, "-c", req.Cmd)
	if req.Argv != nil {
		argv = req.Argv(req.Cmd, req.Login, req.Cwd)
	}
	if _, err := exec.LookPath(argv[0]); err != nil {
		return nil, err
	}
	dir := filepath.Join(sp.Dir, newDirName())
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	fail := func(err error) (*Process, error) {
		_ = os.RemoveAll(dir)
		return nil, err
	}
	unit := ""
	if sp.Scope != nil {
		unit = scopeUnit()
	}
	spec := holdSpec{V: spoolV, ID: id, Argv: argv, Cwd: req.Cwd, Stdin: req.Stdin != nil, Unit: unit}
	if req.Stdin != nil {
		if err := os.WriteFile(filepath.Join(dir, stdinFile), []byte(*req.Stdin), 0o600); err != nil {
			return fail(err)
		}
	}
	var st holdState
	if req.Timeout > 0 {
		st.Deadline = time.Now().Add(req.Timeout + grace).UnixNano()
	}
	if err := writeJSONFile(filepath.Join(dir, stateFile), st); err != nil {
		return fail(err)
	}
	if err := writeJSONFile(filepath.Join(dir, specFile), spec); err != nil {
		return fail(err)
	}

	hargv := append(append([]string(nil), sp.Holder...), dir)
	if sp.Scope != nil {
		// Not PartOf the daemon's service: its stop or restart must not
		// stop the command.
		sc := *sp.Scope
		sc.PartOf = ""
		hargv = sc.argv(unit, hargv)
	}
	path, err := exec.LookPath(hargv[0])
	if err != nil {
		return fail(err)
	}
	// The holder starts a session of its own, so that neither a signal to
	// the daemon's process group nor the end of the daemon's session
	// reaches it.
	hc := &exec.Cmd{Path: path, Args: hargv, Env: req.Env, Dir: dir, SysProcAttr: &syscall.SysProcAttr{Setsid: true}}
	pr, err := hc.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	if err := hc.Start(); err != nil {
		return fail(err)
	}
	// The daemon reaps the holder while it runs; after a restart the
	// service manager or init does.
	go func() { _ = hc.Wait() }()
	pid, err := readHandshake(pr, holderWait)
	_ = pr.Close()
	if err != nil {
		if log, _ := os.ReadFile(filepath.Join(dir, holderLog)); len(log) > 0 {
			err = fmt.Errorf("%w: %s", err, strings.TrimSpace(string(log)))
		}
		if hc.Process != nil {
			_ = hc.Process.Kill()
		}
		return fail(err)
	}
	s := &spooled{dir: dir, scope: sp.Scope, unit: unit, state: st, released: make(chan struct{})}
	return s.run(pid, 0, out), nil
}

// readHandshake reads the shell's pid that the holder writes to its
// stdout once the shell runs, or the error it writes instead.
func readHandshake(r io.Reader, timeout time.Duration) (int, error) {
	type line struct {
		s   string
		err error
	}
	ch := make(chan line, 1)
	go func() {
		s, err := bufio.NewReader(r).ReadString('\n')
		ch <- line{s, err}
	}()
	select {
	case l := <-ch:
		s := strings.TrimSpace(l.s)
		if msg, ok := strings.CutPrefix(s, "err "); ok {
			return 0, errors.New(msg)
		}
		pid, err := strconv.Atoi(s)
		if err != nil || pid <= 0 {
			if l.err != nil {
				return 0, fmt.Errorf("the command holder ended before the command started: %w", l.err)
			}
			return 0, fmt.Errorf("the command holder said %q", s)
		}
		return pid, nil
	case <-time.After(timeout):
		return 0, fmt.Errorf("the command holder did not start the command within %s", timeout)
	}
}

// Adoptable is a command an earlier daemon left in the spool.
type Adoptable struct {
	// ID is the plugin's request id.
	ID string
	// File and Wire are the confirmed point (holdState).
	File, Wire int64
	dir        string
	pid        int
	state      holdState
	unit       string
}

// Adoptable lists the commands in the spool that a holder still runs or
// that ended without the plugin confirming their exit. It removes every
// directory that holds no such command.
func (sp *Spool) Adoptable() []Adoptable {
	entries, err := os.ReadDir(sp.Dir)
	if err != nil {
		slog.Warn("Could not read the command spool", "dir", sp.Dir, "error", err)
		return nil
	}
	var out []Adoptable
	for _, e := range entries {
		dir := filepath.Join(sp.Dir, e.Name())
		if !e.IsDir() {
			continue
		}
		a, ok := loadAdoptable(dir)
		if !ok {
			if holderAlive(dir) {
				slog.Warn("Leaving a spool entry whose holder runs but is not ready", "dir", dir)
				continue
			}
			_ = os.RemoveAll(dir)
			continue
		}
		out = append(out, a)
	}
	return out
}

func loadAdoptable(dir string) (Adoptable, bool) {
	var spec holdSpec
	if readJSONFile(filepath.Join(dir, specFile), &spec) != nil || spec.V != spoolV || spec.ID == "" {
		return Adoptable{}, false
	}
	var st holdState
	if readJSONFile(filepath.Join(dir, stateFile), &st) != nil {
		return Adoptable{}, false
	}
	data, err := os.ReadFile(filepath.Join(dir, pidFile))
	if err != nil {
		return Adoptable{}, false
	}
	f := strings.Fields(string(data))
	if len(f) != 2 {
		return Adoptable{}, false
	}
	pid, err := strconv.Atoi(f[1])
	if err != nil || pid <= 0 {
		return Adoptable{}, false
	}
	return Adoptable{ID: spec.ID, File: st.File, Wire: st.Wire, dir: dir, pid: pid, state: st, unit: spec.Unit}, true
}

// Adopt takes over a command from Adoptable: its output from the
// confirmed point on goes to out, from one goroutine in order, and its
// deadline applies again.
func (sp *Spool) Adopt(a Adoptable, out func([]byte)) *Process {
	s := &spooled{dir: a.dir, scope: sp.Scope, unit: a.unit, state: a.state, released: make(chan struct{})}
	if sp.Scope == nil {
		s.unit = ""
	}
	p := s.run(a.pid, a.File, out)
	if a.state.Killed {
		// The daemon that killed it may have stopped before its SIGKILL.
		p.Kill()
	}
	return p
}

// Lock takes the spool for this daemon, waiting up to timeout for a
// daemon that is stopping to let go of it. The returned function lets go.
// Two daemons never share a spool: each would adopt the other's commands.
func (sp *Spool) Lock(timeout time.Duration) (func(), error) {
	f, err := os.OpenFile(filepath.Join(sp.Dir, "daemon.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		err := filelock.TryLock(f, filelock.Exclusive)
		if err == nil {
			return func() { _ = f.Close() }, nil
		}
		if !errors.Is(err, filelock.ErrLocked) || time.Now().After(deadline) {
			_ = f.Close()
			if errors.Is(err, filelock.ErrLocked) {
				return nil, fmt.Errorf("another talaria run uses the command spool %s", sp.Dir)
			}
			return nil, err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// run builds the Process of a spooled command whose shell is pid and
// tails its output file from byte from.
func (s *spooled) run(pid int, from int64, out func([]byte)) *Process {
	p := &Process{done: make(chan struct{}), pid: pid, scope: s.scope, unit: s.unit, spooled: s,
		terminate:   func() error { return s.signal(pid, syscall.SIGTERM) },
		hardKill:    func() error { return s.signal(pid, syscall.SIGKILL) },
		releaseTree: func() {},
	}
	if s.state.Deadline > 0 {
		left := time.Until(time.Unix(0, s.state.Deadline))
		p.timer = time.AfterFunc(max(left, 0), p.Kill)
	}
	go s.tail(p, from, out)
	return p
}

// signal sends sig to the shell's process group while the shell has not
// ended and its holder runs. The holder has not reaped the shell before
// it writes the exit, so the group id cannot belong to another process
// then; without the holder (after a reboot, or a holder that was killed)
// it may, and nothing is sent.
func (s *spooled) signal(pgid int, sig syscall.Signal) error {
	if _, err := os.Stat(filepath.Join(s.dir, exitFile)); err == nil {
		return nil
	}
	if !holderAlive(s.dir) {
		return nil
	}
	return syscall.Kill(-pgid, sig)
}

func (s *spooled) markKilled() {
	s.mu.Lock()
	s.state.Killed = true
	st := s.state
	s.mu.Unlock()
	s.save(st)
}

func (s *spooled) setDeadline(t time.Time) {
	s.mu.Lock()
	s.state.Deadline = 0
	if !t.IsZero() {
		s.state.Deadline = t.UnixNano()
	}
	st := s.state
	s.mu.Unlock()
	s.save(st)
}

func (s *spooled) confirm(file, wire int64) {
	s.mu.Lock()
	if file <= s.state.File {
		s.mu.Unlock()
		return
	}
	s.state.File, s.state.Wire = file, wire
	st := s.state
	s.mu.Unlock()
	s.save(st)
	punchHole(filepath.Join(s.dir, outFile), file)
}

func (s *spooled) save(st holdState) {
	s.mu.Lock()
	gone := s.forgotten && s.ended
	s.mu.Unlock()
	if gone {
		return
	}
	if err := writeJSONFile(filepath.Join(s.dir, stateFile), st); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("Could not save a command's spool state", "dir", s.dir, "error", err)
	}
}

func (s *spooled) release() { s.releaseOnce.Do(func() { close(s.released) }) }

func (s *spooled) forget() {
	s.mu.Lock()
	s.forgotten = true
	ended := s.ended
	s.mu.Unlock()
	if ended {
		_ = os.RemoveAll(s.dir)
	}
}

func (s *spooled) isReleased() bool {
	select {
	case <-s.released:
		return true
	default:
		return false
	}
}

// tail reads the output file from byte from and sends what it reads to
// out until the holder records the exit, then sets the result.
func (s *spooled) tail(p *Process, from int64, out func([]byte)) {
	f, err := os.Open(filepath.Join(s.dir, outFile))
	if err != nil {
		s.end(p, Result{Code: 128 + int(syscall.SIGKILL), Signal: syscall.SIGKILL,
			Note: "the command's output file is gone: " + err.Error()})
		return
	}
	defer f.Close()
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		slog.Warn("Could not seek in a command's output file", "dir", s.dir, "error", err)
	}
	buf := make([]byte, 32*1024)
	drain := func() {
		for {
			n, err := f.Read(buf)
			if n > 0 {
				out(append([]byte(nil), buf[:n]...))
			}
			if err != nil || n == 0 {
				return
			}
		}
	}
	wait := pollMin
	lastCheck := time.Now()
	for {
		if s.isReleased() {
			return
		}
		n, _ := f.Read(buf)
		if n > 0 {
			out(append([]byte(nil), buf[:n]...))
			wait = pollMin
			continue
		}
		if ex, ok := readExit(s.dir); ok {
			drain()
			s.end(p, s.result(p, ex))
			return
		}
		if time.Since(lastCheck) >= liveCheck {
			lastCheck = time.Now()
			if !holderAlive(s.dir) {
				// The holder may have written the exit just before it
				// ended.
				if ex, ok := readExit(s.dir); ok {
					drain()
					s.end(p, s.result(p, ex))
					return
				}
				drain()
				res := Result{Code: 128 + int(syscall.SIGKILL), Signal: syscall.SIGKILL,
					Note: "the process that held the command ended without recording how the command ended"}
				p.mu.Lock()
				killed := p.killed
				p.mu.Unlock()
				if killed {
					res = Result{Code: ExitKilled, Killed: true, Signal: syscall.SIGKILL}
				} else if s.scope != nil && s.unit != "" && s.scope.oomKilled(s.unit) {
					res.OOM, res.MemoryMax, res.Note = true, s.scope.MemoryMax, ""
				}
				s.end(p, res)
				return
			}
		}
		select {
		case <-s.released:
			return
		case <-time.After(wait):
		}
		wait = min(wait*2, pollMax)
	}
}

// result turns the holder's record of the exit into a Result.
func (s *spooled) result(p *Process, ex holdExit) Result {
	res := Result{Code: ex.Code}
	if ex.Signal != 0 {
		res.Signal = syscall.Signal(ex.Signal)
		res.Code = 128 + ex.Signal
	}
	p.mu.Lock()
	killed := p.killed
	p.mu.Unlock()
	if killed && (res.Signal != 0 || res.Code == 128+int(syscall.SIGTERM)) {
		res.Killed, res.Code = true, ExitKilled
	} else if s.scope != nil && s.unit != "" && res.Signal != 0 && s.scope.oomKilled(s.unit) {
		res.OOM, res.MemoryMax = true, s.scope.MemoryMax
	}
	return res
}

func (s *spooled) end(p *Process, res Result) {
	p.Detach()
	p.mu.Lock()
	p.result = res
	p.mu.Unlock()
	s.mu.Lock()
	s.ended = true
	forgotten := s.forgotten
	s.mu.Unlock()
	if forgotten {
		_ = os.RemoveAll(s.dir)
	}
	close(p.done)
}

func readExit(dir string) (holdExit, bool) {
	var ex holdExit
	if readJSONFile(filepath.Join(dir, exitFile), &ex) != nil {
		return ex, false
	}
	return ex, true
}

// holderAlive reports whether a holder holds the lock of the command in
// dir.
func holderAlive(dir string) bool {
	f, err := os.Open(filepath.Join(dir, lockFile))
	if err != nil {
		return false
	}
	defer f.Close()
	if err := filelock.TryLock(f, filelock.Exclusive); err != nil {
		return errors.Is(err, filelock.ErrLocked)
	}
	_ = filelock.Unlock(f)
	return false
}

func writeJSONFile(path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSONFile(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}
