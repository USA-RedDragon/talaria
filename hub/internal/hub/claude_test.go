package hub_test

import (
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

const (
	sonnet    = "Sonnet 5.5"
	opus      = "claude-opus-5-5"
	fable     = "claude-fable-5-2"
	localID   = "custom:local"
	caamKey   = "claude-api-caam"
	jaamKey   = "claude-api-jaam"
	claudeTop = "Claude"
	localName = "local"
	qwen      = "qwen"
	sonnet1m  = "claude-sonnet-5-5[1m]"
	keysGroup = "Claude API credits"
)

func TestClaudeModelName(t *testing.T) {
	t.Parallel()
	for id, want := range map[string]string{
		"claude-opus-5-5[1m]":       "Opus 5.5",
		"claude-sonnet-5-5":         sonnet,
		fable:                       "Fable 5.2",
		"claude-haiku-4-5-20251001": "Haiku 4.5",
		"claude-opus-5":             "Opus 5",
		"claude-opus":               "",
		"claude-":                   "",
		"claude-5-5":                "",
		"claude-opus-x":             "",
		"qwen3.8:27b":               "",
	} {
		got, ok := hub.ClaudeModelName(id)
		if got != want || ok != (want != "") {
			t.Errorf("ClaudeModelName(%q) = %q, %v; want %q", id, got, ok, want)
		}
	}
}

func TestArrangeModels(t *testing.T) {
	t.Parallel()
	const haiku = "claude-haiku-5-5"
	ps := []hub.ModelProvider{
		{ID: localID, Name: localName, Models: []hub.ModelChoice{{ID: qwen}}},
		{ID: caamKey, Name: "Claude API (caam)", Models: []hub.ModelChoice{{ID: opus}}},
		{ID: hub.ClaudePoolProvider, Name: claudeTop, Models: []hub.ModelChoice{{ID: sonnet1m}}},
		{ID: jaamKey, Name: "Claude API (jaam)", Models: []hub.ModelChoice{{ID: haiku}}},
		{ID: "claude-api-", Name: "odd", Models: []hub.ModelChoice{{ID: haiku}}},
	}
	hub.ArrangeModels(ps)
	want := [][3]string{
		{hub.ClaudePoolProvider, claudeTop, sonnet},
		{caamKey, keysGroup, "Opus 5.5 (caam credits)"},
		{jaamKey, keysGroup, "Haiku 5.5 (jaam credits)"},
		{localID, localName, qwen},
		{"claude-api-", "odd", haiku},
	}
	for i, w := range want {
		if p := ps[i]; p.ID != w[0] || p.Group != w[1] || p.Models[0].Label != w[2] {
			t.Errorf("provider %d = %s %q %q, want %v", i, p.ID, p.Group, p.Models[0].Label, w)
		}
	}
}

func TestArrangeModelsCreditsPool(t *testing.T) {
	t.Parallel()
	ids := []string{"claude-opus-4-8", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", fable, "claude-fable-5-1"}
	pooled := hub.ModelProvider{ID: hub.ClaudeCreditsProvider, Name: keysGroup}
	for _, id := range ids {
		pooled.Models = append(pooled.Models, hub.ModelChoice{ID: id})
	}
	ps := []hub.ModelProvider{
		{ID: localID, Name: localName, Models: []hub.ModelChoice{{ID: qwen}}},
		{ID: caamKey, Name: "Claude API (caam)", Models: []hub.ModelChoice{{ID: opus}}},
		pooled,
		{ID: hub.ClaudePoolProvider, Name: claudeTop, Models: []hub.ModelChoice{{ID: sonnet1m}}},
		{ID: jaamKey, Name: "Claude API (jaam)", Models: []hub.ModelChoice{{ID: "claude-haiku-5-5"}}},
	}
	hub.ArrangeModels(ps)
	order := make([]string, 0, len(ps))
	for _, p := range ps {
		order = append(order, p.ID)
	}
	if want := "claude-pool,claude-credits,claude-api-caam,claude-api-jaam,custom:local"; strings.Join(order, ",") != want {
		t.Fatalf("order = %v, want %s", order, want)
	}
	if ps[1].Group != hub.ClaudeKeysGroup || ps[2].Group != hub.ClaudeKeysGroup {
		t.Errorf("groups = %q, %q, want %q", ps[1].Group, ps[2].Group, hub.ClaudeKeysGroup)
	}
	got := make([]string, 0, len(ps[1].Models))
	for _, m := range ps[1].Models {
		got = append(got, m.ID+"="+m.Label)
	}
	want := []string{opus + "=Opus 5.5 (API credits)", "claude-sonnet-5-5=Sonnet 5.5 (API credits)",
		"claude-fable-5-2=Fable 5.2 (API credits)", "claude-haiku-5-5=Haiku 5.5 (API credits)"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("credits models = %v, want %v", got, want)
	}
	if l := ps[2].Models[0].Label; l != "Opus 5.5 (caam credits)" {
		t.Errorf("per-account label = %q", l)
	}
}

func TestArrangeModelsNewestPerFamily(t *testing.T) {
	t.Parallel()
	ids := []string{"claude-sonnet-5-5[1m]", "claude-opus-5-5[1m]", "claude-fable-5-1[1m]", "claude-haiku-5-5[1m]",
		fable, "claude-haiku-4-5-20251001", "claude-opus-4-8[1m]", "claude-mythos-5-1[1m]", "default"}
	p := hub.ModelProvider{ID: hub.ClaudePoolProvider}
	for _, id := range ids {
		p.Models = append(p.Models, hub.ModelChoice{ID: id})
	}
	ps := []hub.ModelProvider{p}
	hub.ArrangeModels(ps)
	got := make([]string, 0, len(ps[0].Models))
	for _, m := range ps[0].Models {
		got = append(got, m.Label)
	}
	want := []string{"Opus 5.5", "Sonnet 5.5", "Fable 5.2", "Haiku 5.5", "Mythos 5.1", "default"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("pool models = %v, want %v", got, want)
	}
}
