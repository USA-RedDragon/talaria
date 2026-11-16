package hubapi_test

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/USA-RedDragon/talaria/internal/hubapi"
)

func TestHubKeys(t *testing.T) {
	t.Parallel()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{base64.StdEncoding.EncodeToString(pub)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/device/hub-keys" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "no", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": keys})
	}))
	defer srv.Close()
	got, err := hubapi.New(srv.URL, "tok", "test").HubKeys(t.Context())
	if err != nil || len(got) != 1 || !got[0].Equal(pub) {
		t.Fatalf("HubKeys = %v, %v", got, err)
	}
	keys = []string{"AAAA"}
	if _, err := hubapi.New(srv.URL, "tok", "test").HubKeys(t.Context()); err == nil {
		t.Error("a short key was accepted")
	}
	if _, err := hubapi.New(srv.URL, "bad", "test").HubKeys(t.Context()); err == nil {
		t.Error("a refused token was accepted")
	}
}
