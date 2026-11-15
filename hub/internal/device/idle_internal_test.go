package device

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

// A stream that sends no byte for the idle time fails and cancels its
// request; one whose bytes keep coming runs as long as it takes.
func TestIdleBody(t *testing.T) {
	t.Parallel()
	pr, pw := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	context.AfterFunc(ctx, func() { _ = pr.CloseWithError(ctx.Err()) })
	b := newIdleBody(pr, 50*time.Millisecond, cancel)
	go func() {
		for range 8 {
			_, _ = pw.Write([]byte("x"))
			time.Sleep(20 * time.Millisecond)
		}
	}()
	buf := make([]byte, 1)
	for range 8 {
		if _, err := b.Read(buf); err != nil {
			t.Fatalf("a stream with bytes failed: %v", err)
		}
	}
	start := time.Now()
	_, err := b.Read(buf)
	if !errors.Is(err, errStalled) || ctx.Err() == nil || time.Since(start) > 5*time.Second {
		t.Fatalf("stalled read = %v after %v, ctx %v", err, time.Since(start), ctx.Err())
	}
	_ = b.Close()
}
