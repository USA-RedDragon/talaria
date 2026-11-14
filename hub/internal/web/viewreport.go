package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// maxViewReport bounds a view report's body: a jump report carries the
// log's last minute of moves.
const maxViewReport = 160 << 10

// viewReportRoute lets a beacon in: it cannot set the CSRF header, so its
// token may be the body's "csrf" field. The page's checks are the same.
func (s *Server) viewReportRoute() http.Handler {
	inner := s.api(s.handleViewReport)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-CSRF-Token") == "" && r.Body != nil {
			body, err := io.ReadAll(io.LimitReader(r.Body, maxViewReport+1))
			if err == nil && len(body) <= maxViewReport {
				var f struct {
					CSRF string `json:"csrf"`
				}
				if json.Unmarshal(body, &f) == nil {
					r.Header.Set("X-CSRF-Token", f.CSRF)
				}
			}
			r.Body = io.NopCloser(io.MultiReader(bytes.NewReader(body), r.Body))
		}
		inner.ServeHTTP(w, r)
	})
}

// handleViewReport logs what a page reports: that it loaded and with which
// release, that the chat it shows left the newest message without the
// reader doing anything (the log's last moves, the chat's events, the
// page's age), that the reading place moved by more than a screen on its
// own ("jump"), or what the reader sent by hand right after one
// ("manual"). Nothing is stored; it is for finding what moves the view in
// a browser the tests do not catch. The token a beacon carries is dropped.
func (s *Server) handleViewReport(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Content-Type") != "application/json" {
		errorJSON(w, http.StatusUnsupportedMediaType, "JSON body required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxViewReport+1))
	if err != nil || len(body) > maxViewReport || !json.Valid(body) {
		errorJSON(w, http.StatusBadRequest, "bad report")
		return
	}
	var m map[string]any
	if json.Unmarshal(body, &m) == nil {
		delete(m, "csrf")
		if clean, err := json.Marshal(m); err == nil {
			body = clean
		}
	}
	msg := "view left the newest message"
	switch m["kind"] {
	case "loaded":
		msg = "page loaded"
	case "jump":
		msg = "view jumped"
	case "manual":
		msg = "view capture sent by hand"
	}
	s.log.Info(msg, "user", userFrom(r), "ua", r.UserAgent(), "report", string(body))
	w.WriteHeader(http.StatusNoContent)
}
