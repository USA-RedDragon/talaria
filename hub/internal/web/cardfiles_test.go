package web_test

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"testing"
)

// cardScripts names the tool card component and the card modules that
// register its renderers, relative to static/, in the order the page loads
// them: toolcard.js, then static/cards/*.js.
func cardScripts(t *testing.T) []string {
	t.Helper()
	found, err := filepath.Glob(filepath.Join("static", "cards", "*.js"))
	if err != nil || len(found) == 0 {
		t.Fatalf("no card modules in static/cards: %v", err)
	}
	sort.Strings(found)
	out := make([]string, 0, 1+len(found))
	out = append(out, fileToolCard)
	for _, f := range found {
		out = append(out, filepath.Join("cards", filepath.Base(f)))
	}
	return out
}

// pokeServer is a server whose every request runs fire on a goroutine of the
// test, outside the request, and answers 204 once it is done: a browser test
// asks it to make the gateway send events after the page has the chat.
func pokeServer(t *testing.T, fire func()) *httptest.Server {
	t.Helper()
	asks := make(chan chan struct{})
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case done := <-asks:
				fire()
				close(done)
			case <-stop:
				return
			}
		}
	}()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		done := make(chan struct{})
		asks <- done
		<-done
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(func() {
		srv.Close()
		close(stop)
	})
	return srv
}

// withCards puts the card scripts in place of toolcard.js in a list of
// static files.
func withCards(t *testing.T, files []string) []string {
	t.Helper()
	out := make([]string, 0, len(files)+8)
	for _, f := range files {
		if f == fileToolCard {
			out = append(out, cardScripts(t)...)
			continue
		}
		out = append(out, f)
	}
	return out
}
