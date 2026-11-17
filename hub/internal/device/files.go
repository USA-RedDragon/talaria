package device

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// uploadTimeout bounds one upload: the plugin sends the file to the
// device over its exec leg, in two commands of up to 35 and 305 seconds
// (plugin/device/core.py UPLOAD_TIMEOUT_S), so the hub waits longer than
// the plugin can take.
const uploadTimeout = 7 * time.Minute

// codeBusy is the plugin's refusal of an upload while others run.
const codeBusy = "busy"

// codeOffline is the plugin's answer for a device that is not connected.
const codeOffline = "device_offline"

// Plugin error codes and body keys of the bind routes (docs/protocol.md
// section 9).
const (
	codeUnknownDevice = "unknown_device"
	codeOtherDevice   = "bound_to_other_device"
	keyDir            = "dir"
)

// Plugin error codes of file routes.
const (
	codeRunsOnPod = "runs_on_pod"
	codeTooLarge  = "too_large"
	codeNotFound  = "not_found"
)

var _ hub.SessionFiles = (*Server)(nil)

// PutFile writes a file a user attached into the device folder that runs a
// session. See hub.SessionFiles.
func (s *Server) PutFile(ctx context.Context, user, backendID, sessionID, name string, data []byte) (string, bool, error) {
	if s.backends[backendID] == nil {
		return "", false, s.opts.Access.Allowed(ctx, user, backendID)
	}
	b, err := s.deviceBackend(ctx, user, backendID)
	if err != nil {
		return "", false, err
	}
	cctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	f, err := b.plugin.PutFile(cctx, sessionID, name, data)
	var pe *PluginError
	if errors.As(err, &pe) && pe.Code == codeRunsOnPod {
		return "", false, nil
	}
	if err != nil {
		return "", false, uploadError(name, err)
	}
	if !path.IsAbs(f.Path) {
		return "", false, fmt.Errorf("%w: The computer did not say where it saved %s", hub.ErrAttachment, name)
	}
	return path.Clean(f.Path), true, nil
}

// uploadError turns a plugin refusal of an upload into a message for the
// user.
func uploadError(name string, err error) error {
	var pe *PluginError
	if !errors.As(err, &pe) {
		return fmt.Errorf("%w: Could not reach the agent to save %s. Try again in a moment", hub.ErrAttachment, name)
	}
	switch {
	case pe.Code == codeOffline:
		return fmt.Errorf("%w: The computer this chat runs on is offline, so %s cannot reach it", hub.ErrAttachment, name)
	case pe.Code == codeBusy:
		return fmt.Errorf("%w: The agent is busy with other uploads. Send %s again in a moment", hub.ErrAttachment, name)
	case pe.Code == codeTooLarge:
		return fmt.Errorf("%w: The file %s is too large for the computer: %s", hub.ErrAttachment, name, pe.Message)
	case pe.Code == StateFailClosed:
		return fmt.Errorf("%w: This chat runs on no computer now, so %s has nowhere to go (%s)", hub.ErrAttachment, name, pe.Message)
	case pe.Code == "write_refused":
		return fmt.Errorf("%w: The computer refused to save %s: %s", hub.ErrAttachment, name, pe.Message)
	case pe.Status == http.StatusNotFound || pe.Status == http.StatusMethodNotAllowed:
		return fmt.Errorf("%w: The server runs an older Talaria that cannot take files. Upgrade Talaria on the server: https://usa-reddragon.github.io/talaria/deploy/upgrades.html", hub.ErrAttachment)
	}
	return fmt.Errorf("%w: Could not save %s on the computer: %w", hub.ErrAttachment, name, err)
}

const (
	// readTimeout bounds one file read from a device and its transfer to
	// the hub: the plugin gives the device 125 seconds (plugin/device/core.py
	// FILE_READ_TIMEOUT_S) and then sends at most 32 MiB.
	readTimeout = 4 * time.Minute
	// maxReads is how many reads of one backend wait for the plugin at
	// once, the plugin's own limit (MAX_FILE_READS). The rest wait here
	// instead of getting the plugin's busy answer.
	maxReads = 2
	// busyRetries and busyWait bound the retries of a read that the plugin
	// refused as busy, for reads that another hub replica holds.
	busyRetries = 8
	busyWait    = 250 * time.Millisecond
)

var _ hub.DeviceMedia = (*Server)(nil)

// DeviceMedia opens a file of the device that runs a session. See
// hub.DeviceMedia.
func (s *Server) DeviceMedia(ctx context.Context, user, backendID, sessionID, p string) (*hub.MediaFile, bool, error) {
	if s.backends[backendID] == nil {
		return nil, false, s.opts.Access.Allowed(ctx, user, backendID)
	}
	b, err := s.deviceBackend(ctx, user, backendID)
	if err != nil {
		return nil, false, err
	}
	return s.readMedia(ctx, b, sessionID, p)
}

// readMedia reads a whole file through the plugin's old read route.
func (s *Server) readMedia(ctx context.Context, b *backend, sessionID, p string) (*hub.MediaFile, bool, error) {
	cctx, cancel := context.WithTimeout(ctx, readTimeout)
	resp, release, err := b.readFile(cctx, sessionID, p)
	if err != nil {
		cancel()
		var pe *PluginError
		if !errors.As(err, &pe) {
			return nil, false, err
		}
		switch {
		case pe.Code == codeRunsOnPod || pe.Code == StateFailClosed:
			return nil, false, nil
		case pe.Code == codeOffline:
			return nil, true, hub.ErrMediaOffline
		case pe.Code == codeTooLarge:
			return nil, true, hub.ErrMediaTooLarge
		case pe.Status == http.StatusNotFound || pe.Status == http.StatusMethodNotAllowed ||
			pe.Code == codeNotFound || pe.Code == codeBadPath || pe.Code == codeReadRefused || pe.Code == "read_failed":
			if pe.Code != codeNotFound {
				s.log.Info("the device plugin did not read a file", "session", sessionID, "error", pe.Error())
			}
			return nil, true, hub.ErrNoMedia
		}
		return nil, false, err
	}
	done := func() {
		cancel()
		release()
	}
	return &hub.MediaFile{Name: hub.CleanName(path.Base(p)), Size: resp.ContentLength, NoStore: true,
		Body: &doneBody{ReadCloser: resp.Body, done: done}}, true, nil
}

// readFile reads a file through the plugin, at most maxReads at once, and
// retries a busy answer. release frees the slot; on success the caller
// calls it once the body is read, since the plugin holds the file until
// then.
func (b *backend) readFile(ctx context.Context, sessionID, p string) (*http.Response, func(), error) {
	select {
	case b.reads <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	release := func() { <-b.reads }
	for try := 1; ; try++ {
		resp, err := b.plugin.ReadFile(ctx, sessionID, p)
		var pe *PluginError
		if err == nil {
			return resp, release, nil
		}
		if try > busyRetries || !errors.As(err, &pe) || pe.Code != codeBusy {
			release()
			return nil, nil, err
		}
		t := time.NewTimer(time.Duration(try) * busyWait)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			release()
			return nil, nil, ctx.Err()
		}
	}
}

var _ hub.DeviceFiles = (*Server)(nil)

// streamIdle bounds how long a file stream may go without a byte from the
// plugin. A transfer of any length runs while bytes flow.
const streamIdle = 2 * time.Minute

// statTimeout bounds one stat through the plugin.
const statTimeout = time.Minute

// DeviceFile stats and reads a file where a session runs, through the
// plugin's stat and stream routes (docs/protocol.md section 9, file
// offers). A plugin without them gets the old read route. See
// hub.DeviceFiles.
func (s *Server) DeviceFile(ctx context.Context, user, backendID, sessionID, p string, req hub.FileRequest) (*hub.FileInfo, io.ReadCloser, bool, error) {
	if s.backends[backendID] == nil {
		return nil, nil, false, s.opts.Access.Allowed(ctx, user, backendID)
	}
	b, err := s.deviceBackend(ctx, user, backendID)
	if err != nil {
		return nil, nil, false, err
	}
	sctx, cancel := context.WithTimeout(ctx, statTimeout)
	st, err := b.plugin.StatFile(sctx, sessionID, p, req.Offer)
	cancel()
	if oldRoute(err) {
		return s.oldFile(ctx, b, sessionID, p, req)
	}
	if err != nil {
		return s.fileError(sessionID, err)
	}
	fi := statInfo(p, st)
	if !req.Open {
		return fi, nil, true, nil
	}
	if req.ETag != "" && req.ETag != fi.ETag {
		return nil, nil, true, hub.ErrFileChanged
	}
	body, err := b.streamFile(ctx, sessionID, p, req.Offer, req.Offset, req.Length, st.ETag)
	if err != nil {
		return s.fileError(sessionID, err)
	}
	return fi, body, true, nil
}

// oldRoute reports whether err is a plugin without the stat and stream
// routes: the dashboard's own 404 or 405, not the plugin's not_found.
func oldRoute(err error) bool {
	var pe *PluginError
	return errors.As(err, &pe) && (pe.Status == http.StatusMethodNotAllowed ||
		pe.Status == http.StatusNotFound && pe.Code != codeNotFound)
}

// fileError maps a plugin refusal of a stat or stream.
func (s *Server) fileError(sessionID string, err error) (*hub.FileInfo, io.ReadCloser, bool, error) {
	var pe *PluginError
	if !errors.As(err, &pe) {
		return nil, nil, true, err
	}
	switch {
	case pe.Code == codeRunsOnPod || pe.Code == StateFailClosed:
		return nil, nil, false, nil
	case pe.Code == codeOffline:
		return nil, nil, true, hub.ErrMediaOffline
	case pe.Code == codeTooLarge:
		return nil, nil, true, hub.ErrMediaTooLarge
	case pe.Code == codeChanged || pe.Status == http.StatusPreconditionFailed:
		return nil, nil, true, hub.ErrFileChanged
	case pe.Secret:
		return nil, nil, true, &hub.RefusedError{Reason: pe.Message}
	case pe.Code == codeNotFound:
		return nil, nil, true, hub.ErrFileGone
	case pe.Code == codeBadPath || pe.Code == codeReadRefused || pe.Code == "read_failed" || pe.Code == "not_regular":
		s.log.Info("the device plugin did not serve a file", "session", sessionID, "error", pe.Error())
		return nil, nil, true, hub.ErrFileGone
	}
	return nil, nil, true, err
}

// Plugin error codes of the stat and stream routes.
const (
	// codeChanged is a stream whose file changed.
	codeChanged = "changed"
	// codeBadPath is a path that is not absolute and clean.
	codeBadPath = "bad_path"
	// codeReadRefused is a path outside the roots or a secret file.
	codeReadRefused = "read_refused"
)

// statInfo is what the hub serves of a plugin's file stat.
func statInfo(p string, st FileStat) *hub.FileInfo {
	name := st.Name
	if name == "" {
		name = path.Base(p)
	}
	fi := &hub.FileInfo{Name: hub.ShowName(name), Path: p, MIME: st.MIME, Kind: st.Kind, TypeLabel: st.TypeLabel,
		Machine: st.Machine, MachineKind: st.MachineKind, Size: st.Size, ETag: quoteETag(st.ETag),
		Secret: st.Secret, Requested: st.Requested}
	if st.MTime > 0 {
		sec := int64(st.MTime)
		fi.ModTime = time.Unix(sec, int64((st.MTime-float64(sec))*1e9)).UTC()
	}
	if fi.Kind == "" {
		_, fi.Kind = hub.GuessFile(name, nil)
	}
	return fi
}

// quoteETag is an entity tag in its quoted HTTP form.
func quoteETag(t string) string {
	if t == "" || strings.HasPrefix(t, `"`) || strings.HasPrefix(t, `W/"`) {
		return t
	}
	return `"` + t + `"`
}

// streamFile opens the plugin's stream of a file and retries a busy
// answer. The body fails once no byte came for streamIdle.
func (b *backend) streamFile(ctx context.Context, sessionID, p, offer string, offset, length int64, etag string) (io.ReadCloser, error) {
	sctx, cancel := context.WithCancel(ctx)
	for try := 1; ; try++ {
		resp, err := b.plugin.StreamFile(sctx, sessionID, p, offer, offset, length, etag)
		if err == nil {
			return newIdleBody(resp.Body, streamIdle, cancel), nil
		}
		var pe *PluginError
		if try > busyRetries || !errors.As(err, &pe) || pe.Code != codeBusy {
			cancel()
			return nil, err
		}
		t := time.NewTimer(time.Duration(try) * busyWait)
		select {
		case <-t.C:
		case <-sctx.Done():
			t.Stop()
			cancel()
			return nil, sctx.Err()
		}
	}
}

// errStalled is a stream that sent no byte for streamIdle.
var errStalled = errors.New("the file stream stalled")

// idleBody fails a read that waits longer than idle for bytes, by
// cancelling the request's context. Time the reader spends elsewhere, such
// as writing to a slow browser, does not count.
type idleBody struct {
	rc      io.ReadCloser
	idle    time.Duration
	cancel  context.CancelFunc
	timer   *time.Timer
	stalled chan struct{}
	once    sync.Once
}

func newIdleBody(rc io.ReadCloser, idle time.Duration, cancel context.CancelFunc) *idleBody {
	b := &idleBody{rc: rc, idle: idle, cancel: cancel, stalled: make(chan struct{})}
	b.timer = time.AfterFunc(time.Hour, func() {
		b.once.Do(func() { close(b.stalled) })
		cancel()
	})
	b.timer.Stop()
	return b
}

func (b *idleBody) Read(p []byte) (int, error) {
	b.timer.Reset(b.idle)
	n, err := b.rc.Read(p)
	b.timer.Stop()
	if err != nil && !errors.Is(err, io.EOF) {
		select {
		case <-b.stalled:
			return n, fmt.Errorf("%w: %w", errStalled, err)
		default:
		}
	}
	return n, err
}

func (b *idleBody) Close() error {
	b.timer.Stop()
	err := b.rc.Close()
	b.cancel()
	return err
}

// oldFile serves a file through the plugin's old read route, for a plugin
// without the stat and stream routes: the whole file (up to the plugin's
// 32 MiB), sliced here. It has no validator, so a download cannot resume.
func (s *Server) oldFile(ctx context.Context, b *backend, sessionID, p string, req hub.FileRequest) (*hub.FileInfo, io.ReadCloser, bool, error) {
	f, ok, err := s.readMedia(ctx, b, sessionID, p)
	if err != nil || !ok {
		if errors.Is(err, hub.ErrNoMedia) {
			err = hub.ErrFileGone
		}
		return nil, nil, ok, err
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(f.Body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		_ = f.Body.Close()
		return nil, nil, true, err
	}
	head = head[:n]
	fi := &hub.FileInfo{Name: hub.ShowName(path.Base(p)), Path: p, Size: f.Size}
	fi.MIME, fi.Kind = hub.GuessFile(p, head)
	if !req.Open {
		_ = f.Body.Close()
		return fi, nil, true, nil
	}
	if req.ETag != "" {
		_ = f.Body.Close()
		return nil, nil, true, hub.ErrFileChanged
	}
	var r io.Reader
	r = io.MultiReader(bytes.NewReader(head), f.Body)
	if _, err := io.CopyN(io.Discard, r, req.Offset); err != nil && !errors.Is(err, io.EOF) {
		_ = f.Body.Close()
		return nil, nil, true, err
	}
	if req.Length >= 0 {
		r = io.LimitReader(r, req.Length)
	}
	return fi, struct {
		io.Reader
		io.Closer
	}{r, f.Body}, true, nil
}

// doneBody calls done once when the body is closed.
type doneBody struct {
	io.ReadCloser
	once sync.Once
	done func()
}

func (d *doneBody) Close() error {
	err := d.ReadCloser.Close()
	d.once.Do(d.done)
	return err
}
