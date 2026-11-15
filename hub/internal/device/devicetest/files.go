package devicetest

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// Keys of a stat answer.
const (
	keyKind = "kind"
	keySize = "size"
)

// StreamCall is one request of the stream route.
type StreamCall struct {
	Session, Path, Offer, ETag string
	Offset, Length             int64
}

// fileRoutes is the state of the fake plugin's stat and stream routes
// (docs/protocol.md section 9, file offers).
type fileRoutes struct {
	mu sync.Mutex
	// disk are files served from the hub host's disk, by device ID and
	// path on the device.
	disk map[string]map[string]string
	// server are the files of the Hermes server, for chats that run there.
	server map[string][]byte
	// secret are paths the secret rules refuse, with the offer id that the
	// user asked for ("" for none).
	secret map[string]string
	// versions change a file's mtime and so its etag.
	versions map[string]int
	// old makes the stat and stream routes answer as a plugin without them.
	old bool
	// cutAt cuts the next stream after that many bytes (0: never).
	cutAt   int64
	streams []StreamCall
}

func newFileRoutes() *fileRoutes {
	return &fileRoutes{disk: map[string]map[string]string{}, server: map[string][]byte{}, secret: map[string]string{}, versions: map[string]int{}}
}

func (p *Plugin) mountFileRoutes(base string) {
	p.fr = newFileRoutes()
	p.gw.Handle("GET "+base+"/sessions/{session}/files/stat", http.HandlerFunc(p.statFile), true)
	p.gw.Handle("GET "+base+"/sessions/{session}/files/stream", http.HandlerFunc(p.streamFile), true)
}

// SetDiskFile serves a file of the hub host's disk as filePath on a
// device, for files too large to keep in memory.
func (p *Plugin) SetDiskFile(deviceID, filePath, diskPath string) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	if p.fr.disk[deviceID] == nil {
		p.fr.disk[deviceID] = map[string]string{}
	}
	p.fr.disk[deviceID][filePath] = diskPath
}

// SetServerFile puts a file on the Hermes server, for the chats that run
// there.
func (p *Plugin) SetServerFile(filePath string, data []byte) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	p.fr.server[filePath] = data
}

// SetSecret makes the secret rules refuse a path, unless a read names
// the offer id allowed ("" allows none).
func (p *Plugin) SetSecret(filePath, allowed string) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	p.fr.secret[filePath] = allowed
}

// TouchFile changes a file's mtime, and so its etag.
func (p *Plugin) TouchFile(filePath string) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	p.fr.versions[filePath]++
}

// OldFileRoutes makes the stat and stream routes answer 404 as the
// dashboard does for a plugin without them.
func (p *Plugin) OldFileRoutes(old bool) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	p.fr.old = old
}

// CutStreamAt makes the next stream drop its connection after n bytes.
func (p *Plugin) CutStreamAt(n int64) {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	p.fr.cutAt = n
}

// Streams returns the requests of the stream route so far.
func (p *Plugin) Streams() []StreamCall {
	p.fr.mu.Lock()
	defer p.fr.mu.Unlock()
	return slices.Clone(p.fr.streams)
}

// served is a file the stat and stream routes found.
type served struct {
	data             []byte
	disk             string
	size             int64
	mtimeNS          int64
	machine, mkind   string
	secret, asked    bool
	name, mime, kind string
}

func (s *served) etag() string {
	return fmt.Sprintf(`"%x-%x-0"`, s.size, s.mtimeNS)
}

// find runs the read rules of a stat or stream and writes the refusal.
func (p *Plugin) find(w http.ResponseWriter, r *http.Request) (*served, bool) {
	fp, offer := r.URL.Query().Get(keyPath), r.URL.Query().Get("offer")
	p.fr.mu.Lock()
	old := p.fr.old
	p.fr.mu.Unlock()
	if old {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
		return nil, false
	}
	if !path.IsAbs(fp) || path.Clean(fp) != fp {
		pluginError(w, http.StatusBadRequest, "bad_path")
		return nil, false
	}
	s := &served{name: path.Base(fp)}
	b, code := p.sessionDevice(r.PathValue("session"))
	switch code {
	case "":
		p.mu.Lock()
		inRoots := false
		for _, root := range p.conns[b.DeviceID].Hello.Roots {
			inRoots = inRoots || strings.HasPrefix(fp, root+"/")
		}
		data, inMemory := p.files[b.DeviceID][fp]
		name := p.conns[b.DeviceID].Claims.DeviceName
		p.mu.Unlock()
		if !inRoots {
			pluginError(w, http.StatusUnprocessableEntity, "read_refused")
			return nil, false
		}
		s.data, s.machine, s.mkind = data, name, hub.MachineDevice
		if b.DeviceID == p.sandbox {
			s.machine, s.mkind = "the sandbox", hub.MachineSandbox
		}
		if !inMemory {
			p.fr.mu.Lock()
			s.disk = p.fr.disk[b.DeviceID][fp]
			p.fr.mu.Unlock()
		}
	case "runs_on_pod":
		p.fr.mu.Lock()
		s.data = p.fr.server[fp]
		p.fr.mu.Unlock()
		s.machine, s.mkind = "the Hermes server", hub.MachineServer
	default:
		pluginError(w, http.StatusConflict, code)
		return nil, false
	}
	var head []byte
	switch {
	case s.data != nil:
		s.size, head = int64(len(s.data)), s.data[:min(len(s.data), 4096)]
	case s.disk != "":
		fi, err := os.Stat(s.disk)
		if err != nil {
			pluginError(w, http.StatusNotFound, "not_found")
			return nil, false
		}
		s.size = fi.Size()
		f, err := os.Open(s.disk)
		if err == nil {
			head = make([]byte, 4096)
			n, _ := io.ReadFull(f, head)
			head = head[:n]
			_ = f.Close()
		}
	default:
		pluginError(w, http.StatusNotFound, "not_found")
		return nil, false
	}
	p.fr.mu.Lock()
	allowed, secret := p.fr.secret[fp]
	s.mtimeNS = (1_700_000_000 + int64(p.fr.versions[fp])) * 1e9
	p.fr.mu.Unlock()
	if secret {
		if allowed == "" || offer != allowed {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			encode(w, map[string]any{"error": "read_refused", "message": "looks like a secret", "secret": true})
			return nil, false
		}
		s.secret, s.asked = true, true
	}
	s.mime, s.kind = hub.GuessFile(fp, head)
	return s, true
}

// statFile answers the stat route.
func (p *Plugin) statFile(w http.ResponseWriter, r *http.Request) {
	p.record(r, map[string]any{keyPath: r.URL.Query().Get(keyPath)})
	s, ok := p.find(w, r)
	if !ok {
		return
	}
	answer(w, map[string]any{"name": s.name, keyPath: r.URL.Query().Get(keyPath), "real": r.URL.Query().Get(keyPath),
		keySize: s.size, "mtime": float64(s.mtimeNS) / 1e9, "mime": s.mime, keyKind: s.kind, "type_label": "",
		"machine": s.machine, "machine_kind": s.mkind, "etag": s.etag(), "secret": s.secret, "requested": s.asked})
}

// streamFile answers the stream route: the bytes from offset, then, when
// CutStreamAt asked, an aborted connection.
func (p *Plugin) streamFile(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	offset, _ := strconv.ParseInt(q.Get("offset"), 10, 64)
	length, err := strconv.ParseInt(q.Get("length"), 10, 64)
	if err != nil {
		length = -1
	}
	p.record(r, map[string]any{keyPath: q.Get(keyPath)})
	p.fr.mu.Lock()
	p.fr.streams = append(p.fr.streams, StreamCall{Session: r.PathValue("session"), Path: q.Get(keyPath), Offer: q.Get("offer"),
		ETag: q.Get("etag"), Offset: offset, Length: length})
	cut := p.fr.cutAt
	p.fr.cutAt = 0
	p.fr.mu.Unlock()
	s, ok := p.find(w, r)
	if !ok {
		return
	}
	if e := q.Get("etag"); e != "" && e != s.etag() {
		pluginError(w, http.StatusPreconditionFailed, "changed")
		return
	}
	offset = min(max(offset, 0), s.size)
	if length < 0 || offset+length > s.size {
		length = s.size - offset
	}
	var body io.Reader
	if s.data != nil {
		body = strings.NewReader(string(s.data[offset : offset+length]))
	} else {
		f, err := os.Open(s.disk)
		if err != nil {
			pluginError(w, http.StatusNotFound, "not_found")
			return
		}
		defer f.Close()
		body = io.NewSectionReader(f, offset, length)
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Talaria-File-Size", strconv.FormatInt(s.size, 10))
	h.Set("X-Talaria-File-Mtime", strconv.FormatFloat(float64(s.mtimeNS)/1e9, 'f', -1, 64))
	h.Set("ETag", s.etag())
	if cut <= 0 || cut >= length {
		h.Set("Content-Length", strconv.FormatInt(length, 10))
		_, _ = io.Copy(w, body)
		return
	}
	_, _ = io.CopyN(w, body, cut)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	panic(http.ErrAbortHandler)
}
