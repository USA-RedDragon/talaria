package telegram_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/telegram"
)

const (
	offerPath  = "/home/alice/out/report.csv"
	offerBody  = "name,qty\nbob,3\n"
	reportName = "report.csv"
)

func sendFileResult(t *testing.T, status string, o hub.FileOffer) map[string]any {
	t.Helper()
	b, err := json.Marshal(map[string]any{"status": status, "file_offer": o})
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{kToolID: "sf1", kName: hub.SendFileTool, "result": string(b)}
}

func TestSendFileOfferIsADocument(t *testing.T) {
	t.Parallel()
	h := startBot(t, nil)
	h.hub.mu.Lock()
	h.hub.media = map[string]fakeFile{offerPath: {data: offerBody}}
	h.hub.mu.Unlock()
	sid := h.startTurn(t)
	h.hub.emit(t, sid, hub.KindToolComplete, sendFileResult(t, hub.OfferOffered, hub.FileOffer{ID: "fo_1", Name: reportName,
		Path: offerPath, Size: int64(len(offerBody)), Note: "Q3 <totals> & more", Requested: true}))
	doc := h.tg.wait(mDocument, "")
	if doc.Params["field"] != "document" || doc.Params["name"] != reportName || doc.Params["data"] != offerBody {
		t.Fatalf("document = %+v", doc.Params)
	}
	if want := "Q3 &lt;totals&gt; &amp; more\nSent at your request."; doc.Params["caption"] != want {
		t.Fatalf("caption = %q, want %q", doc.Params["caption"], want)
	}
	// A snapshot replay of the same result sends nothing more.
	h.hub.emit(t, sid, hub.KindToolComplete, sendFileResult(t, hub.OfferOffered, hub.FileOffer{ID: "fo_1", Name: reportName,
		Path: offerPath, Size: int64(len(offerBody))}))
	h.hub.emit(t, sid, hub.KindMessageComplete, map[string]any{kText: "Done.", kStatus: statusComplete})
	h.tg.wait(mSend, "Done.")
	if n := len(h.tg.find(mDocument, "")); n != 1 {
		t.Fatalf("documents = %d, want 1", n)
	}
	h.hub.mu.Lock()
	calls := h.hub.fileCalls
	h.hub.mu.Unlock()
	if len(calls) != 1 || !strings.HasPrefix(calls[0], userAlice+" "+beCluster+" "+sid+" "+offerPath+" 0 -1") {
		t.Fatalf("open calls = %q", calls)
	}
}

func TestSendFileOverTheLimitIsAHubLink(t *testing.T) {
	t.Parallel()
	h := startBot(t, nil)
	p := "/home/alice/out/big file.iso"
	h.hub.mu.Lock()
	h.hub.media = map[string]fakeFile{p: {data: "x"}}
	h.hub.mu.Unlock()
	sid := h.startTurn(t)
	h.hub.emit(t, sid, hub.KindToolComplete, sendFileResult(t, hub.OfferOffered, hub.FileOffer{ID: "fo_2", Name: "big file.iso",
		Path: p, Size: 3435973837}))
	msg := h.tg.wait(mSend, "is too large for Telegram")
	want := "<b>big file.iso</b> (3.2 GB) is too large for Telegram. Open it in the hub: <a href=\"https://hub.example/#/file/" +
		beCluster + "/" + sid + "/%2Fhome%2Falice%2Fout%2Fbig%20file.iso\">Open the file in the hub</a>"
	if !strings.Contains(msg.text(), want) {
		t.Fatalf("text = %q, want it to contain %q", msg.text(), want)
	}
	h.hub.mu.Lock()
	calls := h.hub.fileCalls
	h.hub.mu.Unlock()
	if len(calls) != 0 || len(h.tg.find(mDocument, "")) != 0 {
		t.Fatalf("file opened or uploaded: %q", calls)
	}
}

func TestSendFileRefusedIsOneLine(t *testing.T) {
	t.Parallel()
	h := startBot(t, nil)
	sid := h.startTurn(t)
	h.hub.emit(t, sid, hub.KindToolComplete, sendFileResult(t, hub.OfferRefused, hub.FileOffer{ID: "fo_3", Name: "secrets.env",
		Path: "/home/alice/app/.env", Reason: "looks like a secret", Secret: true}))
	h.tg.wait(mSend, "Did not send secrets.env: it looks like a secret. Ask for it in the chat if you want it anyway.")
	if len(h.tg.find(mDocument, "")) != 0 {
		t.Fatal("a refused file was sent")
	}
}

func TestSendFileUnavailable(t *testing.T) {
	t.Parallel()
	h := startBot(t, nil)
	h.hub.mu.Lock()
	h.hub.media = map[string]fakeFile{"/home/alice/a.txt": {err: hub.ErrMediaOffline}, "/home/alice/b.txt": {err: hub.ErrSecretFile},
		"/home/alice/c.txt": {err: errors.New("boom")}}
	h.hub.mu.Unlock()
	sid := h.startTurn(t)
	for i, n := range []string{"a.txt", "b.txt", "c.txt", "gone.txt"} {
		o := hub.FileOffer{ID: fmt.Sprintf("fo_u%d", i), Name: n, Path: "/home/alice/" + n, Size: 5}
		h.hub.emit(t, sid, hub.KindToolComplete, sendFileResult(t, hub.OfferOffered, o))
	}
	h.tg.wait(mSend, "Could not send a.txt: the computer that has it is offline.")
	h.tg.wait(mSend, "Did not send b.txt: it looks like a secret.")
	h.tg.wait(mSend, "Could not send c.txt. Open it in the hub&#39;s web page.")
	h.tg.wait(mSend, "Could not send gone.txt: it is no longer there.")
}

// countReader serves size bytes and counts them.
type countReader struct {
	n    atomic.Int64
	size int64
}

func (f *countReader) Read(p []byte) (int, error) {
	if f.n.Load() >= f.size {
		return 0, io.EOF
	}
	if rem := f.size - f.n.Load(); int64(len(p)) > rem {
		p = p[:rem]
	}
	for i := range p {
		p[i] = 'z'
	}
	f.n.Add(int64(len(p)))
	return len(p), nil
}

func TestDocumentUploadIsStreamed(t *testing.T) {
	t.Parallel()
	const size = 40 << 20
	src := &countReader{size: size}
	var readBeforeServer int64
	var got int64
	var contentLength int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contentLength = r.ContentLength
		time.Sleep(300 * time.Millisecond)
		readBeforeServer = src.n.Load()
		mr, err := r.MultipartReader()
		if err != nil {
			t.Errorf("multipart: %v", err)
			return
		}
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			n, _ := io.Copy(io.Discard, part)
			if part.FileName() != "" {
				got = n
			}
		}
		_, _ = w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer srv.Close()
	c := telegram.NewClient(srv.URL, testToken, srv.Client(), 0, slog.New(slog.DiscardHandler))
	if err := c.SendDocumentStream(context.Background(), 7, 0, "big.zip", size, src, ""); err != nil {
		t.Fatal(err)
	}
	if got != size {
		t.Fatalf("server got %d file bytes, want %d", got, size)
	}
	if contentLength < size {
		t.Fatalf("content length = %d", contentLength)
	}
	// Socket buffers hold a few MB at most; the whole file (40 MB) was not read ahead.
	if readBeforeServer > 8<<20 {
		t.Fatalf("read %d bytes before the server read any: the upload is buffered", readBeforeServer)
	}
}

func TestDocumentUploadEndingEarlyFails(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer srv.Close()
	c := telegram.NewClient(srv.URL, testToken, srv.Client(), 0, slog.New(slog.DiscardHandler))
	if err := c.SendDocumentStream(context.Background(), 7, 0, "a.bin", 100, bytes.NewReader(make([]byte, 10)), ""); err == nil {
		t.Fatal("a short body was accepted")
	}
}

// A reply's non-image file goes as a streamed document of its size.
func TestReplyDocumentIsStreamed(t *testing.T) {
	t.Parallel()
	h := startBot(t, nil)
	data := strings.Repeat("0123456789", 1<<20)
	h.hub.mu.Lock()
	h.hub.media = map[string]fakeFile{"/opt/data/out/big.zip": {data: data}}
	h.hub.mu.Unlock()
	sid := h.startTurn(t)
	h.hub.emit(t, sid, hub.KindMessageComplete, map[string]any{kText: "MEDIA:/opt/data/out/big.zip", kStatus: statusComplete})
	doc := h.tg.wait(mDocument, "")
	if doc.Params["name"] != "big.zip" || doc.Params["data"] != data {
		t.Fatalf("document name %v, %d bytes", doc.Params["name"], len(fmt.Sprint(doc.Params["data"])))
	}
	if _, ok := doc.Params["caption"]; ok {
		t.Fatalf("caption = %v", doc.Params["caption"])
	}
}
