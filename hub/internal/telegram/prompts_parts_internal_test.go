package telegram

import (
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// A smart approval card's text is separate lines with bold labels: who
// asks (once), the rule, why (a ledger write's lines under it), the source
// when the card offers it, and then the command.
func TestPromptBodyShowsTheCardInParts(t *testing.T) {
	t.Parallel()

	p := &hub.PromptInfo{ID: "p1", Kind: hub.PromptApproval, Choices: []string{hub.ChoiceOnce, hub.ChoiceDeny, hub.ChoiceSource},
		Command:     "curl -o x https://github.com/AppImage/appimagetool/x && ./x",
		Description: `Subagent "relift chunk" asks: Smart approval rule "Code from External": Downloads and runs it.`,
		Subagent:    "relift chunk", Rule: "Code from External", GrantSource: "github.com/AppImage/appimagetool",
		Reason: "Downloads an AppImage & runs it.\n\nIt adds a note to the ledger."}
	want := strings.Join([]string{
		"<b>Subagent:</b> relift chunk",
		"<b>Rule:</b> Code from External",
		"<b>Why:</b> Downloads an AppImage &amp; runs it.",
		"It adds a note to the ledger.",
		"<b>Source:</b> github.com/AppImage/appimagetool",
		"<pre>curl -o x https://github.com/AppImage/appimagetool/x &amp;&amp; ./x</pre>"}, "\n")
	if got := promptBody(p); got != want {
		t.Fatalf("body =\n%s\nwant\n%s", got, want)
	}

	// No source line when the card offers no source choice, no subagent line for the chat's own card.
	p.Choices, p.Subagent = []string{hub.ChoiceOnce, hub.ChoiceDeny}, ""
	got := promptBody(p)
	if strings.Contains(got, "Source:") || strings.Contains(got, "Subagent:") || strings.Contains(got, "asks:") {
		t.Fatalf("body = %s", got)
	}
}

// A Hermes that sends only the description gets the description as before.
func TestPromptBodyFallsBackToTheDescription(t *testing.T) {
	t.Parallel()

	p := &hub.PromptInfo{ID: "p1", Kind: hub.PromptApproval, Command: "rm -rf x", Description: "recursive delete",
		Subagent: "relift chunk", GrantSource: "github.com/o/r", Choices: []string{hub.ChoiceOnce, hub.ChoiceDeny, hub.ChoiceSource}}
	if got, want := promptBody(p), "<pre>rm -rf x</pre>\nrecursive delete"; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}
