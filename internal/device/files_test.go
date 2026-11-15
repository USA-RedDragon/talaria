//go:build unix

package device_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/protocol"
	"github.com/coder/websocket"
)

const fileTestID = "0123456789abcdef0123456789abcdef"

// fileConn is the plugin side of a leg that negotiated file_read.
type fileConn struct {
	t    *testing.T
	ctx  context.Context //nolint:containedctx // test helper
	conn *websocket.Conn
}

// withFileDevice starts a device with root as its only root, and runs fn as
// the plugin on its leg. It returns when fn does.
func withFileDevice(t *testing.T, root string, fn func(fc *fileConn)) {
	t.Helper()
	done := make(chan struct{})
	f := &fakeHub{capabilities: []string{protocol.CapabilityFileRead}, handler: func(ctx context.Context, conn *websocket.Conn, _ protocol.Hello) {
		conn.SetReadLimit(1 << 20)
		fn(&fileConn{t: t, ctx: ctx, conn: conn})
		close(done)
		<-ctx.Done()
	}}
	opts := options(t, serve(t, f).URL, root)
	start(t, opts)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the plugin side did not finish")
	}
}

func (fc *fileConn) send(v any) { writeJSON(fc.ctx, fc.conn, v) }

// next reads one message: binary data, or a file_result.
func (fc *fileConn) next() (frame []byte, res protocol.FileResult, ok bool) {
	for {
		typ, data, err := fc.conn.Read(fc.ctx)
		if err != nil {
			fc.t.Errorf("read: %v", err)
			return nil, res, false
		}
		if typ == websocket.MessageBinary {
			return data, res, true
		}
		var env protocol.Envelope
		_ = json.Unmarshal(data, &env)
		if env.Type != protocol.TypeFileResult {
			continue
		}
		if err := json.Unmarshal(data, &res); err != nil {
			fc.t.Errorf("result: %v", err)
			return nil, res, false
		}
		return nil, res, true
	}
}

func (fc *fileConn) stat(path string) (protocol.FileResult, statResult) {
	fc.t.Helper()
	fc.send(protocol.FileStat{Type: protocol.TypeFileStat, ID: fileTestID, Path: path})
	frame, res, ok := fc.next()
	if !ok || frame != nil {
		fc.t.Fatalf("stat %s: frame %d bytes, ok %v", path, len(frame), ok)
	}
	var sr statResult
	if res.OK {
		if err := json.Unmarshal(res.Result, &sr); err != nil {
			fc.t.Fatal(err)
		}
	}
	return res, sr
}

type statResult struct {
	Real    string `json:"real"`
	Size    int64  `json:"size"`
	MTimeNS int64  `json:"mtime_ns"`
	Dev     uint64 `json:"dev"`
	Ino     uint64 `json:"ino"`
	Head    string `json:"head"`
}

// read sends a file_read for the window and collects its frames.
func (fc *fileConn) read(req protocol.FileRead) (data []byte, frames int, res protocol.FileResult) {
	fc.t.Helper()
	req.Type, req.ID = protocol.TypeFileRead, fileTestID
	fc.send(req)
	for {
		frame, r, ok := fc.next()
		if !ok {
			fc.t.FailNow()
		}
		if frame == nil {
			return data, frames, r
		}
		if len(frame) <= protocol.FileIDLen || len(frame) > protocol.FileIDLen+protocol.FileFrameMax ||
			string(frame[:protocol.FileIDLen]) != req.ID {
			fc.t.Errorf("bad frame: %d bytes, id %q", len(frame), frame[:min(len(frame), protocol.FileIDLen)])
		}
		data = append(data, frame[protocol.FileIDLen:]...)
		frames++
	}
}

func readReq(path string, sr statResult, offset, length int64) protocol.FileRead {
	return protocol.FileRead{Path: path, Offset: offset, Length: length, Dev: sr.Dev, Ino: sr.Ino, Size: sr.Size, MTimeNS: sr.MTimeNS}
}

func randomFile(t *testing.T, path string, size int) []byte {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return b
}

func realRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestFileStat(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	outside := realRoot(t)
	big := randomFile(t, filepath.Join(root, "big.bin"), 10000)
	small := filepath.Join(root, "small.txt")
	if err := os.WriteFile(small, []byte("hello alice\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("bob"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "dir"), 0o700); err != nil {
		t.Fatal(err)
	}
	mustLink := func(old, name string, hard bool) {
		t.Helper()
		var err error
		if hard {
			err = os.Link(old, name)
		} else {
			err = os.Symlink(old, name)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	mustLink(small, filepath.Join(root, "sym.txt"), false)
	mustLink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "out.txt"), false)
	mustLink(outside, filepath.Join(root, "outdir"), false)
	randomFile(t, filepath.Join(root, "linked.bin"), 100)
	mustLink(filepath.Join(root, "linked.bin"), filepath.Join(root, "hard.bin"), true)
	if err := os.WriteFile(filepath.Join(outside, "o.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	withFileDevice(t, root, func(fc *fileConn) {
		res, sr := fc.stat(filepath.Join(root, "big.bin"))
		_ = res
		wantHead := base64.StdEncoding.EncodeToString(big[:4096])
		fi, _ := os.Stat(filepath.Join(root, "big.bin"))
		if !res.OK || sr.Size != 10000 || sr.Head != wantHead || sr.Real != filepath.Join(root, "big.bin") ||
			sr.MTimeNS != fi.ModTime().UnixNano() || sr.Ino == 0 {
			t.Errorf("big stat = %+v %+v", res, sr)
		}
		// hard.bin is a second name of big.bin, so both are refused.
		for _, p := range []string{"linked.bin", "hard.bin"} {
			if res, _ := fc.stat(filepath.Join(root, p)); res.OK || res.Code != protocol.FileRefused || !strings.Contains(res.Error, "hard link") {
				t.Errorf("%s with two links = %+v", p, res)
			}
		}
		_, sr = fc.stat(small)
		if b, _ := base64.StdEncoding.DecodeString(sr.Head); string(b) != "hello alice\n" || sr.Size != 12 {
			t.Errorf("small stat = %+v", sr)
		}
		cases := []struct{ name, path, code string }{
			{"missing", filepath.Join(root, "nope.txt"), protocol.FileNotFound},
			{"missing parent", filepath.Join(root, "nope", "x.txt"), protocol.FileNotFound},
			{"directory", filepath.Join(root, "dir"), protocol.FileNotRegular},
			{"symlink inside roots", filepath.Join(root, "sym.txt"), protocol.FileRefused},
			{"symlink outside roots", filepath.Join(root, "out.txt"), protocol.FileRefused},
			{"outside the roots", filepath.Join(outside, "o.txt"), protocol.FileRefused},
			{"through a symlinked directory", filepath.Join(root, "outdir", "o.txt"), protocol.FileRefused},
			{"relative", "small.txt", protocol.FileRefused},
			{"not clean", root + "/dir/../small.txt", protocol.FileRefused},
		}
		for _, tc := range cases {
			if res, _ := fc.stat(tc.path); res.OK || res.Code != tc.code || res.Error == "" {
				t.Errorf("%s: %+v, want code %s", tc.name, res, tc.code)
			}
		}
	})
}

func TestFileReadWindows(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	path := filepath.Join(root, "random.bin")
	content := randomFile(t, path, 1<<20+12345)
	withFileDevice(t, root, func(fc *fileConn) {
		_, sr := fc.stat(path)
		windows := []struct {
			offset, length int64
			frames         int
		}{
			{0, 16777216, 5},                     // the whole file, length past the end
			{300000, 700000, 3},                  // inside, across frames
			{5, 1, 1},                            // one byte
			{int64(len(content)) - 100, 4096, 1}, // the tail
			{0, protocol.FileFrameMax, 1},        // exactly one full frame
			{0, protocol.FileFrameMax + 1, 2},    // one byte over
			{262143, 3, 1},                       // across a frame boundary of the file
		}
		for _, w := range windows {
			data, frames, res := fc.read(readReq(path, sr, w.offset, w.length))
			want := content[w.offset:min(int64(len(content)), w.offset+w.length)]
			if !res.OK || sha256.Sum256(data) != sha256.Sum256(want) || len(data) != len(want) {
				t.Errorf("window %+v: ok %v bytes %d want %d", w, res.OK, len(data), len(want))
			}
			var r struct {
				Bytes int64 `json:"bytes"`
			}
			_ = json.Unmarshal(res.Result, &r)
			if r.Bytes != int64(len(want)) || frames != w.frames {
				t.Errorf("window %+v: result bytes %d (want %d), frames %d (want %d)", w, r.Bytes, len(want), frames, w.frames)
			}
		}
		// Past the end: no frames, ok with 0 bytes.
		for _, off := range []int64{sr.Size, sr.Size + 5000} {
			data, frames, res := fc.read(readReq(path, sr, off, 1000))
			if !res.OK || len(data) != 0 || frames != 0 || string(res.Result) != `{"bytes":0}` {
				t.Errorf("read at %d: %+v, %d bytes, %d frames", off, res, len(data), frames)
			}
		}
		// Bad windows are refused.
		for _, w := range [][2]int64{{0, 0}, {0, protocol.FileReadMaxLength + 1}, {-1, 10}} {
			if _, _, res := fc.read(readReq(path, sr, w[0], w[1])); res.OK || res.Code != protocol.FileRefused {
				t.Errorf("window %v = %+v", w, res)
			}
		}
		// A request id that is not 32 lowercase hex characters is refused.
		fc.send(protocol.FileStat{Type: protocol.TypeFileStat, ID: "short", Path: path})
		if _, res, _ := fc.next(); res.OK || res.Code != protocol.FileRefused || res.ID != "short" {
			t.Errorf("short id = %+v", res)
		}
	})
}

func TestFileReadChanged(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	path := filepath.Join(root, "a.bin")
	randomFile(t, path, 5000)
	withFileDevice(t, root, func(fc *fileConn) {
		_, sr := fc.stat(path)
		if _, _, res := fc.read(readReq(path, sr, 0, 100)); !res.OK {
			t.Errorf("unchanged read = %+v", res)
		}
		// An unknown dev and ino (0, 0) compares size and mtime only.
		unknown := sr
		unknown.Dev, unknown.Ino = 0, 0
		if _, _, res := fc.read(readReq(path, unknown, 0, 100)); !res.OK {
			t.Errorf("read without dev and ino = %+v", res)
		}
		wrong := sr
		wrong.Ino++
		if _, _, res := fc.read(readReq(path, wrong, 0, 100)); res.OK || res.Code != protocol.FileChanged {
			t.Errorf("wrong inode = %+v", res)
		}
		// Same size, later mtime.
		later := time.Unix(0, sr.MTimeNS).Add(2 * time.Second)
		if err := os.Chtimes(path, later, later); err != nil {
			t.Fatal(err)
		}
		if _, _, res := fc.read(readReq(path, sr, 0, 100)); res.OK || res.Code != protocol.FileChanged {
			t.Errorf("changed mtime = %+v", res)
		}
		// New size.
		_, sr = fc.stat(path)
		if err := os.WriteFile(path, make([]byte, 6000), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, _, res := fc.read(readReq(path, sr, 0, 100)); res.OK || res.Code != protocol.FileChanged {
			t.Errorf("changed size = %+v", res)
		}
		// Replaced by another file of the same size and mtime: the inode differs.
		_, sr = fc.stat(path)
		other := filepath.Join(root, "other.bin")
		if err := os.WriteFile(other, make([]byte, sr.Size), 0o600); err != nil {
			t.Fatal(err)
		}
		mt := time.Unix(0, sr.MTimeNS)
		if err := os.Chtimes(other, mt, mt); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(other, path); err != nil {
			t.Fatal(err)
		}
		if _, _, res := fc.read(readReq(path, sr, 0, 100)); res.OK || res.Code != protocol.FileChanged {
			t.Errorf("replaced file = %+v", res)
		}
		// The rules apply to a read as to a stat.
		if _, _, res := fc.read(readReq(filepath.Join(root, "missing"), sr, 0, 100)); res.OK || res.Code != protocol.FileNotFound {
			t.Errorf("missing = %+v", res)
		}
	})
}

// sparseFile makes a 16 MiB file that the device cannot send before the
// plugin reads: more than a loopback connection buffers.
func sparseFile(t *testing.T, path string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(protocol.FileReadMaxLength); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestFileKillCancels(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	path := filepath.Join(root, "sparse.bin")
	sparseFile(t, path)
	withFileDevice(t, root, func(fc *fileConn) {
		_, sr := fc.stat(path)
		req := readReq(path, sr, 0, protocol.FileReadMaxLength)
		req.Type, req.ID = protocol.TypeFileRead, fileTestID
		fc.send(req)
		time.Sleep(300 * time.Millisecond) // the device blocks on a full connection
		fc.send(protocol.Kill{Type: protocol.TypeKill, ID: fileTestID})
		frames := 0
		for {
			frame, res, ok := fc.next()
			if !ok {
				return
			}
			if frame != nil {
				frames++
				continue
			}
			if res.OK || res.Code != protocol.FileCancelled {
				t.Errorf("result = %+v after %d frames", res, frames)
			}
			if total := protocol.FileReadMaxLength / protocol.FileFrameMax; frames >= total {
				t.Errorf("%d frames: the kill did not stop the read", frames)
			}
			return
		}
	})
}

func TestFileBusyLimit(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	path := filepath.Join(root, "sparse.bin")
	sparseFile(t, path)
	withFileDevice(t, root, func(fc *fileConn) {
		_, sr := fc.stat(path)
		ids := make([]string, 4)
		for i := range ids {
			ids[i] = strings.Repeat(string(rune('a'+i)), protocol.FileIDLen)
			req := readReq(path, sr, 0, protocol.FileReadMaxLength)
			req.Type, req.ID = protocol.TypeFileRead, ids[i]
			fc.send(req)
		}
		time.Sleep(300 * time.Millisecond)
		fc.send(protocol.FileStat{Type: protocol.TypeFileStat, ID: fileTestID, Path: path})
		cancelled := 0
		busy := false
		for !busy || cancelled < len(ids) {
			frame, res, ok := fc.next()
			if !ok {
				return
			}
			switch {
			case frame != nil:
			case res.ID == fileTestID:
				busy = true
				if res.OK || res.Code != protocol.FileFailed || !strings.Contains(res.Error, "busy") {
					t.Errorf("fifth request = %+v", res)
				}
				for _, id := range ids {
					fc.send(protocol.Kill{Type: protocol.TypeKill, ID: id})
				}
			case slices.Contains(ids, res.ID):
				cancelled++
				if res.OK || res.Code != protocol.FileCancelled {
					t.Errorf("%s = %+v", res.ID, res)
				}
			}
		}
		// With the four stopped, a request is served again.
		if res, _ := fc.stat(path); !res.OK {
			t.Errorf("stat after the busy period = %+v", res)
		}
	})
}

func TestFileReadCapability(t *testing.T) {
	t.Parallel()
	hellos := make(chan protocol.Hello, 2)
	f := &fakeHub{handler: func(ctx context.Context, _ *websocket.Conn, h protocol.Hello) {
		hellos <- h
		<-ctx.Done()
	}}
	opts := options(t, serve(t, f).URL, t.TempDir())
	opts.NoFileRead = true
	start(t, opts)
	if h := recv(t, hellos); slices.Contains(h.Capabilities, protocol.CapabilityFileRead) {
		t.Errorf("capabilities with NoFileRead = %v", h.Capabilities)
	}
	start(t, options(t, serve(t, f).URL, t.TempDir()))
	if h := recv(t, hellos); !slices.Contains(h.Capabilities, protocol.CapabilityFileRead) {
		t.Errorf("capabilities = %v", h.Capabilities)
	}
}

// A plugin that did not accept the capability gets a refusal, and no bytes.
func TestFileReadWithoutWelcomeCapability(t *testing.T) {
	t.Parallel()
	root := realRoot(t)
	path := filepath.Join(root, "a.txt")
	if err := os.WriteFile(path, []byte("hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := make(chan protocol.FileResult, 1)
	f := &fakeHub{handler: func(ctx context.Context, conn *websocket.Conn, _ protocol.Hello) {
		writeJSON(ctx, conn, protocol.FileStat{Type: protocol.TypeFileStat, ID: fileTestID, Path: path})
		var r protocol.FileResult
		if readType(ctx, t, conn, protocol.TypeFileResult, &r) {
			got <- r
		}
		<-ctx.Done()
	}}
	start(t, options(t, serve(t, f).URL, root))
	if r := recv(t, got); r.OK || r.Code != protocol.FileRefused {
		t.Errorf("result = %+v", r)
	}
}
