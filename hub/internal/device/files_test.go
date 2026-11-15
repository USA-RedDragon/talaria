package device_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/store"
	"github.com/USA-RedDragon/talaria/protocol"
)

func TestPutFile(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		e.plugin.SetBinding("s-pc", id, deviceDir)
		p, ok, err := e.a.dev.PutFile(ctx, userAlice, backendID, "s-pc", "notes.txt", []byte("hi"))
		want := deviceDir + "/.hermes/attachments/notes.txt"
		if err != nil || !ok || p != want || string(e.plugin.Uploads()[want]) != "hi" {
			t.Fatalf("PutFile = %q, %v, %v", p, ok, err)
		}
		if _, ok, err := e.a.dev.PutFile(ctx, userAlice, backendID, "s-new", "a.txt", []byte("x")); ok || err != nil {
			t.Fatalf("a session on the pod = %v, %v", ok, err)
		}
		e.plugin.SetSandbox(sandboxID, sandboxFS)
		e.plugin.Connect(sandboxID, sandboxName, protocol.Hello{Roots: []string{sandboxFS}})
		if p, ok, err := e.a.dev.PutFile(ctx, userAlice, backendID, "s-new", "a.txt", []byte("x")); !ok || err != nil ||
			p != sandboxFS+"/s-new/.hermes/attachments/a.txt" {
			t.Fatalf("sandbox PutFile = %q, %v, %v", p, ok, err)
		}
		if _, ok, _ := e.a.dev.PutFile(ctx, userAlice, "elsewhere", "x", "a.txt", []byte("x")); ok {
			t.Fatal("a backend without devices took a file")
		}
		e.plugin.Disconnect(id)
		_, _, err = e.a.dev.PutFile(ctx, userAlice, backendID, "s-pc", "notes.txt", []byte("hi"))
		if !errors.Is(err, hub.ErrAttachment) || !strings.Contains(hub.AttachmentReason(err), "offline") {
			t.Fatalf("offline PutFile = %v", err)
		}
		if err := e.a.dev.Release(ctx, userAlice, backendID, "s-pc"); err != nil {
			t.Fatal(err)
		}
		_, _, err = e.a.dev.PutFile(ctx, userAlice, backendID, "s-pc", "notes.txt", []byte("hi"))
		if !errors.Is(err, hub.ErrAttachment) || !strings.Contains(hub.AttachmentReason(err), "runs on no computer") {
			t.Fatalf("released PutFile = %v", err)
		}
		e.access.denied.Store(true)
		if _, _, err := e.a.dev.PutFile(ctx, userAlice, backendID, "s-new", "a.txt", []byte("x")); err == nil {
			t.Fatal("PutFile on a backend the user lost")
		}
	})
}

func readMedia(t *testing.T, f *hub.MediaFile) string {
	t.Helper()
	defer f.Body.Close()
	b, err := io.ReadAll(f.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func readBody(t *testing.T, rc io.ReadCloser) string {
	t.Helper()
	defer rc.Close()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// DeviceFile stats and streams ranges through the plugin's stat and stream
// routes: a device chat, a sandbox chat and a chat on the Hermes server,
// with the read rules mapped to hub errors.
func TestDeviceFile(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		archive := deviceDir + "/out/build.tar.zst"
		e.plugin.SetDeviceFile(id, archive, []byte("0123456789"))
		e.plugin.SetBinding("s-pc", id, deviceDir)
		fi, _, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", archive, hub.FileRequest{})
		if err != nil || !ok || fi.Name != "build.tar.zst" || fi.Size != 10 || fi.Kind != hub.FileKindArchive ||
			fi.Machine != deviceName || fi.MachineKind != hub.MachineDevice || !strings.HasPrefix(fi.ETag, `"a-`) || fi.ModTime.IsZero() {
			t.Fatalf("stat = %+v, %v, %v", fi, ok, err)
		}
		_, body, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", archive, hub.FileRequest{Open: true, Offset: 3, Length: 4, ETag: fi.ETag})
		if err != nil || !ok || readBody(t, body) != "3456" {
			t.Fatalf("range = %v, %v", ok, err)
		}
		if s := e.plugin.Streams(); len(s) != 1 || s[0].Offset != 3 || s[0].Length != 4 || s[0].ETag != fi.ETag {
			t.Fatalf("streams = %+v", s)
		}
		if _, _, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", archive, hub.FileRequest{Open: true, Length: -1, ETag: `"other"`}); !errors.Is(err, hub.ErrFileChanged) {
			t.Fatalf("another etag = %v", err)
		}
		if _, _, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", deviceDir+"/gone.txt", hub.FileRequest{}); !errors.Is(err, hub.ErrFileGone) ||
			!errors.Is(err, hub.ErrNoMedia) {
			t.Fatalf("gone = %v", err)
		}
		e.plugin.SetServerFile("/opt/data/hermes/out/report.csv", []byte("a,b\n"))
		fi, body, ok, err = e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-server", "/opt/data/hermes/out/report.csv", hub.FileRequest{Open: true, Length: -1})
		if err != nil || !ok || fi.MachineKind != hub.MachineServer || readBody(t, body) != "a,b\n" {
			t.Fatalf("a server chat = %+v, %v, %v", fi, ok, err)
		}
		if _, _, ok, _ := e.a.dev.DeviceFile(ctx, userAlice, "elsewhere", "x", archive, hub.FileRequest{}); ok {
			t.Fatal("a backend without devices served a file")
		}
		e.plugin.Disconnect(id)
		if _, _, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", archive, hub.FileRequest{}); !ok || !errors.Is(err, hub.ErrMediaOffline) {
			t.Fatalf("offline = %v, %v", ok, err)
		}
		e.access.denied.Store(true)
		if _, _, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-server", "/opt/data/hermes/out/report.csv", hub.FileRequest{}); err == nil {
			t.Fatal("DeviceFile on a backend the user lost")
		}
	})
}

// A sandbox chat's files come from the sandbox.
func TestDeviceFileSandbox(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		e.plugin.SetSandbox(sandboxID, sandboxFS)
		e.plugin.Connect(sandboxID, sandboxName, protocol.Hello{Roots: []string{sandboxFS}})
		e.plugin.SetDeviceFile(sandboxID, sandboxFS+"/s-new/plot.svg", []byte("<svg/>"))
		fi, body, ok, err := e.a.dev.DeviceFile(context.Background(), userAlice, backendID, "s-new", sandboxFS+"/s-new/plot.svg", hub.FileRequest{Open: true, Length: -1})
		if err != nil || !ok || fi.MachineKind != hub.MachineSandbox || fi.Kind != hub.FileKindOther || readBody(t, body) != "<svg/>" {
			t.Fatalf("sandbox = %+v, %v, %v", fi, ok, err)
		}
	})
}

// The secret rules refuse a secret file unless the read names the offer of
// a file the user asked for.
func TestDeviceFileSecret(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		key := deviceDir + "/.env"
		e.plugin.SetDeviceFile(id, key, []byte("TOKEN=x"))
		e.plugin.SetSecret(key, "fo_0123456789abcdef")
		e.plugin.SetBinding("s-pc", id, deviceDir)
		for _, offer := range []string{"", "fo_fedcba9876543210"} {
			if _, _, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", key, hub.FileRequest{Offer: offer}); !errors.Is(err, hub.ErrSecretFile) ||
				hub.RefusalReason(err) != "looks like a secret" {
				t.Fatalf("secret with offer %q = %v", offer, err)
			}
		}
		fi, body, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", key, hub.FileRequest{Offer: "fo_0123456789abcdef", Open: true, Length: -1})
		if err != nil || !fi.Secret || !fi.Requested || fi.Name != ".env" || readBody(t, body) != "TOKEN=x" {
			t.Fatalf("a secret the user asked for = %+v, %v", fi, err)
		}
	})
}

// A plugin without the stat and stream routes (the dashboard answers 404
// or 405) is read through the old whole-file route and sliced.
func TestDeviceFileOldPlugin(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		notes := deviceDir + "/notes.md"
		e.plugin.SetDeviceFile(id, notes, []byte("# hello alice"))
		e.plugin.SetBinding("s-pc", id, deviceDir)
		e.plugin.OldFileRoutes(true)
		fi, _, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", notes, hub.FileRequest{})
		if err != nil || !ok || fi.Size != 13 || fi.Kind != hub.FileKindText || fi.ETag != "" {
			t.Fatalf("stat = %+v, %v, %v", fi, ok, err)
		}
		_, body, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", notes, hub.FileRequest{Open: true, Offset: 2, Length: 5})
		if err != nil || !ok || readBody(t, body) != "hello" {
			t.Fatalf("range = %v, %v", ok, err)
		}
		if _, _, _, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-pc", deviceDir+"/missing.md", hub.FileRequest{}); !errors.Is(err, hub.ErrFileGone) {
			t.Fatalf("gone = %v", err)
		}
		if _, _, ok, err := e.a.dev.DeviceFile(ctx, userAlice, backendID, "s-server", "/opt/data/x.md", hub.FileRequest{}); ok || err != nil {
			t.Fatalf("an old plugin's server chat = %v, %v", ok, err)
		}
		if len(e.plugin.Streams()) != 0 {
			t.Fatalf("streams = %+v", e.plugin.Streams())
		}
	})
}

func TestDeviceMedia(t *testing.T) {
	t.Parallel()
	stores(t, func(t *testing.T, st *store.Store) {
		e := setup(t, st)
		ctx := context.Background()
		id := e.computer(deviceName)
		chart := deviceDir + "/out/chart.png"
		e.plugin.SetDeviceFile(id, chart, []byte("png bytes"))
		e.plugin.SetDeviceFile(id, "/etc/hosts.txt", []byte("refused"))
		e.plugin.SetBinding("s-pc", id, deviceDir)
		f, ok, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-pc", chart)
		if err != nil || !ok || f.Name != "chart.png" || readMedia(t, f) != "png bytes" {
			t.Fatalf("DeviceMedia = %+v, %v, %v", f, ok, err)
		}
		e.plugin.BusyReads(2)
		if f, ok, err = e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-pc", chart); err != nil || !ok || readMedia(t, f) != "png bytes" {
			t.Fatalf("after busy answers = %v, %v", ok, err)
		}
		for _, p := range []string{deviceDir + "/missing.png", "/etc/hosts.txt"} {
			if _, ok, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-pc", p); !ok || !errors.Is(err, hub.ErrNoMedia) {
				t.Fatalf("%s = %v, %v", p, ok, err)
			}
		}
		if _, ok, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-new", chart); ok || err != nil {
			t.Fatalf("a session on the pod = %v, %v", ok, err)
		}
		if _, ok, _ := e.a.dev.DeviceMedia(ctx, userAlice, "elsewhere", "x", chart); ok {
			t.Fatal("a backend without devices read a file")
		}
		e.plugin.SetSandbox(sandboxID, sandboxFS)
		e.plugin.Connect(sandboxID, sandboxName, protocol.Hello{Roots: []string{sandboxFS}})
		e.plugin.SetDeviceFile(sandboxID, sandboxFS+"/s-new/plot.png", []byte("plot"))
		if f, ok, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-new", sandboxFS+"/s-new/plot.png"); err != nil || !ok || readMedia(t, f) != "plot" {
			t.Fatalf("sandbox DeviceMedia = %v, %v", ok, err)
		}
		e.plugin.Disconnect(id)
		if _, ok, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-pc", chart); !ok || !errors.Is(err, hub.ErrMediaOffline) {
			t.Fatalf("offline = %v, %v", ok, err)
		}
		e.access.denied.Store(true)
		if _, _, err := e.a.dev.DeviceMedia(ctx, userAlice, backendID, "s-new", sandboxFS+"/s-new/plot.png"); err == nil {
			t.Fatal("DeviceMedia on a backend the user lost")
		}
	})
}
