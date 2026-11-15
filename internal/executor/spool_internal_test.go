//go:build unix

package executor

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestSpoolDeadlineAfterAdopt: the device's own timeout still applies to
// an adopted command, counted from its start, and Detach lifts it for
// good.
func TestSpoolDeadlineAfterAdopt(t *testing.T) {
	t.Parallel()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, detach := range []bool{false, true} {
		dir := t.TempDir()
		sp, err := NewSpool(dir, exe, nil)
		if err != nil {
			t.Fatal(err)
		}
		p, err := sp.start("c", "bash", Request{Cmd: "sleep 1.5; echo done", Cwd: t.TempDir(), Timeout: 300 * time.Millisecond},
			func([]byte) {}, 0)
		if err != nil {
			t.Fatal(err)
		}
		if detach {
			p.Detach()
		}
		p.Release()
		sp2, _ := NewSpool(dir, exe, nil)
		list := sp2.Adoptable()
		if len(list) != 1 {
			t.Fatalf("adoptable %+v", list)
		}
		p2 := sp2.Adopt(list[0], func([]byte) {})
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		res, err := p2.Wait(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if res.Killed == detach {
			t.Errorf("detach %v: result %+v", detach, res)
		}
	}
}
