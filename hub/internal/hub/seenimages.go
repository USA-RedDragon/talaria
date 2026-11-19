package hub

import (
	"context"
	"encoding/json"
	"regexp"
)

// SeenImage is the record of a kept copy of an image Hermes loaded for the
// model (display_metadata.seen_images of a tool or user row). The id is the
// sha256 of the bytes the model got; Hermes keeps the full image and, for a
// large one, a thumbnail.
type SeenImage struct {
	ID    string `json:"id"`
	MIME  string `json:"mime,omitempty"`
	Bytes int64  `json:"bytes,omitempty"`
	W     int    `json:"w,omitempty"`
	H     int    `json:"h,omitempty"`
	// Thumb says Hermes kept a smaller copy for cards.
	Thumb bool `json:"thumb,omitempty"`
}

// SeenImages serves the kept copies of the images the model saw, so a card
// shows them when the file they came from is gone or was never in the
// chat's folder.
type SeenImages interface {
	// SeenImage opens the copy id (the thumbnail when thumb is set and
	// Hermes kept one). The user needs the access the chat needs; the id,
	// a sha256, is the only input that reaches the backend. It fails with
	// ErrNoMedia when Hermes has no such copy.
	SeenImage(ctx context.Context, user, backendID, sessionID, id string, thumb bool) (*MediaFile, error)
}

var seenImageID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// SeenImageID reports whether s is the id of a kept copy.
func SeenImageID(s string) bool { return seenImageID.MatchString(s) }

// MaxSeenImages bounds the copies one row names.
const MaxSeenImages = 8

// SeenImagesOf reads seen_images from a row's display_metadata, an object or
// a JSON string of one. Records without a well-formed id are dropped.
func SeenImagesOf(md json.RawMessage) []SeenImage {
	if len(md) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(md, &s) == nil {
		md = json.RawMessage(s)
	}
	var m struct {
		Seen []SeenImage `json:"seen_images"`
	}
	if json.Unmarshal(md, &m) != nil {
		return nil
	}
	out := m.Seen[:0]
	for _, r := range m.Seen {
		if SeenImageID(r.ID) && len(out) < MaxSeenImages {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
