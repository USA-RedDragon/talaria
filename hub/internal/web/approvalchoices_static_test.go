package web_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// No renderer of approval choices may fall back to allow and deny alone: an
// approval always offers allow once, allow in this chat and deny, and
// always unless the prompt says why not.
func TestNoTwoButtonApprovalFallback(t *testing.T) {
	t.Parallel()
	files := []string{
		filepath.Join("static", "approvals.js"),
		filepath.Join("static", "activity.js"),
		filepath.Join("..", "telegram", "prompts.go"),
	}
	banned := []*regexp.Regexp{
		regexp.MustCompile(`\[\s*"once"\s*,\s*"deny"\s*\]`),
		regexp.MustCompile(`\[\s*"deny"\s*,\s*"once"\s*\]`),
		regexp.MustCompile(`\ballow\s*:\s*(true|false)\b`),
		regexp.MustCompile(`\{\s*hub\.ChoiceOnce\s*,\s*hub\.ChoiceDeny\s*\}`),
		regexp.MustCompile(`\{\s*gateway\.ChoiceOnce\s*,\s*gateway\.ChoiceDeny\s*\}`),
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, re := range banned {
			if loc := re.FindIndex(b); loc != nil {
				line := 1 + strings.Count(string(b[:loc[0]]), "\n")
				t.Errorf("%s:%d: two-button approval fallback %q", f, line, b[loc[0]:loc[1]])
			}
		}
	}
}

func TestApprovalFallbackNamesTheChatChoice(t *testing.T) {
	t.Parallel()
	for f, want := range map[string]string{
		filepath.Join("static", "approvals.js"):       `["once", "session", "always", "deny"]`,
		filepath.Join("static", "activity.js"):        `["once", "session", "always", "deny"]`,
		filepath.Join("..", "telegram", "prompts.go"): `hub.ChoiceOnce, hub.ChoiceSession, hub.ChoiceAlways, hub.ChoiceDeny`,
	} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), want) {
			t.Errorf("%s has no fallback %s", f, want)
		}
	}
}
