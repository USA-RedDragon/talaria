package web_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/pdf"
	"github.com/USA-RedDragon/talaria/hub/internal/pdf/pdftest"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
)

const (
	srcDir     = "/home/alice/src"
	archive    = srcDir + "/dist/build.tar.zst"
	envFile    = srcDir + "/.env"
	offerID    = "fo_0123456789abcdef"
	secretID   = "fo_fedcba9876543210"
	titleFiles = "Files"
	keyState   = "state"
	digits     = "0123456789"
	buildName  = "build.tar.zst"
	secretWhy  = "looks like a secret"
	cspSandbox = "default-src 'none'; sandbox"
	hdrRange   = "Range"
	hdrIfRange = "If-Range"
	from4      = "bytes=4-"
)

// sendFileRows are the transcript rows of a send_file call and its result.
func sendFileRows(id, p, status string, offer map[string]any) []map[string]any {
	offer["path"] = p
	res, err := json.Marshal(map[string]any{keyStatus: status, "file_offer": offer, "message": "Offered the file."})
	if err != nil {
		panic(err)
	}
	return []map[string]any{
		{kRole: roleAssistant, kText: "", kCalls: []map[string]any{{"id": id, fnKey: map[string]any{fieldName: hub.SendFileTool, ilArgs: `{"path":"` + p + `"}`}}}},
		{kRole: stepTool, kCallID: id, "content": string(res)},
	}
}

func fileURL(e *hubEnv, session, route, p string) string {
	return e.url + "/api/sessions/pc/" + session + "/media" + route + "?path=" + url.QueryEscape(p)
}

// filesEnv is a hub whose chats run on a fake device with files in memory.
func filesEnv(t *testing.T, fn func(cfg *config.Config, opts *web.Options, st *store.Store), sfn func(o *service.Options), msgs ...map[string]any) (*hubEnv, *deviceFiles, *http.Client, me) {
	t.Helper()
	e := setupService(t, fn, sfn)
	dev := &deviceFiles{files: map[string]string{archive: digits, envFile: "TOKEN=x"}, secret: map[string]string{envFile: secretID}}
	e.svc.SetFiles(dev)
	e.gw.AddSession(&gatewaytest.Session{ID: "f1", Title: titleFiles, Live: true, StartedAt: 300, Messages: msgs})
	e.gw.AddSession(&gatewaytest.Session{ID: "f2", Title: "Elsewhere", Live: true, StartedAt: 200})
	c := client(t)
	m := login(t, e, c)
	return e, dev, c, m
}

func doReq(t *testing.T, c *http.Client, method, u string, hdr map[string]string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequestWithContext(context.Background(), method, u, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func infoOf(t *testing.T, c *http.Client, u string) map[string]any {
	t.Helper()
	resp, body := get(t, c, u)
	var m map[string]any
	if resp.StatusCode != http.StatusOK || json.Unmarshal([]byte(body), &m) != nil {
		t.Fatalf("info = %d %s", resp.StatusCode, body)
	}
	return m
}

// A send_file result offers its file whatever the extension, with its
// offer id passed on to the plugin; a refused one answers 403 with the
// reason; another session, and a path no chat offered, get 404.
func TestFileOfferedBySendFile(t *testing.T) {
	t.Parallel()
	rows := append(sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID, fieldName: buildName, "size": 10, "kind": hub.FileKindArchive,
		"type_label": "Zstandard tar", "machine": pcName, "machine_kind": hub.MachineDevice}),
		sendFileRows("c2", envFile, hub.OfferRefused, map[string]any{"id": secretID, fieldName: ".env", "machine": pcName, "reason": secretWhy, "secret": true})...)
	e, dev, c, _ := filesEnv(t, nil, nil, rows...)
	resp, body := get(t, c, fileURL(e, "f1", "", archive))
	h := resp.Header
	if resp.StatusCode != http.StatusOK || body != digits || h.Get("Content-Type") != octetStream || h.Get("Accept-Ranges") != "bytes" ||
		h.Get("Content-Disposition") != "attachment; filename=build.tar.zst" || h.Get("ETag") == "" || h.Get("Last-Modified") == "" ||
		h.Get("Content-Security-Policy") != cspSandbox || h.Get("Content-Length") != "10" {
		t.Fatalf("offered = %d %q %v", resp.StatusCode, body, h)
	}
	if dev.offers[len(dev.offers)-1] != offerID {
		t.Fatalf("offer ids = %q", dev.offers)
	}
	info := infoOf(t, c, fileURL(e, "f1", "/info", archive))
	if info[keyState] != "ready" || info["type_label"] != "Zstandard tar" || info["kind"] != hub.FileKindArchive || info["size"] != float64(10) {
		t.Fatalf("info = %v", info)
	}
	resp, body = get(t, c, fileURL(e, "f1", "", envFile))
	var refused map[string]string
	if resp.StatusCode != http.StatusForbidden || json.Unmarshal([]byte(body), &refused) != nil || refused["error"] != "refused" || refused["reason"] != secretWhy {
		t.Fatalf("refused = %d %s", resp.StatusCode, body)
	}
	if info = infoOf(t, c, fileURL(e, "f1", "/info", envFile)); info[keyState] != "refused" || info["reason"] != secretWhy || info["name"] != ".env" || info["secret"] != true {
		t.Fatalf("refused info = %v", info)
	}
	before := len(dev.read())
	for _, u := range []string{fileURL(e, "f2", "", archive), fileURL(e, "f1", "", srcDir+"/other.zip"), fileURL(e, "f2", "/info", archive)} {
		if resp, body = get(t, c, u); resp.StatusCode != http.StatusNotFound || !strings.Contains(body, hub.ErrNoMedia.Error()) {
			t.Fatalf("%s = %d %s", u, resp.StatusCode, body)
		}
	}
	if len(dev.read()) != before {
		t.Fatalf("refused paths were read: %q", dev.read()[before:])
	}
}

// A send_file result that arrives as a live tool.complete event offers
// its file at once.
func TestFileOfferedByLiveSendFile(t *testing.T) {
	t.Parallel()
	e, _, c, _ := filesEnv(t, nil, nil)
	if resp, _ := get(t, c, fileURL(e, "f1", "", archive)); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("before the offer = %d", resp.StatusCode)
	}
	res := `{"status":"offered","file_offer":{"id":"` + offerID + `","name":"build.tar.zst","path":"` + archive + `","size":10}}`
	e.gw.Publish("f1", "tool.start", map[string]any{sjToolID: "t1", fieldName: hub.SendFileTool})
	e.gw.Publish("f1", "tool.complete", map[string]any{sjToolID: "t1", fieldName: hub.SendFileTool, sjResult: res})
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, body := get(t, c, fileURL(e, "f1", "", archive))
		if resp.StatusCode == http.StatusOK && body == digits {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after the offer = %d %s", resp.StatusCode, body)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A Markdown link in a reply offers a file of any extension; a MEDIA
// directive still needs one Hermes delivers.
func TestFileOfferedByMarkdownLink(t *testing.T) {
	t.Parallel()
	code, bin, directive := srcDir+"/main.go", srcDir+"/firmware.uf2", srcDir+"/tool.uf2"
	e, dev, c, _ := filesEnv(t, nil, nil, map[string]any{kRole: roleAssistant, kText: "Here is [main.go](" + code + ") and [the image](<" + bin + ">).\nMEDIA:" + directive})
	dev.mu.Lock()
	dev.files[code], dev.files[bin], dev.files[directive] = "package main\n", "\x00\x01uf2", "\x00uf2"
	dev.mu.Unlock()
	resp, body := get(t, c, fileURL(e, "f1", "", code))
	if resp.StatusCode != http.StatusOK || body != "package main\n" || resp.Header.Get("Content-Type") != hub.MIMEText ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), "inline") {
		t.Fatalf("code = %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if resp, body = get(t, c, fileURL(e, "f1", "", bin)); resp.StatusCode != http.StatusOK || body != "\x00\x01uf2" || resp.Header.Get("Content-Type") != octetStream {
		t.Fatalf("bin = %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if resp, _ = get(t, c, fileURL(e, "f1", "", directive)); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a MEDIA directive of an extension Hermes does not deliver = %d", resp.StatusCode)
	}
}

// Only users of the backend get its files, as with every chat route.
func TestFileOwnerOnly(t *testing.T) {
	t.Parallel()
	e, dev, _, _ := filesEnv(t, nil, nil, sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID})...)
	e.is.as("sub-bob", userBob, "family")
	bob := client(t)
	m := login(t, e, bob)
	for _, u := range []string{fileURL(e, "f1", "", archive), fileURL(e, "f1", "/info", archive), fileURL(e, "f1", "/preview", archive)} {
		if resp, body := get(t, bob, u); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("bob %s = %d %s", u, resp.StatusCode, body)
		}
	}
	if resp, _ := post(t, bob, fileURL(e, "f1", "/stop", archive), m.CSRF, "", nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("bob stop = %d", resp.StatusCode)
	}
	if len(dev.read()) != 0 {
		t.Fatalf("bob read %q", dev.read())
	}
}

// One byte range answers 206 with Content-Range; a range past the end
// 416; If-Range with the file's etag or date resumes, any other answers
// the whole file; several ranges answer the whole file; HEAD answers the
// headers.
func TestFileRange(t *testing.T) {
	t.Parallel()
	e, _, c, _ := filesEnv(t, nil, nil, sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID})...)
	u := fileURL(e, "f1", "", archive)
	full, _ := get(t, c, u)
	etag, modified := full.Header.Get("ETag"), full.Header.Get("Last-Modified")
	for _, c2 := range []struct {
		hdr          map[string]string
		status       int
		body, cRange string
	}{
		{map[string]string{hdrRange: "bytes=3-6"}, http.StatusPartialContent, "3456", "bytes 3-6/10"},
		{map[string]string{hdrRange: "bytes=7-"}, http.StatusPartialContent, "789", "bytes 7-9/10"},
		{map[string]string{hdrRange: "bytes=-2"}, http.StatusPartialContent, "89", "bytes 8-9/10"},
		{map[string]string{hdrRange: "bytes=8-100"}, http.StatusPartialContent, "89", "bytes 8-9/10"},
		{map[string]string{hdrRange: "bytes=10-"}, http.StatusRequestedRangeNotSatisfiable, "", "bytes */10"},
		{map[string]string{hdrRange: from4, hdrIfRange: etag}, http.StatusPartialContent, "456789", "bytes 4-9/10"},
		{map[string]string{hdrRange: from4, hdrIfRange: modified}, http.StatusPartialContent, "456789", "bytes 4-9/10"},
		{map[string]string{hdrRange: from4, hdrIfRange: `"old"`}, http.StatusOK, digits, ""},
		{map[string]string{hdrRange: "bytes=0-1,4-5"}, http.StatusOK, digits, ""},
		{map[string]string{hdrRange: "lines=1-2"}, http.StatusOK, digits, ""},
	} {
		resp, body := doReq(t, c, http.MethodGet, u, c2.hdr)
		if resp.StatusCode != c2.status || resp.Header.Get("Content-Range") != c2.cRange ||
			c2.status != http.StatusRequestedRangeNotSatisfiable && body != c2.body {
			t.Fatalf("%v = %d %q %v", c2.hdr, resp.StatusCode, body, resp.Header)
		}
	}
	resp, body := doReq(t, c, http.MethodHead, u, nil)
	if resp.StatusCode != http.StatusOK || body != "" || resp.Header.Get("Content-Length") != "10" || resp.Header.Get("ETag") != etag ||
		resp.Header.Get("Accept-Ranges") != "bytes" {
		t.Fatalf("HEAD = %d %q %v", resp.StatusCode, body, resp.Header)
	}
}

// A file over the backend's max_file_bytes answers 413, and its info
// says too_large with the size.
func TestFileCap(t *testing.T) {
	t.Parallel()
	e, _, c, _ := filesEnv(t, func(cfg *config.Config, _ *web.Options, _ *store.Store) { cfg.Backends[0].MaxFileBytes = 9 }, nil,
		sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID})...)
	if resp, body := get(t, c, fileURL(e, "f1", "", archive)); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over the cap = %d %s", resp.StatusCode, body)
	}
	if resp, _ := doReq(t, c, http.MethodGet, fileURL(e, "f1", "", archive), map[string]string{hdrRange: "bytes=0-1"}); resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("a range over the cap = %d", resp.StatusCode)
	}
	if info := infoOf(t, c, fileURL(e, "f1", "/info", archive)); info[keyState] != "too_large" || info["size"] != float64(10) {
		t.Fatalf("info = %v", info)
	}
	if cfg := e.cfg.Backends[1]; cfg.MaxFileBytes != hub.DefaultMaxFileBytes {
		t.Fatalf("default cap = %d", cfg.MaxFileBytes)
	}
}

// Info says ready, offline (503 on download) or gone (404 on download).
func TestFileInfoStates(t *testing.T) {
	t.Parallel()
	gone := srcDir + "/gone.zip"
	rows := append(sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID}), sendFileRows("c2", gone, hub.OfferOffered, map[string]any{"id": secretID})...)
	e, dev, c, _ := filesEnv(t, nil, nil, rows...)
	info := infoOf(t, c, fileURL(e, "f1", "/info", archive))
	ts, _ := info["transfers"].([]any)
	if info[keyState] != "ready" || info["name"] != buildName || info["machine"] != pcName || info["machine_kind"] != hub.MachineDevice ||
		info["mtime"] != float64(1_700_000_000) || len(ts) != 0 {
		t.Fatalf("ready = %v", info)
	}
	if info = infoOf(t, c, fileURL(e, "f1", "/info", gone)); info[keyState] != "gone" || info["name"] != "gone.zip" {
		t.Fatalf("gone = %v", info)
	}
	if resp, body := get(t, c, fileURL(e, "f1", "", gone)); resp.StatusCode != http.StatusNotFound || !strings.Contains(body, "moved or deleted") {
		t.Fatalf("gone download = %d %s", resp.StatusCode, body)
	}
	dev.mu.Lock()
	dev.offline = true
	dev.mu.Unlock()
	if info = infoOf(t, c, fileURL(e, "f1", "/info", archive)); info[keyState] != "offline" {
		t.Fatalf("offline = %v", info)
	}
	if resp, _ := get(t, c, fileURL(e, "f1", "", archive)); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("offline download = %d", resp.StatusCode)
	}
}

// A download in progress shows in info with its bytes; /media/stop ends it
// and it leaves info.
func TestFileStop(t *testing.T) {
	t.Parallel()
	e, dev, c, m := filesEnv(t, nil, nil, sendFileRows("c1", archive, hub.OfferOffered, map[string]any{"id": offerID})...)
	dev.mu.Lock()
	dev.hold = true
	dev.mu.Unlock()
	ended := make(chan error, 1)
	go func() {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, fileURL(e, "f1", "", archive), nil)
		resp, err := (&http.Client{Jar: c.Jar}).Do(req)
		if err == nil {
			_, err = io.ReadAll(resp.Body)
			_ = resp.Body.Close()
		}
		ended <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		ts, _ := infoOf(t, c, fileURL(e, "f1", "/info", archive))["transfers"].([]any)
		if len(ts) == 1 {
			tr, _ := ts[0].(map[string]any)
			if started, _ := tr["started"].(float64); tr["sent"] == float64(4) && tr["total"] == float64(10) && started > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("transfers = %v", ts)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if resp, _ := post(t, c, fileURL(e, "f1", "/stop", archive), "", "", nil); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("stop without CSRF = %d", resp.StatusCode)
	}
	if resp, _ := post(t, c, fileURL(e, "f1", "/stop", archive), m.CSRF, "", nil); resp.StatusCode != http.StatusNoContent {
		t.Fatalf("stop = %d", resp.StatusCode)
	}
	select {
	case err := <-ended:
		if err == nil {
			t.Fatal("a stopped download ended cleanly")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not end the download")
	}
	for ts, _ := infoOf(t, c, fileURL(e, "f1", "/info", archive))["transfers"].([]any); len(ts) != 0; ts, _ = infoOf(t, c, fileURL(e, "f1", "/info", archive))["transfers"].([]any) {
		if time.Now().After(deadline) {
			t.Fatalf("transfers after stop = %v", ts)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The preview of an offered PDF is a PNG of page 1 with the page count;
// other files have none.
func TestFilePreviewPDF(t *testing.T) {
	t.Parallel()
	r := pdf.New(t.TempDir(), 0)
	if !r.Available() {
		t.Skip("poppler-utils is not installed")
	}
	report := srcDir + "/report.pdf"
	rows := append(sendFileRows("c1", report, hub.OfferOffered, map[string]any{"id": offerID, "kind": hub.FileKindPDF}),
		sendFileRows("c2", archive, hub.OfferOffered, map[string]any{"id": secretID})...)
	e, dev, c, _ := filesEnv(t, nil, func(o *service.Options) { o.PDF = r }, rows...)
	dev.mu.Lock()
	dev.files[report] = string(pdftest.Make("Quarterly report for alice", "Page two", "Page three"))
	dev.mu.Unlock()
	resp, body := get(t, c, fileURL(e, "f1", "/preview", report))
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != hub.MIMEPNG || resp.Header.Get("X-Talaria-Pages") != "3" ||
		!strings.HasPrefix(body, "\x89PNG") {
		t.Fatalf("preview = %d %v %d bytes", resp.StatusCode, resp.Header, len(body))
	}
	if resp, _ = get(t, c, fileURL(e, "f1", "/preview", archive)); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("an archive's preview = %d", resp.StatusCode)
	}
	if resp, _ = get(t, c, fileURL(e, "f1", "", report)); resp.Header.Get("Content-Type") != hub.MIMEPDF {
		t.Fatalf("pdf = %v", resp.Header)
	}
}
