package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"path"
	"strings"
	"time"
)

// SendFileTool is the device plugin's tool that offers a file to the user:
// it stats the file where the chat runs, applies the secret rules and puts
// a file card into the chat.
const SendFileTool = "send_file"

// DefaultMaxFileBytes is the largest file the hub passes on when the
// config sets no other cap.
const DefaultMaxFileBytes int64 = 8 << 30

// File kinds of an offer, which pick the card's preview.
const (
	FileKindImage   = "image"
	FileKindPDF     = "pdf"
	FileKindText    = "text"
	FileKindCode    = "code"
	FileKindAudio   = "audio"
	FileKindVideo   = "video"
	FileKindArchive = "archive"
	FileKindOther   = "other"
)

// Where the file of an offer is.
const (
	MachineDevice  = "device"
	MachineSandbox = "sandbox"
	MachineServer  = "server"
)

// FileOffer is a file the agent offered the user with send_file, as the
// tool's result names it (docs/protocol.md section 9, file offers).
type FileOffer struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Path      string  `json:"path"`
	Size      int64   `json:"size"`
	MIME      string  `json:"mime,omitempty"`
	Kind      string  `json:"kind,omitempty"`
	TypeLabel string  `json:"type_label,omitempty"`
	MTime     float64 `json:"mtime,omitempty"`
	Machine   string  `json:"machine,omitempty"`
	// MachineKind is MachineDevice, MachineSandbox or MachineServer.
	MachineKind string `json:"machine_kind,omitempty"`
	Note        string `json:"note,omitempty"`
	// Secret: the file matched the secret rules. Requested: the user asked
	// for this exact file in a chat message, so it was offered anyway.
	Secret    bool `json:"secret,omitempty"`
	Requested bool `json:"requested,omitempty"`
	// Lines is the line count of a text or code file, when known.
	Lines int `json:"lines,omitempty"`
	// Reason says why a refused offer was refused, in plain words.
	Reason string `json:"reason,omitempty"`
}

// Status of a send_file result.
const (
	OfferOffered = "offered"
	OfferRefused = "refused"
)

type sendFileResult struct {
	Status string     `json:"status"`
	Offer  *FileOffer `json:"file_offer"`
}

// SendFileResult reads a send_file result: a JSON object, or a JSON string
// that holds one. ok is false for anything else, such as a tool error.
// refused is true for an offer the secret rules refused, which the card
// shows but nobody can download.
func SendFileResult(raw json.RawMessage) (offer *FileOffer, refused, ok bool) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		raw = json.RawMessage(s)
	}
	var r sendFileResult
	if json.Unmarshal(raw, &r) != nil || r.Offer == nil || !FilePath(r.Offer.Path) {
		return nil, false, false
	}
	switch r.Status {
	case OfferOffered:
		return r.Offer, false, true
	case OfferRefused:
		return r.Offer, true, true
	}
	return nil, false, false
}

// FilePath reports whether p is a path the hub may ask for as a file
// offer: an absolute, clean path of at most 4096 bytes without control
// characters, with any extension or none.
func FilePath(p string) bool {
	if len(p) < 2 || len(p) > 4096 || p[0] != '/' || path.Clean(p) != p {
		return false
	}
	return !strings.ContainsFunc(p, func(r rune) bool { return r < 0x20 || r == 0x7f })
}

// FileInfo is what the hub knows of an offered file when it serves it.
type FileInfo struct {
	Name        string
	Path        string
	MIME        string
	Kind        string
	Machine     string
	MachineKind string
	Size        int64
	ModTime     time.Time
	// ETag changes whenever the file's content may have changed; a
	// resumed download sends it back in If-Range.
	ETag      string
	Secret    bool
	Requested bool
	// TypeLabel names the type in plain words, such as "Zip archive".
	TypeLabel string
	// Offer is the id of the send_file offer that names the file, or "".
	Offer string
	// Lines is the line count of a text or code file, when known.
	Lines int
}

// Files serves the files the agent offered in a chat, from the machine
// the chat runs on, in ranges, without keeping a copy.
type Files interface {
	// StatFile checks that the session offered path to user (a send_file
	// result, a Markdown link in a reply, or a MEDIA directive), then
	// stats it where the chat runs.
	StatFile(ctx context.Context, user, backendID, sessionID, path string) (*FileInfo, error)
	// A StatFile that fails with ErrMediaTooLarge or ErrSecretFile may
	// still return what it knows of the file.
	// OpenFile is StatFile, then reads length bytes from offset (length
	// -1: to the end). A non-empty etag must match the file's, or it
	// fails with ErrFileChanged. The caller closes the body.
	OpenFile(ctx context.Context, user, backendID, sessionID, path string, offset, length int64, etag string) (*FileInfo, io.ReadCloser, error)
}

// ErrSecretFile is a file the secret rules refuse.
var ErrSecretFile = errors.New("the file looks like a secret, so it is not sent")

// ErrFileChanged is a file that changed since the download began.
var ErrFileChanged = errors.New("the file changed since the download began")

// ErrFileGone is an offered file that is no longer where the offer said:
// moved or deleted. It is also an ErrNoMedia.
var ErrFileGone = fmt.Errorf("%w: the file was moved or deleted", ErrNoMedia)

// RefusedError is a file the secret rules refuse, with the reason in plain
// words. errors.Is(err, ErrSecretFile) holds for it.
type RefusedError struct {
	// Reason says why, such as "looks like a secret".
	Reason string
}

func (e *RefusedError) Error() string {
	if e.Reason == "" {
		return ErrSecretFile.Error()
	}
	return ErrSecretFile.Error() + ": " + e.Reason
}

// Is makes errors.Is(err, ErrSecretFile) true.
func (e *RefusedError) Is(target error) bool { return target == ErrSecretFile }

// RefusalReason is the plain reason of a refused file: the RefusedError's
// reason, or a general one.
func RefusalReason(err error) string {
	var r *RefusedError
	if errors.As(err, &r) && r.Reason != "" {
		return r.Reason
	}
	return "looks like a secret"
}

// FileRequest is what DeviceFiles does with a file.
type FileRequest struct {
	// Offer is the id of the send_file offer that names the file, or "".
	// Only with one does a secret file the user asked for pass.
	Offer string
	// Open reads the file; false only stats it.
	Open bool
	// Offset and Length are the bytes to read (Length -1: to the end).
	Offset, Length int64
	// ETag, when set, must match the file's, or the read fails with
	// ErrFileChanged.
	ETag string
}

// DeviceFiles serves files from where a chat runs, through the device
// plugin of its backend: a paired computer, the sandbox or the Hermes
// server.
type DeviceFiles interface {
	// DeviceFile stats path where the session runs and, with req.Open,
	// reads the bytes req asks for. ok is false when no device plugin
	// serves the session. It fails with ErrFileGone, ErrMediaOffline,
	// ErrMediaTooLarge, ErrFileChanged or a *RefusedError. It does not
	// check that the session offered path. The caller closes the body.
	DeviceFile(ctx context.Context, user, backendID, sessionID, path string, req FileRequest) (fi *FileInfo, body io.ReadCloser, ok bool, err error)
}

// MaxPreviewBytes bounds a PDF the hub renders a preview of.
const MaxPreviewBytes = 64 << 20

// ErrNoPreview is a file the hub has no preview for: not a PDF, too
// large, or the hub cannot render PDFs.
var ErrNoPreview = errors.New("no preview of this file")

// FilePreviews renders previews of offered files.
type FilePreviews interface {
	// FilePreview is a PNG of the first page of an offered PDF and the
	// PDF's page count. It fails as StatFile does, or with ErrNoPreview.
	FilePreview(ctx context.Context, user, backendID, sessionID, path string) (png []byte, pages int, err error)
}

// extKind is the kind of a file by its extension: text, code, archive or
// "".
func extKind(ext string) string {
	switch ext {
	case ".txt", ".md", ".log", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".conf", ".cfg", ".rst":
		return FileKindText
	case ".go", ".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".java", ".kt",
		".rb", ".php", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".css", ".scss", ".html", ".htm", ".vue", ".svelte",
		".swift", ".lua", ".pl", ".r", ".cs", ".zig", ".nix", ".tf", ".proto", ".diff", ".patch":
		return FileKindCode
	case ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar", ".apk", ".ipa", ".jar":
		return FileKindArchive
	}
	return ""
}

// GuessFile types a file from its name and first bytes, for a source that
// does not say: the MIME type ("" when unknown) and the kind. An image
// counts only when its bytes are a PNG, JPEG, GIF or WebP image.
func GuessFile(name string, head []byte) (mimeType, kind string) {
	ext := strings.ToLower(path.Ext(name))
	switch {
	case ImageMIME(head) != "":
		return ImageMIME(head), FileKindImage
	case bytes.HasPrefix(head, []byte("%PDF-")) || ext == ".pdf" && bytes.Contains(head, []byte("%PDF-")):
		return MIMEPDF, FileKindPDF
	}
	switch k := extKind(ext); k {
	case FileKindText, FileKindCode:
		return MIMEText, k
	case FileKindArchive:
		return "", k
	}
	if t := mime.TypeByExtension(ext); strings.HasPrefix(t, "audio/") || strings.HasPrefix(t, "video/") {
		t, _, _ = strings.Cut(t, ";")
		kind, _, _ := strings.Cut(t, "/")
		return t, kind
	}
	return "", FileKindOther
}

// ShowName is a file's base name fit to show and to name a download:
// CleanName, but a leading dot stays, as in .env.
func ShowName(name string) string {
	c := CleanName(name)
	base := strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(base, "/"); i >= 0 {
		base = base[i+1:]
	}
	if strings.HasPrefix(base, ".") && strings.Trim(base, ".") != "" && c != "attachment" {
		return "." + c
	}
	return c
}

// MIME types of files the hub shows inline.
const (
	MIMEPDF  = "application/pdf"
	MIMEText = "text/plain; charset=utf-8"
)
