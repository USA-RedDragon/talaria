package web_test

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

// keySource is the word "source": a prompt choice, and a field of a server or model row.
const keySource = "source"

// A smart approval card shows its text as parts: a subagent is named once on
// a line of its own, then Rule and Why (and Source when the card offers the
// source choice) as a list, then the command and the buttons. It fits the
// screen at 412 and 1280 px in light and dark. A prompt from a Hermes that
// sends only the description keeps its one-sentence card.
// testdata/partscard/run.js drives headless Chrome; PARTSCARD_SHOT=prefix also
// writes screenshots. It skips where node or Chrome is missing.
func TestSmartApprovalCardShowsItsParts(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	e := setup(t)
	msgs := []map[string]any{{kRole: roleUser, kText: "go"}, {kRole: roleAssistant, kText: "on it"}}
	appimage := "curl -fsSL -o appimagetool-x86_64.AppImage https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage && chmod +x appimagetool-x86_64.AppImage && ./appimagetool-x86_64.AppImage --appimage-extract"
	card := func(id, cmd, desc string, p gateway.Prompt) []gateway.Prompt {
		p.Kind, p.PromptID, p.Command, p.Description = gateway.PromptApproval, id, optr(cmd), optr(desc)
		return []gateway.Prompt{p}
	}
	e.gw.AddSession(&gatewaytest.Session{ID: "s1", Title: "Parts subagent", Live: true, StartedAt: 900, Messages: msgs,
		Prompts: card("p-sub", `<process_manage> {"action": "kill"}`,
			`Subagent "Analyze Jacob's newest captured chat-view jump (hub v0.26.110, Firefox desktop, 4:47 AM CST 2026-11-15) and find, with proof, what moved the view" asks: Smart approval rule "Interfere With Workloads": The kill call names no session_id.`,
			gateway.Prompt{Choices: []string{gateway.ChoiceOnce, gateway.ChoiceSession, gateway.ChoiceAlways, gateway.ChoiceDeny},
				Subagent: optr("Analyze Jacob's newest captured chat-view jump (hub v0.26.110, Firefox desktop, 4:47 AM CST 2026-11-15) and find, with proof, what moved the view"),
				Rule:     optr("Interfere With Workloads"),
				Reason:   optr("The kill names no process, so it can't be shown to stop only something this agent started. A kill like this one was blocked earlier in this chat.")})})
	e.gw.AddSession(&gatewaytest.Session{ID: "s2", Title: "Parts chat", Live: true, StartedAt: 800, Messages: msgs,
		Prompts: card("p-chat", "bash /opt/data/hermes/cache/blocked-scripts/blocked-1794740610-993997d8.sh",
			`Smart approval rule "Auto-Mode Bypass": old text`,
			gateway.Prompt{Choices: []string{gateway.ChoiceOnce, gateway.ChoiceSession, gateway.ChoiceAlways, gateway.ChoiceDeny}, Rule: optr("Auto-Mode Bypass"),
				Reason: optr("Runs a saved copy of a command that was blocked a moment ago (the hub v0.26.111 rollout), retrying it a different way.")})})
	e.gw.AddSession(&gatewaytest.Session{ID: "s3", Title: "Parts source", Live: true, StartedAt: 700, Messages: msgs,
		Prompts: card("p-src", appimage, `Smart approval rule "Code from External": old text`,
			gateway.Prompt{Choices: []string{gateway.ChoiceOnce, gateway.ChoiceSession, gateway.ChoiceAlways, gateway.ChoiceDeny},
				Subagent: optr("relift chunk appimage-runtime: package the runtime"), Rule: optr("Code from External"),
				Reason:      optr("Downloads an AppImage from GitHub and runs it. You didn't name this tool or where it comes from."),
				GrantSource: optr("github.com/AppImage/appimagetool")})})
	e.gw.AddSession(&gatewaytest.Session{ID: "s4", Title: "Parts older", Live: true, StartedAt: 600, Messages: msgs,
		Prompts: card("p-old", "rm -rf build",
			`Subagent "relift chunk" asks: Smart approval rule "Delete Files": Removes the build folder.`,
			gateway.Prompt{Choices: []string{gateway.ChoiceOnce, gateway.ChoiceSession, gateway.ChoiceAlways, gateway.ChoiceDeny}, Subagent: optr("relift chunk")})})
	prof := t.TempDir()
	out, err := browserCmd(t.Context(), t, node, filepath.Join("testdata", "partscard", "run.js"), chrome, e.url, prof).CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, strings.TrimSpace(string(out)))
	}
}
