package web_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	mrand "math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/config"
	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/device/devicetest"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/hub/internal/web"
	"github.com/USA-RedDragon/talaria/protocol"
)

const (
	bigSize = 200 << 20
	bigCut  = 80 << 20
)

// writeRandom writes n random bytes to p and returns their sha256.
func writeRandom(t *testing.T, p string, n int64) string {
	t.Helper()
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var seed [32]byte
	_, _ = rand.Read(seed[:])
	h := sha256.New()
	if _, err := io.CopyN(io.MultiWriter(f, h), mrand.NewChaCha8(seed), n); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sumFile(t *testing.T, p string) string {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// mediaLog records the status and Range of each /media download.
type mediaLog struct {
	mu   sync.Mutex
	seen []string
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (l *mediaLog) wrap(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/media") {
			h.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		h.ServeHTTP(sw, r)
		l.mu.Lock()
		defer l.mu.Unlock()
		l.seen = append(l.seen, r.Method+" "+r.Header.Get("Range")+" "+r.Header.Get("If-Range")+" "+http.StatusText(sw.status))
	})
}

func (l *mediaLog) list() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.seen...)
}

// Real headless Chrome downloads a 200 MB file that a send_file result
// offered, through the hub's /media route from the device plugin's
// stream. The plugin cuts the connection once at 80 MB; Chrome resumes
// with a Range and If-Range, the hub answers 206 from where it stopped,
// and the saved file's sha256 is the source's.
func TestDownloadResumesInChrome(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("downloads 200 MB")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	work := t.TempDir()
	src := filepath.Join(work, "source.bin")
	want := writeRandom(t, src, bigSize)
	downloads := filepath.Join(work, "downloads")
	if err := os.Mkdir(downloads, 0o700); err != nil {
		t.Fatal(err)
	}
	devPath := srcAlice + "/dist/firmware-image.bin"
	e, plugin, devID := setupDevicesWithFiles(t)
	plugin.SetDiskFile(devID, devPath, src)
	plugin.SetBinding("s-big", devID, srcAlice)
	e.gw.AddSession(&gatewaytest.Session{ID: "s-big", Title: "Big file", Live: true, StartedAt: 900,
		Messages: sendFileRows("c1", devPath, hub.OfferOffered, map[string]any{"id": offerID, fieldName: "firmware-image.bin", "size": bigSize})})
	log := &mediaLog{}
	e.front.to(log.wrap(e.ui.Handler()))
	plugin.CutStreamAt(bigCut)
	prof := filepath.Join(work, "profile")
	ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
	defer cancel()
	u := e.url + "/api/sessions/pc/s-big/media?download=1&path=" + strings.ReplaceAll(devPath, "/", "%2F")
	out, err := browserCmd(ctx, t, node, filepath.Join("testdata", "download", "run.js"), chrome, e.url, prof, u, downloads).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s\nmedia requests: %q", err, out, log.list())
	}
	var res struct {
		File  string `json:"file"`
		Bytes int64  `json:"bytes"`
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if json.Unmarshal([]byte(lines[len(lines)-1]), &res) != nil {
		t.Fatalf("run.js said %s", out)
	}
	saved := filepath.Join(downloads, filepath.Base(res.File))
	if got := sumFile(t, saved); got != want || res.Bytes != bigSize {
		t.Fatalf("saved %s: sha256 %s, %d bytes, want %s\nmedia requests: %q", saved, got, res.Bytes, want, log.list())
	}
	streams := plugin.Streams()
	if len(streams) < 2 || streams[0].Offset != 0 {
		t.Fatalf("plugin streams = %+v", streams)
	}
	resumed := streams[len(streams)-1]
	if resumed.Offset <= 0 || resumed.Offset > bigCut || resumed.Length != bigSize-resumed.Offset || resumed.ETag == "" || resumed.Offer != offerID {
		t.Fatalf("resumed stream = %+v", resumed)
	}
	ranged := false
	for _, s := range log.list() {
		f := strings.Fields(s)
		ranged = ranged || len(f) >= 4 && f[1] == "bytes="+itoa(resumed.Offset)+"-" && strings.HasPrefix(f[2], `"`) && strings.HasSuffix(s, "Partial Content")
	}
	if !ranged {
		t.Fatalf("no 206 for bytes=%d- with If-Range: %q", resumed.Offset, log.list())
	}
	t.Logf("media requests: %q", log.list())
	for _, p := range []string{src, saved} {
		if err := os.Remove(p); err != nil {
			t.Error(err)
		}
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// setupDevicesWithFiles is a hub whose backend pc has devices on, with
// the device server as the service's files, the fake plugin, and alice's
// paired computer online with her home folder as its root.
func setupDevicesWithFiles(t *testing.T) (*hubEnv, *devicetest.Plugin, string) {
	t.Helper()
	var e *hubEnv
	var dev *device.Server
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	pub, _ := key.Public().(ed25519.PublicKey)
	e = setupWith(t, func(cfg *config.Config, opts *web.Options, st *store.Store) {
		cfg.Backends[0].Devices = true
		b := cfg.Backends[0]
		d, err := device.New(device.Options{Store: st, Access: late{&e}, Sessions: late{&e}, Backends: []config.Backend{b},
			Dialers: map[string]device.Dialer{"pc": gateway.NewDialer(gateway.Credentials{BaseURL: b.URL, Provider: providerBasic, Username: b.Username, Password: b.Password})},
			Key:     key, PublicURL: cfg.HTTP.PublicURL, Config: config.Device{Enabled: true}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(d.Drain)
		dev = d
		opts.Devices, opts.DeviceAPI, opts.Computers = st, d.Handler(), d
	})
	e.svc.SetFiles(dev)
	plugin := devicetest.NewPlugin(e.gw, "pc", pub)
	ctx := context.Background()
	dc, code, err := e.store.StartPairing(ctx, hub.PairingRequest{Name: pcName, Hostname: "alice-desktop.example.com"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	d, err := e.store.ApprovePairing(ctx, code, userAlice, "pc", pcName)
	if err != nil {
		t.Fatal(err)
	}
	if poll, err := e.store.PollPairing(ctx, dc, 0); err != nil || poll.Status != hub.PairApproved {
		t.Fatalf("poll = %+v, %v", poll, err)
	}
	plugin.Connect(d.ID, pcName, protocol.Hello{Home: homeAlice, Roots: []string{homeAlice}})
	return e, plugin, d.ID
}
