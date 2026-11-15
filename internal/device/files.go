package device

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"syscall"

	"github.com/USA-RedDragon/talaria/internal/allowlist"
	"github.com/USA-RedDragon/talaria/protocol"
	"github.com/coder/websocket"
)

const (
	// fileHeadMax is the most bytes of the head in a file_stat result.
	fileHeadMax = 4096
	// fileMaxOps is the most file requests in flight on a leg.
	fileMaxOps = 4
)

// fileError is a failed file request: a protocol code and plain words.
type fileError struct {
	code string
	msg  string
}

func (e *fileError) Error() string { return e.msg }

func errNoFile() *fileError { return &fileError{protocol.FileNotFound, "no such file"} }

func errCancelled() *fileError { return &fileError{protocol.FileCancelled, "cancelled"} }

func refusedFile(format string, a ...any) *fileError {
	return &fileError{protocol.FileRefused, fmt.Sprintf(format, a...)}
}

func failedFile(format string, a ...any) *fileError {
	return &fileError{protocol.FileFailed, fmt.Sprintf(format, a...)}
}

// fileStatResult is the result of a successful file_stat.
type fileStatResult struct {
	Real    string `json:"real"`
	Size    int64  `json:"size"`
	MTimeNS int64  `json:"mtime_ns"`
	Dev     uint64 `json:"dev"`
	Ino     uint64 `json:"ino"`
	Head    string `json:"head"`
}

// fileReadResult is the result of a successful file_read.
type fileReadResult struct {
	Bytes int64 `json:"bytes"`
}

func (s *session) cancelFile(id string) {
	s.bmu.Lock()
	cancel := s.fileCalls[id]
	s.bmu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// fileRequest runs one file_stat or file_read (docs/protocol.md section
// 4.11). Like browser and MCP requests, file requests are never kept
// across a drop: the leg's context cancels them.
func (s *session) fileRequest(ctx context.Context, typ string, data []byte) {
	var req protocol.FileRead // a superset of FileStat
	if err := json.Unmarshal(data, &req); err != nil || req.ID == "" {
		slog.Warn("Ignoring malformed file request", "type", typ)
		return
	}
	reply := func(code, msg string) {
		_ = s.send(ctx, protocol.FileResult{Type: protocol.TypeFileResult, ID: req.ID, Code: code, Error: msg})
	}
	if !s.fileRead {
		reply(protocol.FileRefused, fmt.Sprintf("device %s refused: this exec leg has no file reads", s.name))
		return
	}
	if !validFileID(req.ID) {
		reply(protocol.FileRefused, "the request id is not 32 lowercase hex characters")
		return
	}
	if typ == protocol.TypeFileRead && (req.Length < 1 || req.Length > protocol.FileReadMaxLength || req.Offset < 0) {
		reply(protocol.FileRefused, fmt.Sprintf("offset must be 0 or more and length 1 to %d", protocol.FileReadMaxLength))
		return
	}
	if !s.c.beginCall() {
		reply(protocol.FileFailed, "the device "+drainingMessage)
		return
	}
	cctx, cancel := context.WithCancel(ctx)
	s.bmu.Lock()
	_, dup := s.fileCalls[req.ID]
	busy := len(s.fileCalls) >= fileMaxOps
	if !dup && !busy {
		s.fileCalls[req.ID] = cancel
	}
	s.bmu.Unlock()
	switch {
	case dup:
		cancel()
		s.c.endCall()
		reply(protocol.FileFailed, "request id is already running")
		return
	case busy:
		cancel()
		s.c.endCall()
		reply(protocol.FileFailed, fmt.Sprintf("busy: the device already serves %d file requests", fileMaxOps))
		return
	}
	s.wg.Go(func() {
		defer s.c.endCall()
		defer cancel()
		var (
			res json.RawMessage
			err error
		)
		if typ == protocol.TypeFileStat {
			res, err = s.c.fileStat(cctx, req.Path)
		} else {
			res, err = s.serveFileRead(ctx, cctx, req)
		}
		s.bmu.Lock()
		delete(s.fileCalls, req.ID)
		s.bmu.Unlock()
		out := protocol.FileResult{Type: protocol.TypeFileResult, ID: req.ID, OK: err == nil, Result: res}
		if err != nil {
			var fe *fileError
			if !errors.As(err, &fe) {
				fe = failedFile("%v", err)
			}
			out.Code, out.Error = fe.code, fe.msg
			slog.Info("File request failed", "type", typ, "code", out.Code, "error", out.Error)
		}
		_ = s.send(ctx, out)
	})
}

func validFileID(id string) bool {
	if len(id) != protocol.FileIDLen {
		return false
	}
	for _, r := range id {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// openFile checks wire against the rules of both file operations and
// returns the open file with its facts. The caller closes it.
func (c *Client) openFile(wire string) (f *os.File, fi os.FileInfo, realPath string, err *fileError) {
	local := wire
	if ws := c.opts.WinShell; ws != nil {
		if path.Clean(wire) != wire || !path.IsAbs(wire) {
			return nil, nil, "", refusedFile("the path must be absolute and clean")
		}
		l, ferr := ws.FromWire(wire)
		if ferr != nil {
			return nil, nil, "", refusedFile("%v", ferr)
		}
		local = l
	} else if !filepath.IsAbs(wire) || filepath.Clean(wire) != wire {
		return nil, nil, "", refusedFile("the path must be absolute and clean")
	}
	// The directory is resolved and checked against the roots; the last
	// part is checked on its own, so a link there is never followed.
	dir, derr := c.opts.Allow.Check(filepath.Dir(local))
	switch {
	case errors.Is(derr, allowlist.ErrOutside):
		return nil, nil, "", refusedFile("the path is outside the folders this device allows")
	case errors.Is(derr, fs.ErrNotExist):
		return nil, nil, "", errNoFile()
	case derr != nil:
		return nil, nil, "", failedFile("%v", derr)
	}
	realPath = filepath.Join(dir, filepath.Base(local))
	li, lerr := os.Lstat(realPath)
	switch {
	case errors.Is(lerr, fs.ErrNotExist):
		return nil, nil, "", errNoFile()
	case lerr != nil:
		return nil, nil, "", failedFile("%v", lerr)
	case li.Mode()&fs.ModeSymlink != 0:
		return nil, nil, "", refusedFile("the path is a symbolic link")
	case !li.Mode().IsRegular():
		return nil, nil, "", &fileError{protocol.FileNotRegular, "the path is not a regular file"}
	}
	f, oerr := openNoFollow(realPath)
	if oerr != nil {
		if errors.Is(oerr, fs.ErrNotExist) {
			return nil, nil, "", errNoFile()
		}
		if isLoop(oerr) {
			return nil, nil, "", refusedFile("the path is a symbolic link")
		}
		return nil, nil, "", failedFile("%v", oerr)
	}
	fi, serr := f.Stat()
	if serr != nil {
		_ = f.Close()
		return nil, nil, "", failedFile("%v", serr)
	}
	if !os.SameFile(li, fi) || !fi.Mode().IsRegular() {
		_ = f.Close()
		return nil, nil, "", &fileError{protocol.FileChanged, "the file was replaced while it was opened"}
	}
	if _, _, nlink, known := fileIdentity(f, fi); known && nlink > 1 {
		_ = f.Close()
		return nil, nil, "", refusedFile("the file has more than one hard link")
	}
	if ws := c.opts.WinShell; ws != nil {
		realPath = ws.ToWire(realPath)
	}
	return f, fi, realPath, nil
}

// fileStat answers a file_stat.
func (c *Client) fileStat(ctx context.Context, wire string) (json.RawMessage, error) {
	f, fi, realPath, ferr := c.openFile(wire)
	if ferr != nil {
		return nil, ferr
	}
	defer func() { _ = f.Close() }()
	if ctx.Err() != nil {
		return nil, errCancelled()
	}
	head := make([]byte, min(fi.Size(), fileHeadMax))
	n, err := f.ReadAt(head, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, failedFile("read: %v", err)
	}
	dev, ino, _, _ := fileIdentity(f, fi)
	return json.Marshal(fileStatResult{Real: realPath, Size: fi.Size(), MTimeNS: fi.ModTime().UnixNano(), Dev: dev, Ino: ino,
		Head: base64.StdEncoding.EncodeToString(head[:n])})
}

// serveFileRead answers a file_read. connCtx is the leg's context, for writes;
// ctx ends when the request is killed or the leg ends.
func (s *session) serveFileRead(connCtx, ctx context.Context, req protocol.FileRead) (json.RawMessage, error) { //nolint:revive // two contexts
	f, fi, _, ferr := s.c.openFile(req.Path)
	if ferr != nil {
		return nil, ferr
	}
	defer func() { _ = f.Close() }()
	dev, ino, _, known := fileIdentity(f, fi)
	if fi.Size() != req.Size || fi.ModTime().UnixNano() != req.MTimeNS ||
		(known && (req.Dev != 0 || req.Ino != 0) && (dev != req.Dev || ino != req.Ino)) {
		return nil, &fileError{protocol.FileChanged, "the file changed since it was listed"}
	}
	want := max(0, min(req.Length, req.Size-req.Offset))
	buf := make([]byte, protocol.FileIDLen+protocol.FileFrameMax)
	copy(buf, req.ID)
	var sent int64
	for sent < want {
		if ctx.Err() != nil {
			return nil, errCancelled()
		}
		chunk := buf[protocol.FileIDLen : protocol.FileIDLen+int(min(want-sent, protocol.FileFrameMax))]
		n, err := f.ReadAt(chunk, req.Offset+sent)
		if n < len(chunk) {
			if err == nil || errors.Is(err, io.EOF) {
				return nil, &fileError{protocol.FileChanged, "the file got shorter while it was read"}
			}
			return nil, failedFile("read: %v", err)
		}
		if err := s.sendBinary(connCtx, buf[:protocol.FileIDLen+n]); err != nil {
			return nil, failedFile("write: %v", err)
		}
		sent += int64(n)
	}
	if ctx.Err() != nil {
		return nil, errCancelled()
	}
	return json.Marshal(fileReadResult{Bytes: sent})
}

// sendBinary writes one binary frame.
func (s *session) sendBinary(ctx context.Context, data []byte) error {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return s.conn.Write(wctx, websocket.MessageBinary, data)
}

// isLoop reports whether err is what O_NOFOLLOW gives for a symbolic link.
func isLoop(err error) bool {
	return errors.Is(err, syscall.ELOOP)
}
