package telegram

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

const (
	msgMediaGone     = "Could not send %s: it is no longer there."
	msgMediaOffline  = "Could not send %s: the computer that has it is offline. Open it in the hub's web page when the computer is back."
	msgMediaTooLarge = "Could not send %s: Telegram takes files up to %d MB from bots. Open it in the hub's web page."
	msgMediaFailed   = "Could not send %s. Open it in the hub's web page."
	msgMediaMany     = "The reply names %d files; this chat gets the first %d. Open the chat in the hub's web page for the rest."
)

// maxReplyMedia bounds the files the bot sends for one reply.
const maxReplyMedia = 10

// mediaReadTimeout bounds reading one file a reply names. A file on a
// device can take the plugin's 120 seconds and its transfer (talaria
// plugin/device/core.py FILE_READ_TIMEOUT_S).
const mediaReadTimeout = 150 * time.Second

// uploadTimeout bounds one upload to Telegram.
const uploadTimeout = 2 * time.Minute

// sendMedia sends the files a reply names, after its text: images that
// Telegram takes as photos go together as albums of up to ten
// (sendMediaGroup), after the other files, which go as documents.
func (r *renderer) sendMedia(ctx context.Context, paths []string) {
	if len(paths) > maxReplyMedia {
		r.notice(ctx, msgMediaMany, len(paths), maxReplyMedia)
		paths = paths[:maxReplyMedia]
	}
	var photos []Photo
	for _, p := range paths {
		name := hub.CleanName(path.Base(p))
		if hub.PagePath(p) && r.pageURL != nil {
			r.sendPageFile(ctx, p, name)
			continue
		}
		if r.media == nil {
			r.notice(ctx, msgMediaFailed, name)
			continue
		}
		photo, err := r.sendOrRead(ctx, p, name)
		if err != nil {
			r.mediaFailed(ctx, name, err)
			continue
		}
		if photo != nil {
			photos = append(photos, *photo)
		}
	}
	for len(photos) > 0 {
		n, size := 0, 0
		for n < min(len(photos), maxAlbum) && (n == 0 || size+len(photos[n].Data) <= maxAlbumBytes) {
			size += len(photos[n].Data)
			n++
		}
		r.sendPhotos(ctx, photos[:n])
		photos = photos[n:]
	}
}

// maxAlbumBytes bounds the images of one album, which go up in one
// request: the Bot API takes uploads of up to 50 MB.
const maxAlbumBytes = 40 << 20

// sendPhotos sends up to ten images as one album, or one image as a
// photo. When Telegram refuses the album, it sends each image on its own;
// when it refuses a photo, such as one of odd dimensions, it sends the
// image as a file.
func (r *renderer) sendPhotos(ctx context.Context, photos []Photo) {
	if len(photos) > 1 {
		cctx, cancel := context.WithTimeout(ctx, uploadTimeout)
		err := r.api.SendAlbum(cctx, r.to.chat, r.to.thread, photos)
		cancel()
		r.spend()
		r.draftLost()
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Code == http.StatusTooManyRequests {
			if err != nil {
				r.logger.Warn("Failed to send an album", "error", err)
				for _, p := range photos {
					r.notice(ctx, msgMediaFailed, p.Name)
				}
			}
			return
		}
		r.logger.Info("Telegram refused an album, sending its images one by one", "error", err)
	}
	for _, p := range photos {
		err := r.upload(ctx, r.api.SendPhoto, p.Name, p.Data)
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Code != http.StatusBadRequest {
			r.sent(ctx, p.Name, err)
			continue
		}
		r.logger.Info("Telegram refused a photo, sending it as a file", "error", err)
		r.sent(ctx, p.Name, r.upload(ctx, r.api.SendDocument, p.Name, p.Data))
	}
}

func (r *renderer) upload(ctx context.Context, send func(context.Context, int64, int64, string, []byte) error, name string, data []byte) error {
	cctx, cancel := context.WithTimeout(ctx, uploadTimeout)
	defer cancel()
	defer r.draftLost()
	defer r.spend()
	return send(cctx, r.to.chat, r.to.thread, name, data)
}

// sendOrRead opens the file a reply names. An image that Telegram takes as
// a photo is read (it is at most 10 MB) and returned, for the album; any
// other file is streamed to Telegram as a document, never held whole.
func (r *renderer) sendOrRead(ctx context.Context, p, name string) (*Photo, error) {
	cctx, cancel := context.WithTimeout(ctx, mediaReadTimeout+uploadTimeout)
	defer cancel()
	f, err := r.media(cctx, p)
	if err != nil {
		return nil, err
	}
	defer f.Body.Close()
	if f.Size > MaxDocumentUpload {
		return nil, hub.ErrMediaTooLarge
	}
	var body io.Reader = f.Body
	if f.MIME != "" && f.Size <= MaxPhotoUpload {
		data, err := io.ReadAll(io.LimitReader(f.Body, MaxPhotoUpload+1))
		if err != nil {
			return nil, err
		}
		if len(data) <= MaxPhotoUpload {
			return &Photo{Name: name, Data: data}, nil
		}
		// An image of unknown size that turned out larger: a document.
		body = io.MultiReader(bytes.NewReader(data), f.Body)
	}
	return nil, r.streamDocument(cctx, name, f.Size, body, "")
}

// streamDocument uploads body as a document of size bytes (-1: unknown)
// from a reader, and fails with hub.ErrMediaTooLarge when it holds more
// than Telegram takes.
func (r *renderer) streamDocument(ctx context.Context, name string, size int64, body io.Reader, caption string) error {
	defer r.draftLost()
	defer r.spend()
	return r.api.SendDocumentStream(ctx, r.to.chat, r.to.thread, name, size, &capReader{r: body, left: MaxDocumentUpload}, caption)
}

// capReader fails with hub.ErrMediaTooLarge when more than left bytes are
// read, so a file of unknown size cannot run past Telegram's limit.
type capReader struct {
	r    io.Reader
	left int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left < 0 {
		return 0, hub.ErrMediaTooLarge
	}
	if int64(len(p)) > c.left+1 {
		p = p[:c.left+1]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	if c.left < 0 {
		return n, hub.ErrMediaTooLarge
	}
	return n, err
}

// mediaFailed tells the chat why a file a reply names was not sent.
func (r *renderer) mediaFailed(ctx context.Context, name string, err error) {
	switch {
	case errors.Is(err, hub.ErrNoMedia):
		r.notice(ctx, msgMediaGone, name)
	case errors.Is(err, hub.ErrMediaTooLarge):
		r.notice(ctx, msgMediaTooLarge, name, MaxDocumentUpload>>20)
	case errors.Is(err, hub.ErrMediaOffline):
		r.notice(ctx, msgMediaOffline, name)
	default:
		r.logger.Warn("Failed to send a file a reply names", "error", err)
		r.notice(ctx, msgMediaFailed, name)
	}
}

func (r *renderer) sent(ctx context.Context, name string, err error) {
	if err != nil {
		r.logger.Warn("Failed to send a file", "error", err)
		r.notice(ctx, msgMediaFailed, name)
	}
}

func (r *renderer) notice(ctx context.Context, format string, args ...any) {
	r.send(ctx, escapeHTML(fmt.Sprintf(format, args...)), nil)
}

// sendPages sends a link to the hub page that opens each page block of a
// reply. Telegram cannot run a page, and the user's browser opens the link.
func (r *renderer) sendPages(ctx context.Context, pages []string) {
	if r.pageURL == nil {
		return
	}
	for _, p := range pages {
		r.pageLink(ctx, hub.PageTitle(p), r.pageURL(hub.PageID(p)))
	}
}

// sendPageFile sends a link that opens an HTML file a reply names as a page.
func (r *renderer) sendPageFile(ctx context.Context, p, name string) {
	title := ""
	if r.media != nil {
		cctx, cancel := context.WithTimeout(ctx, downloadTimeout)
		f, err := r.media(cctx, p)
		if errors.Is(err, hub.ErrNoMedia) {
			cancel()
			r.notice(ctx, msgMediaGone, name)
			return
		}
		if err == nil {
			head, _ := io.ReadAll(io.LimitReader(f.Body, 64<<10))
			_ = f.Body.Close()
			title = hub.PageTitle(string(head))
		}
		cancel()
	}
	if title == "" {
		title = name
	}
	r.pageLink(ctx, title, r.pageURL(p))
}

func (r *renderer) pageLink(ctx context.Context, title, link string) {
	if title == "" {
		title = "Page"
	}
	r.send(ctx, "<b>"+escapeHTML(title)+"</b>\n<a href=\""+escapeHTML(link)+"\">Open the page in the hub</a>", nil)
}
