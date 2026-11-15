package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

const (
	msgFileRefused = "Did not send %s: it looks like a secret. Ask for it in the chat if you want it anyway."
	msgSentOnAsk   = "Sent at your request."
)

// sizeText writes a byte count as the file card does: KB, MB or GB with
// one decimal.
func sizeText(n int64) string {
	const k = 1024.0
	f := float64(n)
	switch {
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case f < k*k:
		return fmt.Sprintf("%.1f KB", f/k)
	case f < k*k*k:
		return fmt.Sprintf("%.1f MB", f/k/k)
	}
	return fmt.Sprintf("%.1f GB", f/k/k/k)
}

// offeredFile delivers the file a send_file result offers: a document up
// to Telegram's limit, a hub link above it, or one line when the secret
// rules refused it. A replayed result sends nothing twice.
func (r *renderer) offeredFile(ctx context.Context, p toolPayload) {
	if p.Name != hub.SendFileTool {
		return
	}
	offer, refused, ok := hub.SendFileResult(p.Result)
	if !ok {
		if offer, refused, ok = hub.SendFileResult(json.RawMessage(p.ResultText)); !ok {
			return
		}
	}
	key := offer.ID
	if key == "" {
		key = offer.Path
	}
	if r.offered[key] {
		return
	}
	if r.offered == nil {
		r.offered = map[string]bool{}
	}
	r.offered[key] = true
	name := hub.CleanName(offer.Name)
	if name == "" || name == "." {
		name = hub.CleanName(path.Base(offer.Path))
	}
	r.flushAll(ctx)
	if refused {
		r.notice(ctx, msgFileRefused, name)
		return
	}
	if r.openFile == nil {
		r.notice(ctx, msgMediaFailed, name)
		return
	}
	if offer.Size > MaxDocumentUpload {
		r.fileLink(ctx, name, offer)
		return
	}
	cctx, cancel := context.WithTimeout(ctx, mediaReadTimeout+uploadTimeout)
	defer cancel()
	info, body, err := r.openFile(cctx, offer.Path)
	if err != nil {
		r.fileFailed(ctx, name, offer, err)
		return
	}
	defer body.Close()
	if info != nil && info.Size > MaxDocumentUpload {
		r.fileLink(ctx, name, offer)
		return
	}
	size := int64(-1)
	if info != nil {
		size = info.Size
	}
	if err := r.streamDocument(cctx, name, size, body, fileCaption(offer)); err != nil {
		r.fileFailed(ctx, name, offer, err)
	}
}

// fileFailed tells the chat why an offered file did not go.
func (r *renderer) fileFailed(ctx context.Context, name string, offer *hub.FileOffer, err error) {
	if errors.Is(err, hub.ErrSecretFile) {
		r.notice(ctx, msgFileRefused, name)
		return
	}
	if errors.Is(err, hub.ErrMediaTooLarge) {
		r.fileLink(ctx, name, offer)
		return
	}
	r.mediaFailed(ctx, name, err)
}

// fileLink tells the chat that a file is too big for Telegram and links
// its card in the hub, which opens after sign-in.
func (r *renderer) fileLink(ctx context.Context, name string, offer *hub.FileOffer) {
	if r.fileURL == nil {
		r.notice(ctx, msgMediaTooLarge, name, MaxDocumentUpload>>20)
		return
	}
	size := ""
	if offer.Size > 0 {
		size = " (" + sizeText(offer.Size) + ")"
	}
	r.send(ctx, "<b>"+escapeHTML(name)+"</b>"+size+" is too large for Telegram. Open it in the hub: <a href=\""+
		escapeHTML(r.fileURL(offer.Path))+"\">Open the file in the hub</a>", nil)
}

// fileCaption is the offer's note, then a line when the user asked for the
// file, as HTML within Telegram's caption limit.
func fileCaption(offer *hub.FileOffer) string {
	tail := ""
	if offer.Requested {
		tail = msgSentOnAsk
	}
	note := strings.TrimSpace(offer.Note)
	for n := maxCaption; ; n -= 64 {
		out := escapeHTML(truncate(note, max(n, 0)))
		if tail != "" && out != "" {
			out += "\n"
		}
		out += tail
		if len([]rune(out)) <= maxCaption || n <= 0 {
			return out
		}
	}
}
