package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/pdf"
)

var _ hub.Files = (*Service)(nil)

// maxFileBytes is the cap of files the backend's chats offer.
func (b *backend) maxFileBytes() int64 {
	if b.cfg.MaxFileBytes > 0 {
		return b.cfg.MaxFileBytes
	}
	return hub.DefaultMaxFileBytes
}

// StatFile checks that the session offered p to user and stats it where the
// chat runs. See hub.Files.
func (s *Service) StatFile(ctx context.Context, user, backendID, sessionID, p string) (*hub.FileInfo, error) {
	fi, _, err := s.file(ctx, user, backendID, sessionID, p, hub.FileRequest{})
	return fi, err
}

// OpenFile is StatFile, then reads length bytes from offset. See hub.Files.
func (s *Service) OpenFile(ctx context.Context, user, backendID, sessionID, p string, offset, length int64, etag string) (*hub.FileInfo, io.ReadCloser, error) {
	if offset < 0 {
		return nil, nil, fmt.Errorf("%w: a negative offset", hub.ErrBadValue)
	}
	return s.file(ctx, user, backendID, sessionID, p, hub.FileRequest{Open: true, Offset: offset, Length: length, ETag: etag})
}

// file serves a file the session offered: from the backend's server when
// it is under the media roots (as Media), else from where the chat runs
// through the device plugin, whose new routes also serve the chats that
// run on the Hermes server.
func (s *Service) file(ctx context.Context, user, backendID, sessionID, p string, req hub.FileRequest) (*hub.FileInfo, io.ReadCloser, error) {
	b, err := s.backend(ctx, user, backendID)
	if err != nil {
		return nil, nil, err
	}
	if !hub.FilePath(p) {
		return nil, nil, hub.ErrNoMedia
	}
	ls, err := b.session(ctx, sessionID)
	if err != nil {
		return nil, nil, refusal(err)
	}
	o := ls.offers(p)
	ls.unpin()
	if !o.ok() {
		if f := o.refused; f != nil {
			fi := &hub.FileInfo{Name: hub.ShowName(path.Base(p)), Path: p, Machine: f.Machine, MachineKind: f.MachineKind, Secret: true}
			if f.Name != "" {
				fi.Name = hub.ShowName(f.Name)
			}
			return fi, nil, &hub.RefusedError{Reason: f.Reason}
		}
		return nil, nil, hub.ErrNoMedia
	}
	req.Offer = o.id()
	fr, server := b.dialer.(fileReader)
	server = server && inMediaRoots(b.cfg.MediaRoots, p)
	df, device := s.files.(hub.DeviceFiles)
	var fi *hub.FileInfo
	var body io.ReadCloser
	err = hub.ErrNoMedia
	if server {
		fi, body, err = serverFile(ctx, fr, p, req, b.maxFileBytes())
	}
	if device && (!server || errors.Is(err, hub.ErrNoMedia)) {
		var ok bool
		fi, body, ok, err = df.DeviceFile(ctx, user, backendID, sessionID, p, req)
		if err == nil && !ok {
			err = hub.ErrNoMedia
		}
	}
	if err != nil {
		return nil, nil, err
	}
	fi.Offer = req.Offer
	if o.sent != nil {
		fillFromOffer(fi, o.sent)
	}
	if fi.Size > b.maxFileBytes() {
		if body != nil {
			_ = body.Close()
		}
		return fi, nil, hub.ErrMediaTooLarge
	}
	return fi, body, nil
}

// fillFromOffer fills what the source did not say from the send_file
// offer.
func fillFromOffer(fi *hub.FileInfo, f *hub.FileOffer) {
	if fi.TypeLabel == "" {
		fi.TypeLabel = f.TypeLabel
	}
	if fi.Machine == "" {
		fi.Machine, fi.MachineKind = f.Machine, f.MachineKind
	}
	if fi.Kind == "" || fi.Kind == hub.FileKindOther {
		if f.Kind != "" {
			fi.Kind = f.Kind
		}
	}
	if fi.Lines == 0 {
		fi.Lines = f.Lines
	}
	fi.Requested = fi.Requested || f.Requested
	fi.Secret = fi.Secret || f.Secret
}

// serverFile reads a file of the backend's server, as Media does, for the
// requested range. The server has no ranges, so the hub skips to offset.
// The validator comes from the server's Last-Modified, when it sends one.
func serverFile(ctx context.Context, fr fileReader, p string, req hub.FileRequest, maxBytes int64) (*hub.FileInfo, io.ReadCloser, error) {
	resp, err := fr.File(ctx, p)
	if errors.Is(err, gateway.ErrNoFile) {
		return nil, nil, hub.ErrNoMedia
	}
	if err != nil {
		return nil, nil, err
	}
	if resp.ContentLength > maxBytes {
		_ = resp.Body.Close()
		return nil, nil, hub.ErrMediaTooLarge
	}
	head := make([]byte, 512)
	n, err := io.ReadFull(resp.Body, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		_ = resp.Body.Close()
		return nil, nil, err
	}
	head = head[:n]
	fi := &hub.FileInfo{Name: hub.ShowName(path.Base(p)), Path: p, Size: resp.ContentLength,
		Machine: "the Hermes server", MachineKind: hub.MachineServer}
	fi.MIME, fi.Kind = hub.GuessFile(p, head)
	if t, err := http.ParseTime(resp.Header.Get("Last-Modified")); err == nil {
		fi.ModTime = t
		if fi.Size >= 0 {
			fi.ETag = fmt.Sprintf(`"s%x-%x"`, fi.Size, t.Unix())
		}
	}
	if !req.Open {
		_ = resp.Body.Close()
		return fi, nil, nil
	}
	if req.ETag != "" && req.ETag != fi.ETag {
		_ = resp.Body.Close()
		return nil, nil, hub.ErrFileChanged
	}
	var r io.Reader
	r = io.MultiReader(bytes.NewReader(head), resp.Body)
	if _, err := io.CopyN(io.Discard, r, req.Offset); err != nil && !errors.Is(err, io.EOF) {
		_ = resp.Body.Close()
		return nil, nil, err
	}
	if req.Length >= 0 {
		r = io.LimitReader(r, req.Length)
	}
	return fi, readCloser{&capReader{r: r, left: maxBytes}, resp.Body}, nil
}

// previewTimeout bounds the read of a PDF for its preview.
const previewTimeout = 2 * time.Minute

var _ hub.FilePreviews = (*Service)(nil)

// FilePreview renders the first page of an offered PDF. See
// hub.FilePreviews.
func (s *Service) FilePreview(ctx context.Context, user, backendID, sessionID, p string) ([]byte, int, error) {
	fi, err := s.StatFile(ctx, user, backendID, sessionID, p)
	if err != nil {
		return nil, 0, err
	}
	pdfName := strings.EqualFold(path.Ext(p), ".pdf")
	if s.opts.PDF == nil || fi.Kind != hub.FileKindPDF && !pdfName || fi.Size > hub.MaxPreviewBytes {
		return nil, 0, hub.ErrNoPreview
	}
	cctx, cancel := context.WithTimeout(ctx, previewTimeout)
	defer cancel()
	_, body, err := s.OpenFile(cctx, user, backendID, sessionID, p, 0, -1, fi.ETag)
	if err != nil {
		return nil, 0, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, hub.MaxPreviewBytes+1))
	if err != nil {
		return nil, 0, err
	}
	if len(data) > hub.MaxPreviewBytes || !bytes.HasPrefix(data, []byte("%PDF-")) && !bytes.Contains(data[:min(len(data), 1024)], []byte("%PDF-")) {
		return nil, 0, hub.ErrNoPreview
	}
	doc, err := s.opts.PDF.Read(cctx, pdf.Request{Data: data, From: 1, To: 1, Images: 1, MaxText: 1})
	if err != nil {
		s.log.Info("no preview of a PDF", "session", sessionID, "error", err.Error())
		return nil, 0, hub.ErrNoPreview
	}
	if len(doc.Images) == 0 {
		return nil, 0, hub.ErrNoPreview
	}
	return doc.Images[0], doc.Pages, nil
}
