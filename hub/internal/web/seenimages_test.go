package web_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

const (
	kImageURL   = "image_url"
	kSeenImages = "seen_images"
	kBytes      = "bytes"
	kQuestion   = "question"
	qWhat       = "what"
	qDone       = "done"
	seenID      = "3f2a9c5e7b1d4086a2c9e5f7103b6d8a4c2e9f1b7a3d5c8e0f2b4a6c8d0e1f23"
	otherID     = "00000000000000000000000000000000000000000000000000000000000000ff"
	relift      = "/home/reddragon/.cache/relift/work/sheet.png"
	stepVision  = "vision_analyze"
)

// seenSteps are a subagent's vision call on a file that is nowhere the chat
// can reach, and its result row with the copy Hermes kept of the image.
func seenSteps(md map[string]any) []map[string]any {
	return []map[string]any{
		{kRole: roleUser, keyText: goalRead, kTimestamp: 1000.0},
		{kRole: roleAssistant, keyText: "", kTimestamp: 1001.0,
			kCalls: []map[string]any{{"id": "v1", fieldName: stepVision, kArgs: map[string]any{kImageURL: relift, kQuestion: qWhat}}}},
		{kRole: stepTool, fieldName: stepVision, kCallID: "v1", kTimestamp: 1002.0,
			kArgs:    map[string]any{kImageURL: relift, kQuestion: qWhat},
			sjResult: "Image loaded into your context", keyResultSize: 30, keyDisplayMeta: md},
	}
}

func seenURL(e *hubEnv, backend, id string) string {
	return e.url + "/api/sessions/" + backend + "/s1/seen/" + id
}

// A subagent's vision step carries the copy Hermes kept, and the hub serves
// it by id through the chat: the card shows the image the model saw, with the
// file long gone and outside the chat's folder.
func TestSubagentVisionStepShowsTheStoredCopy(t *testing.T) {
	t.Parallel()
	e := activityEnv(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	e.gw.SetSeenImage(seenID, []byte(shotPNG))
	rec := map[string]any{"id": seenID, "mime": mimePNG, kBytes: len(shotPNG), "w": 64, "h": 48, "thumb": true}
	e.gw.AddChildRows("s1", "sa-0-a", seenSteps(map[string]any{kSeenImages: []any{rec, map[string]any{"id": "../etc/passwd"}}})...)
	c := client(t)
	login(t, e, c)

	var r struct {
		Events []struct {
			Type string `json:"type"`
			Seen []struct {
				ID    string `json:"id"`
				Thumb bool   `json:"thumb"`
			} `json:"seen"`
		} `json:"events"`
	}
	resp, body := get(t, c, e.url+eventsA)
	if resp.StatusCode != http.StatusOK || json.Unmarshal([]byte(body), &r) != nil || len(r.Events) != 3 {
		t.Fatalf("events = %d %s", resp.StatusCode, body)
	}
	end := r.Events[2]
	if end.Type != "tool_end" || len(end.Seen) != 1 || end.Seen[0].ID != seenID || !end.Seen[0].Thumb {
		t.Fatalf("tool end = %+v (a malformed id must be dropped)", end)
	}
	// The hub's stored log gives it back as well.
	if again := get2(t, c, e.url+eventsA+"?after=0"); !strings.Contains(again, seenID) {
		t.Fatalf("a re-read lost the seen copy: %s", again)
	}

	resp, body = get(t, c, seenURL(e, "pc", seenID))
	h := resp.Header
	if resp.StatusCode != http.StatusOK || body != shotPNG || h.Get("Content-Type") != mimePNG || h.Get("X-Content-Type-Options") != nosniff ||
		!strings.Contains(h.Get("Content-Security-Policy"), "sandbox") || !strings.Contains(h.Get("Cache-Control"), "immutable") {
		t.Fatalf("seen image = %d %q %v", resp.StatusCode, body, h)
	}
	if resp, body = get(t, c, seenURL(e, "pc", seenID)+"?size=thumb"); resp.StatusCode != http.StatusOK || body != shotPNG {
		t.Fatalf("thumb = %d %q", resp.StatusCode, body)
	}
	before := len(e.gw.SeenImageReads())
	for _, id := range []string{otherID, "../etc/passwd", "ABC", seenID + "0", strings.ToUpper(seenID)} {
		if resp, body = get(t, c, seenURL(e, "pc", id)); resp.StatusCode != http.StatusNotFound {
			t.Fatalf("%q = %d %s", id, resp.StatusCode, body)
		}
	}
	if got := e.gw.SeenImageReads(); len(got) != before { // no malformed id reached Hermes, and Hermes had no copy of the unknown one
		t.Fatalf("reads = %v", got)
	}
	if resp, _ = get(t, c, seenURL(e, backendHome, seenID)); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("other backend = %d", resp.StatusCode)
	}
	if resp, _ = get(t, client(t), seenURL(e, "pc", seenID)); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d", resp.StatusCode)
	}
}

func get2(t *testing.T, c *http.Client, u string) string {
	t.Helper()
	_, body := get(t, c, u)
	return body
}

// A row from before Hermes kept copies has only the path: the chat serves the
// image of a subagent's vision call once the steps were read (a subagent's
// calls are not in the chat's own rows), and not before, and not any other.
func TestSubagentVisionPathIsServedOnceItsStepsWereRead(t *testing.T) {
	t.Parallel()
	e := activityEnv(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	p := shotDir + "sub.png"
	e.gw.SetFile(p, []byte(shotPNG))
	e.gw.SetFile(shotDir+"other.png", []byte(shotPNG))
	rows := seenSteps(nil)
	rows[1][kCalls] = []map[string]any{{"id": "v1", fieldName: stepVision, kArgs: map[string]any{kImageURL: p}}}
	rows[2][kArgs] = map[string]any{kImageURL: p}
	e.gw.AddChildRows("s1", "sa-0-a", rows...)
	c := client(t)
	login(t, e, c)
	media := func(path string) int {
		resp, _ := get(t, c, e.url+activityBase+"/media?path="+path)
		return resp.StatusCode
	}
	if got := media(p); got != http.StatusNotFound {
		t.Fatalf("before the steps were read: %d", got)
	}
	read := steps(t, c, e.url+eventsA)
	if len(read.Events) != 3 {
		t.Fatalf("events = %+v", read)
	}
	if got := media(p); got != http.StatusOK {
		t.Fatalf("after the steps were read: %d", got)
	}
	if got := media(shotDir + "other.png"); got != http.StatusNotFound {
		t.Fatalf("an image no step names: %d", got)
	}
}

// smallPicture is a 64x48 PNG: the kept copy the page must show.
func smallPicture(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := range 48 {
		for x := range 64 {
			img.Set(x, y, color.RGBA{uint8(40 + x*3), uint8(90 + y*2), 200, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// Every image the model saw is visible: in the chat and in a subagent's steps
// in Activity the card shows the copy Hermes kept, though the file is outside
// the chat's folder or gone, and an old row with only a path that is gone
// says so. testdata/seenimg/run.js drives the real page in headless Chrome at
// 412 and 1280 px, light and dark; SEENIMG_SHOTS=dir keeps screenshots.
func TestEveryImageTheModelSawIsShown(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	e.gw.SetCapabilities(gateway.CapTranscriptToolDetails)
	e.gw.SetSeenImage(seenID, smallPicture(t))
	rec := map[string]any{"id": seenID, "mime": mimePNG, "w": 64, "h": 48, "thumb": true}
	call := func(id, p string) map[string]any {
		return map[string]any{kRole: roleAssistant, kText: "", kCalls: []any{map[string]any{"id": id, fnKey: map[string]any{fieldName: stepVision,
			ilArgs: `{kImageURL:"` + p + `",kQuestion:"What is on screen?"}`}}}}
	}
	result := func(id string, md map[string]any) map[string]any {
		return map[string]any{kRole: stepTool, kCallID: id, fieldName: stepVision, kTimestamp: 1763000000.0,
			kText: "Image loaded into your context \u2014 you can see it natively now.\n\nQuestion: q", keyDisplayMeta: md}
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Seen", Live: true, StartedAt: 900,
		Subagents: []gateway.SubagentRow{{SubagentID: subA, Goal: "Look at the sheet", Status: optr(statusRunning), AcceptingSteer: optr(true)}},
		Messages: []map[string]any{
			{kRole: roleUser, kText: "what is on screen?"},
			call("c1", "/home/reddragon/.cache/relift/work/main.png"), result("c1", map[string]any{kSeenImages: []any{rec}}),
			call("c2", "/home/reddragon/.cache/relift/work/old.png"), result("c2", nil),
			{kRole: roleAssistant, kText: qDone},
		}})
	e.gw.AddChildRows("s9", subA, map[string]any{kRole: roleUser, keyText: "Look at the sheet", kTimestamp: 1000.0},
		map[string]any{kRole: roleAssistant, keyText: "", kTimestamp: 1001.0,
			kCalls: []map[string]any{{"id": "v1", fieldName: stepVision, kArgs: map[string]any{kImageURL: relift, kQuestion: qWhat}}}},
		map[string]any{kRole: stepTool, fieldName: stepVision, kCallID: "v1", kTimestamp: 1002.0,
			kArgs: map[string]any{kImageURL: relift, kQuestion: qWhat}, sjResult: "Image loaded into your context", keyResultSize: 30,
			keyDisplayMeta: map[string]any{kSeenImages: []any{rec}}})
	prof := t.TempDir()
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "seenimg", "run.js"), chrome, e.url, prof, seenID)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
