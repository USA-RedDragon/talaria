package web

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// copyBuffer is the size of the writes of a file to the browser.
const copyBuffer = 256 << 10

// handleMedia streams a file the session offered (a send_file result, a
// Markdown link, a MEDIA directive, a browser_screenshot result, an
// attached image or a vision call), from where the chat runs, without a
// copy on the hub. It answers one byte range (206) for a resumed or
// partial download, and HEAD. Images, PDFs, audio, video and text show
// inline unless download=1; other files and secret ones download.
func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	files, ok := s.svc.(hub.Files)
	p := r.URL.Query().Get("path")
	if !ok || !hub.FilePath(p) {
		errorJSON(w, http.StatusNotFound, hub.ErrNoMedia.Error())
		return
	}
	user, backendID, sessionID := userFrom(r), r.PathValue("backend"), r.PathValue("session")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var fi *hub.FileInfo
	var err error
	start, length, partial := int64(0), int64(-1), false
	rng := r.Header.Get("Range")
	if r.Method == http.MethodHead || rng != "" {
		if fi, err = files.StatFile(ctx, user, backendID, sessionID, p); err != nil {
			s.fileError(w, err)
			return
		}
		if rng != "" && fi.Size >= 0 && ifRange(r.Header.Get("If-Range"), fi) {
			sp, valid := parseRange(rng, fi.Size)
			switch {
			case valid && sp.unsatisfiable:
				w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", fi.Size))
				errorJSON(w, http.StatusRequestedRangeNotSatisfiable, "the range is outside the file")
				return
			case valid:
				start, length, partial = sp.start, sp.length, true
			}
		}
	}
	if r.Method == http.MethodHead {
		fileHeaders(w, r, fi)
		w.Header().Set("Content-Length", strconv.FormatInt(fi.Size, 10))
		w.WriteHeader(http.StatusOK)
		return
	}
	etag := ""
	if fi != nil {
		etag = fi.ETag
	}
	key := transferKey(user, backendID, sessionID, p)
	t := s.transfers.start(key, cancel)
	defer s.transfers.end(key, t)
	ofi, body, err := files.OpenFile(ctx, user, backendID, sessionID, p, start, length, etag)
	if err != nil {
		s.fileError(w, err)
		return
	}
	defer body.Close()
	// A stop or a closed browser ends the read even while it waits.
	defer context.AfterFunc(ctx, func() { _ = body.Close() })()
	fi = ofi
	fileHeaders(w, r, fi)
	h := w.Header()
	total := fi.Size - start
	if partial {
		total = length
		h.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, start+length-1, fi.Size))
	}
	t.total.Store(total)
	if total >= 0 {
		h.Set("Content-Length", strconv.FormatInt(total, 10))
	}
	if partial {
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	if err := copyFile(w, body, &t.sent); err != nil {
		s.log.Debug("file copy ended", "error", err.Error())
	}
}

// copyFile copies body to w and counts the bytes in sent.
func copyFile(w io.Writer, body io.Reader, sent *atomic.Int64) error {
	buf := make([]byte, copyBuffer)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			sent.Add(int64(n))
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// inlineMIME is the type a browser shows the file inline as, or "" for
// a download: raster images, PDFs, audio, video and text, never a
// secret.
func inlineMIME(fi *hub.FileInfo) string {
	if fi.Secret {
		return ""
	}
	base, _, _ := strings.Cut(fi.MIME, ";")
	switch fi.Kind {
	case hub.FileKindImage:
		if slices.Contains(hub.ImageMIMEs(), base) {
			return base
		}
	case hub.FileKindPDF:
		return hub.MIMEPDF
	case hub.FileKindAudio, hub.FileKindVideo:
		if strings.HasPrefix(base, fi.Kind+"/") {
			return base
		}
	case hub.FileKindText, hub.FileKindCode:
		return hub.MIMEText
	}
	return ""
}

// fileHeaders sets the headers of a file answer.
func fileHeaders(w http.ResponseWriter, r *http.Request, fi *hub.FileInfo) {
	h := w.Header()
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	if fi.MachineKind == hub.MachineServer && fi.ETag == "" {
		h.Set("Cache-Control", "private, max-age=300")
	} else {
		h.Set("Cache-Control", "no-store")
	}
	if fi.Size >= 0 {
		h.Set("Accept-Ranges", "bytes")
	}
	if fi.ETag != "" {
		h.Set("ETag", fi.ETag)
	}
	if !fi.ModTime.IsZero() {
		h.Set("Last-Modified", fi.ModTime.UTC().Format(http.TimeFormat))
	}
	disposition := "attachment"
	if t := inlineMIME(fi); t != "" && r.URL.Query().Get("download") == "" {
		h.Set("Content-Type", t)
		disposition = "inline"
	} else {
		h.Set("Content-Type", "application/octet-stream")
	}
	name := fi.Name
	if name == "" {
		name = hub.ShowName(path.Base(fi.Path))
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": name}))
}

// byteRange is one range of a Range header.
type byteRange struct {
	start, length int64
	unsatisfiable bool
}

// parseRange reads a Range header of one byte range against a file of
// size bytes. valid is false for a header the hub ignores and answers
// with the whole file: another unit, several ranges, or bad syntax.
func parseRange(h string, size int64) (byteRange, bool) {
	spec, ok := strings.CutPrefix(h, "bytes=")
	if !ok || strings.Contains(spec, ",") {
		return byteRange{}, false
	}
	first, last, ok := strings.Cut(strings.TrimSpace(spec), "-")
	if !ok {
		return byteRange{}, false
	}
	if first == "" {
		n, err := strconv.ParseInt(last, 10, 64)
		if err != nil || n < 0 {
			return byteRange{}, false
		}
		if n == 0 || size == 0 {
			return byteRange{unsatisfiable: true}, true
		}
		n = min(n, size)
		return byteRange{start: size - n, length: n}, true
	}
	a, err := strconv.ParseInt(first, 10, 64)
	if err != nil || a < 0 {
		return byteRange{}, false
	}
	end := size - 1
	if last != "" {
		b, err := strconv.ParseInt(last, 10, 64)
		if err != nil || b < a {
			return byteRange{}, false
		}
		end = min(b, size-1)
	}
	if a >= size {
		return byteRange{unsatisfiable: true}, true
	}
	return byteRange{start: a, length: end - a + 1}, true
}

// ifRange reports whether a Range applies under an If-Range header: none,
// a strong entity tag equal to the file's, or the file's Last-Modified
// date.
func ifRange(h string, fi *hub.FileInfo) bool {
	h = strings.TrimSpace(h)
	switch {
	case h == "":
		return true
	case strings.HasPrefix(h, `"`):
		return fi.ETag != "" && h == fi.ETag
	case strings.HasPrefix(h, "W/"):
		return false
	}
	t, err := http.ParseTime(h)
	return err == nil && !fi.ModTime.IsZero() && fi.ModTime.UTC().Truncate(time.Second).Equal(t.UTC())
}

// fileError answers a refused file: a secret file 403 with the reason,
// one the session never offered or that is gone 404, an offline computer
// 503, a file over the cap 413.
func (s *Server) fileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, hub.ErrSecretFile):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "refused", "reason": hub.RefusalReason(err)})
	case errors.Is(err, hub.ErrFileGone):
		errorJSON(w, http.StatusNotFound, "the file was moved or deleted")
	case errors.Is(err, hub.ErrNoMedia):
		errorJSON(w, http.StatusNotFound, hub.ErrNoMedia.Error())
	case errors.Is(err, hub.ErrMediaTooLarge):
		errorJSON(w, http.StatusRequestEntityTooLarge, "the file is too large")
	case errors.Is(err, hub.ErrMediaOffline):
		errorJSON(w, http.StatusServiceUnavailable, hub.ErrMediaOffline.Error())
	case errors.Is(err, hub.ErrFileChanged):
		errorJSON(w, http.StatusConflict, hub.ErrFileChanged.Error())
	case errors.Is(err, context.Canceled):
		errorJSON(w, http.StatusConflict, "the transfer was stopped")
	default:
		s.fail(w, err)
	}
}

// File states of /media/info.
const (
	fileReady    = "ready"
	fileOffline  = "offline"
	fileGone     = "gone"
	fileRefused  = "refused"
	fileTooLarge = "too_large"
)

type transferJSON struct {
	Sent      int64   `json:"sent"`
	Total     int64   `json:"total"`
	BytesPerS float64 `json:"bytes_per_s"`
	Started   float64 `json:"started"`
}

type fileInfoJSON struct {
	State       string         `json:"state"`
	Name        string         `json:"name"`
	Path        string         `json:"path"`
	Size        *int64         `json:"size,omitempty"`
	MIME        string         `json:"mime,omitempty"`
	Kind        string         `json:"kind,omitempty"`
	TypeLabel   string         `json:"type_label,omitempty"`
	MTime       float64        `json:"mtime,omitempty"`
	Machine     string         `json:"machine,omitempty"`
	MachineKind string         `json:"machine_kind,omitempty"`
	Secret      bool           `json:"secret"`
	Requested   bool           `json:"requested"`
	Lines       int            `json:"lines,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Transfers   []transferJSON `json:"transfers"`
}

// handleMediaInfo says what the hub knows of an offered file and whether
// it can serve it now, and lists this user's downloads of it that run.
func (s *Server) handleMediaInfo(w http.ResponseWriter, r *http.Request) {
	files, ok := s.svc.(hub.Files)
	p := r.URL.Query().Get("path")
	if !ok || !hub.FilePath(p) {
		errorJSON(w, http.StatusNotFound, hub.ErrNoMedia.Error())
		return
	}
	user, backendID, sessionID := userFrom(r), r.PathValue("backend"), r.PathValue("session")
	fi, err := files.StatFile(r.Context(), user, backendID, sessionID, p)
	out := fileInfoJSON{State: fileReady, Name: hub.ShowName(path.Base(p)), Path: p,
		Transfers: s.transfers.list(transferKey(user, backendID, sessionID, p))}
	switch {
	case err == nil:
	case errors.Is(err, hub.ErrSecretFile):
		out.State, out.Reason, out.Secret = fileRefused, hub.RefusalReason(err), true
	case errors.Is(err, hub.ErrMediaTooLarge):
		out.State = fileTooLarge
	case errors.Is(err, hub.ErrMediaOffline):
		out.State, out.Reason = fileOffline, hub.ErrMediaOffline.Error()
	case errors.Is(err, hub.ErrFileGone):
		out.State, out.Reason = fileGone, "the file was moved or deleted"
	default:
		s.fileError(w, err)
		return
	}
	if fi != nil {
		if fi.Name != "" {
			out.Name = fi.Name
		}
		if fi.Size >= 0 && (err == nil || out.State == fileTooLarge) {
			out.Size = &fi.Size
		}
		out.MIME, out.Kind, out.TypeLabel, out.Lines = fi.MIME, fi.Kind, fi.TypeLabel, fi.Lines
		out.Machine, out.MachineKind = fi.Machine, fi.MachineKind
		out.Secret, out.Requested = out.Secret || fi.Secret, fi.Requested
		if !fi.ModTime.IsZero() {
			out.MTime = float64(fi.ModTime.UnixNano()) / 1e9
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

// handleMediaStop stops this user's downloads of a file.
func (s *Server) handleMediaStop(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !hub.FilePath(p) {
		errorJSON(w, http.StatusNotFound, hub.ErrNoMedia.Error())
		return
	}
	s.transfers.stop(transferKey(userFrom(r), r.PathValue("backend"), r.PathValue("session"), p))
	w.WriteHeader(http.StatusNoContent)
}

// handleMediaPreview answers a PNG of the first page of an offered PDF,
// with its page count in X-Talaria-Pages.
func (s *Server) handleMediaPreview(w http.ResponseWriter, r *http.Request) {
	pv, ok := s.svc.(hub.FilePreviews)
	p := r.URL.Query().Get("path")
	if !ok || !hub.FilePath(p) {
		errorJSON(w, http.StatusNotFound, hub.ErrNoMedia.Error())
		return
	}
	png, pages, err := pv.FilePreview(r.Context(), userFrom(r), r.PathValue("backend"), r.PathValue("session"), p)
	if errors.Is(err, hub.ErrNoPreview) {
		errorJSON(w, http.StatusNotFound, hub.ErrNoPreview.Error())
		return
	}
	if err != nil {
		s.fileError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", hub.MIMEPNG)
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, max-age=300")
	h.Set("X-Talaria-Pages", strconv.Itoa(pages))
	h.Set("Content-Length", strconv.Itoa(len(png)))
	_, _ = w.Write(png) //nolint:gosec // a PNG that pdftoppm rendered, served as image/png with a sandbox CSP
}

// transfer is one download in progress.
type transfer struct {
	sent    atomic.Int64
	total   atomic.Int64
	started time.Time
	cancel  context.CancelFunc
}

// transfers are the downloads in progress on this replica, by user,
// backend, session and path.
type transfers struct {
	mu sync.Mutex
	m  map[string][]*transfer
}

func transferKey(user, backendID, sessionID, p string) string {
	return strings.Join([]string{user, backendID, sessionID, p}, "\x00")
}

func (ts *transfers) start(key string, cancel context.CancelFunc) *transfer {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	if ts.m == nil {
		ts.m = map[string][]*transfer{}
	}
	t := &transfer{started: time.Now(), cancel: cancel}
	t.total.Store(-1)
	ts.m[key] = append(ts.m[key], t)
	return t
}

func (ts *transfers) end(key string, t *transfer) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.m[key] = slices.DeleteFunc(ts.m[key], func(x *transfer) bool { return x == t })
	if len(ts.m[key]) == 0 {
		delete(ts.m, key)
	}
}

// list is the downloads of key that run, oldest first.
func (ts *transfers) list(key string) []transferJSON {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	out := make([]transferJSON, 0, len(ts.m[key]))
	now := time.Now()
	for _, t := range ts.m[key] {
		sent := t.sent.Load()
		j := transferJSON{Sent: sent, Total: t.total.Load(), Started: float64(t.started.UnixNano()) / 1e9}
		if d := now.Sub(t.started).Seconds(); d > 0 {
			j.BytesPerS = float64(sent) / d
		}
		out = append(out, j)
	}
	return out
}

// stop cancels the downloads of key.
func (ts *transfers) stop(key string) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for _, t := range ts.m[key] {
		t.cancel()
	}
}
