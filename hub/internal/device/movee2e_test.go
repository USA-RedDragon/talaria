package device_test

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/device"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

const (
	sessionDirect   = "s-direct"
	codeOtherDevice = "bound_to_other_device"
)

// httpRequester sends the hub's plugin requests straight to a plugin
// server, without a Hermes dashboard login in front of it.
type httpRequester struct{ base string }

func (r httpRequester) Request(ctx context.Context, method, path string, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, r.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return http.DefaultClient.Do(req)
}

// TestMoveEndToEnd moves sessions through the real plugin route
// (plugin/device/tests/test_move_e2e.py) with move assertions this
// package signs: a session bound to another computer, one that follows it
// through its parent, and one that fails closed. Each is first refused
// without an assertion, with a forged one and with another session's.
// It runs only with TALARIA_MOVE_E2E_DIR, the directory the Python side
// was started with.
func TestMoveEndToEnd(t *testing.T) {
	t.Parallel()
	dir := os.Getenv("TALARIA_MOVE_E2E_DIR")
	if dir == "" {
		t.Skip("set TALARIA_MOVE_E2E_DIR and run plugin/device/tests/test_move_e2e.py with it")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	read := func(name string) string {
		deadline := time.Now().Add(2 * time.Minute)
		for {
			if b, err := root.ReadFile(name); err == nil {
				return string(b)
			}
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", name)
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	port := read("port")
	folder := read("dir")
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(101 + i)
	}
	key := ed25519.NewKeyFromSeed(seed)
	p := device.NewPlugin(httpRequester{base: "http://127.0.0.1:" + port})
	ctx := context.Background()
	upstairs := hub.Device{ID: "d_upstairs", Name: "upstairs-pc", User: "user-e2e", BackendID: "alice"}
	code := func(err error) string {
		var pe *device.PluginError
		if errors.As(err, &pe) {
			return pe.Code
		}
		if err != nil {
			return err.Error()
		}
		return ""
	}
	for _, sid := range []string{sessionDirect, "s-branch", "s-gone"} {
		if _, err := p.Bind(ctx, sid, upstairs.ID, folder); code(err) != codeOtherDevice && code(err) != "not_bindable" {
			t.Fatalf("unsigned bind of %s = %v", sid, err)
		}
		tok, err := device.SignMove(key, upstairs, sid, folder, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		other, _ := device.SignMove(key, upstairs, "s-parent", folder, time.Now())
		_, wrongKey, _ := ed25519.GenerateKey(nil)
		forged, _ := device.SignMove(wrongKey, upstairs, sid, folder, time.Now())
		old, _ := device.SignMove(key, upstairs, sid, folder, time.Now().Add(-time.Minute))
		for name, bad := range map[string]string{"forged": forged, "another session's": other, "expired": old} {
			if _, err := p.Move(ctx, sid, upstairs.ID, folder, bad); code(err) != "move_refused" {
				t.Fatalf("%s move assertion for %s = %v", name, sid, err)
			}
		}
		b, err := p.Move(ctx, sid, upstairs.ID, folder, tok)
		if err != nil || b.DeviceID != upstairs.ID || b.Dir != folder || b.SessionID != sid {
			t.Fatalf("move of %s = %+v, %v", sid, b, err)
		}
		if _, err := p.Move(ctx, sid, upstairs.ID, folder, tok); code(err) != "move_refused" {
			t.Fatalf("replayed move assertion for %s = %v", sid, err)
		}
	}
	if err := root.WriteFile("done", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	var res map[string]struct {
		State    string `json:"state"`
		Via      string `json:"via"`
		DeviceID string `json:"device_id"`
		Dir      string `json:"dir"`
	}
	raw := read("result.json")
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		t.Fatalf("result.json: %v in %s", err, raw)
	}
	for sid, r := range res {
		want := upstairs.ID
		if sid == "s-parent" {
			want = "d_framework"
		}
		if r.State != "bound" || r.DeviceID != want || !strings.HasSuffix(r.Dir, "/docgen") {
			t.Errorf("%s resolves to %+v, want bound to %s", sid, r, want)
		}
	}
}
