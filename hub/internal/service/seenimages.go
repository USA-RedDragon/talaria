package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

var _ hub.SeenImages = (*Service)(nil)

// seenReader opens the kept copies of a backend's server. *gateway.Dialer is
// one.
type seenReader interface {
	SeenImage(ctx context.Context, id string, thumb bool) (*http.Response, error)
}

// SeenImage opens a kept copy of an image the model saw. See hub.SeenImages.
// The user needs the access to the chat's backend and session that every chat
// route needs; the copy is named by its sha256, so no path reaches the
// server.
func (s *Service) SeenImage(ctx context.Context, user, backendID, sessionID, id string, thumb bool) (*hub.MediaFile, error) {
	b, err := s.backend(ctx, user, backendID)
	if err != nil {
		return nil, err
	}
	if !hub.SeenImageID(id) {
		return nil, hub.ErrNoMedia
	}
	sr, ok := b.dialer.(seenReader)
	if !ok {
		return nil, hub.ErrNoMedia
	}
	ls, err := b.session(ctx, sessionID)
	if err != nil {
		return nil, refusal(err)
	}
	ls.unpin()
	resp, err := sr.SeenImage(ctx, id, thumb)
	if errors.Is(err, gateway.ErrNoFile) {
		return nil, hub.ErrNoMedia
	}
	if err != nil {
		return nil, err
	}
	head := make([]byte, 16)
	n, err := io.ReadFull(resp.Body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		_ = resp.Body.Close()
		return nil, err
	}
	head = head[:n]
	mime := hub.ImageMIME(head)
	if mime == "" || resp.ContentLength > hub.MaxMediaBytes {
		_ = resp.Body.Close()
		return nil, hub.ErrNoMedia
	}
	r := io.MultiReader(bytes.NewReader(head), resp.Body)
	return &hub.MediaFile{Name: "image", MIME: mime, Size: resp.ContentLength,
		Body: readCloser{&capReader{r: r, left: hub.MaxMediaBytes}, resp.Body}}, nil
}
