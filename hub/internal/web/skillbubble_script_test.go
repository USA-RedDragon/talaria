package web_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
)

const skillNote = "\n\n[Subagents in this chat (this replaces any earlier subagent note): auto. Pick each subagent's `option`: quick.]"

const skillInstruction = "\n\nThe user has provided the following instruction alongside the skill invocation: "

// A slash command of a skill shows as the command the user typed with the
// skill's text in a collapsed card after it, in a stored chat and when the
// user sends it; testdata/skillbubble/run.js drives the real page in
// headless Chrome. SKILLBUBBLE_SHOT=prefix also writes screenshots. It
// skips where node or Chrome is missing.
func TestSlashSkillShowsAsTypedCommandWithCard(t *testing.T) {
	t.Parallel()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	chrome := chromePath(t)
	raw, err := os.ReadFile(filepath.Join("testdata", "skillbubble", "shapes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var shapes struct{ Single, Stacked string }
	if err := json.Unmarshal(raw, &shapes); err != nil {
		t.Fatal(err)
	}
	e := setup(t)
	e.gw.SetSkill("askswsupport-stats", func(arg string) string {
		if arg == "" {
			return shapes.Single
		}
		return shapes.Single + skillInstruction + arg
	})
	e.gw.AddSession(&gatewaytest.Session{ID: "s9", Title: "Skill bubble", Live: true, StartedAt: 900,
		Messages: []map[string]any{
			{kRole: roleUser, kText: shapes.Single, keySubmission: "hub:aaaaaaaa-1"},
			{kRole: roleAssistant, kText: "Scraping the page."},
			{kRole: roleUser, kText: shapes.Single + skillInstruction + "last 7 days, only TFE" + skillNote, keySubmission: "hub:aaaaaaaa-2"},
			{kRole: roleAssistant, kText: "Counting the last week."},
			{kRole: roleUser, kText: shapes.Stacked, keySubmission: "hub:aaaaaaaa-3"},
			{kRole: roleAssistant, kText: "Comparing them."},
		}})
	cmd := browserCmd(t.Context(), t, node, filepath.Join("testdata", "skillbubble", "run.js"), chrome, e.url, t.TempDir())
	cmd.Env = append(os.Environ(), "SHOT_PREFIX="+os.Getenv("SKILLBUBBLE_SHOT"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
