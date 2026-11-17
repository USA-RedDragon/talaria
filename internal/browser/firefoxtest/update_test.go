//go:build unix

package firefoxtest_test

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestExtensionRequestsUpdateCheck runs the extension in a real Firefox
// against a daemon that names a newer version. The extension must call
// runtime.requestUpdateCheck and report the answer to the daemon.
//
// The harness loads the extension as a temporary add-on, and Firefox does not
// update those, nor install an unsigned update from a local updates.json, so
// the install and reload of an update cannot run here: the answer is
// "no_update" or an error, never "update_available". The decision logic (a
// newer daemon triggers a check, a reload waits for actions in flight, a
// throttled answer is retried) is covered by extension/firefox/update_test.js
// with a stubbed runtime. This test proves the real API is called with the
// daemon's version and the state reaches the daemon.
func TestExtensionRequestsUpdateCheck(t *testing.T) { //nolint:paralleltest // one Firefox at a time
	if os.Getenv("HERMES_BROWSER_E2E") != "1" {
		t.Skip("set HERMES_BROWSER_E2E=1 to drive a throwaway headless Firefox")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	defer cancel()
	b, _ := startFirefox(ctx, t)
	deadline := time.Now().Add(30 * time.Second)
	for {
		h, ok := b.Connected()
		if ok && h.Update != "" && h.Update != "checking" {
			t.Logf("extension %s reports update state %q (%s)", h.Version, h.Update, h.UpdateVersion)
			switch h.Update {
			case "current", "throttled", "error":
			default:
				t.Fatalf("update state = %q", h.Update)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the extension did not report an update check: %+v", h)
		}
		select {
		case <-b.Changed():
		case <-time.After(500 * time.Millisecond):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}
