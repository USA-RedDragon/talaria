package web_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// failCopy is Hermes' failure copy around a provider's raw answer.
const failCopy = "Claude rejected this request as malformed, so the model didn't answer. Start a clean session with /new or switch models with /model; if it keeps happening, run `hermes doctor`.\n\nProvider said: HTTP 400: Incomplete upstream response (first upstream attempt: status 400, capture incomplete, native retries denied: 3, upstream said: messages.554.content.0: Invalid `encrypted_content` in `search_result` block): API Error: 400 HERMES_MODEL_ADMISSION_CONSUMED (request_id=req_011Ch7FeWfTSCk9rTqqUKFTh)"

// TestCardShotsChrome draws the cards the card parity run cannot: a failed
// turn's line and the approval and sign-in grant cards. It always asserts
// that each is drawn (the failed turn as one plain line with its details
// folded, no codes in view); CARDSHOTS_DIR=dir also saves PNGs of each at
// 412 and 1280 px, light and dark: <name>-<w>-<light|dark>.png.
func TestCardShotsChrome(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setupComputers(t)
	e.svc.SetLoginGrants(e.opts.LoginGrants)
	msgs := []map[string]any{{kRole: roleUser, kText: "go"}, {kRole: roleAssistant, kText: textOnIt}}
	card := func(id, cmd, desc string, p gateway.Prompt) []gateway.Prompt {
		p.Kind, p.PromptID, p.Command = gateway.PromptApproval, id, optr(cmd)
		if desc != "" {
			p.Description = optr(desc)
		}
		return []gateway.Prompt{p}
	}
	add := func(id, title string, at float64, p []gateway.Prompt) {
		e.gw.AddSession(&gatewaytest.Session{ID: id, Title: title, Live: true, StartedAt: at, Messages: msgs, Prompts: p})
	}
	once, deny := gateway.ChoiceOnce, gateway.ChoiceDeny
	add("c1", "Shot plain approval", 900, card("p1", "rm -rf node_modules && npm ci", "recursive delete", gateway.Prompt{Choices: []string{once, choiceSession, "always", deny}}))
	add("c2", "Shot bare approval", 890, card("p2", "git push --force origin main", "", gateway.Prompt{}))
	add("c3", "Shot smart approval", 880, card("p3", "bash /opt/data/blocked/retry.sh", "", gateway.Prompt{Choices: []string{once, deny},
		Rule: optr("Auto-Mode Bypass"), Reason: optr("Runs a saved copy of a command that was blocked a moment ago, retrying it a different way.")}))
	add("c4", "Shot subagent approval", 870, card("p4", `<process_manage> {"action": "kill"}`, "", gateway.Prompt{Choices: []string{once, deny},
		Subagent: optr("relift chunk appimage-runtime: package the runtime"), Rule: optr("Interfere With Workloads"),
		Reason: optr("The kill names no process, so it can't be shown to stop only something this agent started.")}))
	add("c5", "Shot source approval", 860, card("p5", "curl -fsSL -o tool.AppImage https://github.com/AppImage/appimagetool/releases/download/1.9.1/x.AppImage && ./tool.AppImage", "", gateway.Prompt{
		Choices: []string{once, deny, keySource}, Rule: optr("Code from External"), Reason: optr("Downloads an AppImage from GitHub and runs it."),
		GrantSource: optr("github.com/AppImage/appimagetool")}))
	n := 2
	grant := func(id, name string) *gateway.LoginGrant {
		return &gateway.LoginGrant{DeviceID: id, DeviceName: name, Host: "portal.example.com", SavedLogins: &n, Methods: []string{"Password", "Email link"}}
	}
	add("c6", "Shot sign-in grant", 850, card("p6", "browser_login", "", gateway.Prompt{Choices: []string{once, gateway.ChoiceDevice, deny}, LoginGrant: grant(e.id, pcName)}))
	add("c7", "Shot sign-in unknown", 840, card("p7", "browser_login", "", gateway.Prompt{Choices: []string{once, gateway.ChoiceDevice, deny}, LoginGrant: grant("d_not_mine", "")}))
	e.gw.AddSession(&gatewaytest.Session{ID: "f1", Title: "Shot failed turn", Live: true, StartedAt: 830, Messages: []map[string]any{{kRole: roleUser, kText: "search it"}}})
	// The failed turn arrives live, after the page has the chat.
	poke := pokeServer(t, func() {
		e.gw.Publish("f1", "message.start", map[string]any{})
		e.gw.Publish("f1", "message.complete", map[string]any{keyStatus: statusError, kText: failCopy})
	})
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "cardshots", "run.js"), chrome, e.url, t.TempDir(), poke.URL)
	cmd.Env = append(os.Environ(), "SHOT_DIR="+os.Getenv("CARDSHOTS_DIR"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
