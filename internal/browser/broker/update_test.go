package broker_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/internal/browser/broker"
	"github.com/USA-RedDragon/talaria/internal/browser/host"
	"github.com/USA-RedDragon/talaria/internal/browser/nativemsg"
)

// The config carries the daemon's and the plugin's versions, so an older
// extension asks Firefox for an update, and the extension's update state
// reaches Connected.
func TestConfigCarriesVersionsAndUpdateStatus(t *testing.T) {
	t.Parallel()
	b, sock := startVersioned(t, "0.32.0")
	conn := dialRaw(t, sock)
	send := func(m any) {
		if err := nativemsg.Write(conn, mustJSON(t, m), nativemsg.MaxToBrowser); err != nil {
			t.Fatal(err)
		}
	}
	read := func() broker.Message {
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		data, err := nativemsg.Read(conn, nativemsg.MaxToBrowser)
		if err != nil {
			t.Fatal(err)
		}
		var m broker.Message
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	send(broker.Message{Type: broker.TypeHostHello, ExtensionID: host.ExtensionID, HostPID: 1})
	send(broker.Message{Type: broker.TypeHello, Version: "0.28.1", Update: "checking"})
	if m := read(); m.Type != broker.TypeConfig || m.DaemonVersion != "0.32.0" || m.PluginVersion != "" {
		t.Fatalf("config = %+v", m)
	}
	read() // legacy auth_status
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	h, err := b.WaitConnected(ctx)
	if err != nil || h.Update != "checking" {
		t.Fatalf("hello = %+v, %v", h, err)
	}
	b.SetPluginVersion("0.33.0")
	if m := read(); m.Type != broker.TypeConfig || m.DaemonVersion != "0.32.0" || m.PluginVersion != "0.33.0" {
		t.Fatalf("config after SetPluginVersion = %+v", m)
	}
	b.SetPluginVersion("0.33.0") // unchanged: nothing is sent
	ch := b.Changed()
	send(broker.Message{Type: broker.TypeUpdateStatus, Update: "pending", UpdateVersion: "0.32.0"})
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatal("an update status did not signal a change")
	}
	if h, _ := b.Connected(); h.Update != "pending" || h.UpdateVersion != "0.32.0" || h.Version != "0.28.1" {
		t.Fatalf("hello after update_status = %+v", h)
	}
}

func startVersioned(t *testing.T, daemon string) (*broker.Broker, string) {
	t.Helper()
	// t.TempDir paths can pass the 108 byte limit of a socket path.
	dir, err := os.MkdirTemp("", "hb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "state", broker.SocketName)
	b, err := broker.Listen(broker.Options{Path: sock, ExtensionID: host.ExtensionID, DaemonVersion: daemon})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = b.Serve(ctx)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return b, sock
}
