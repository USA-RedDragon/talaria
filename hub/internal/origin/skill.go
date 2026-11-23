package origin

import (
	"regexp"
	"strings"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
	"github.com/USA-RedDragon/talaria/hub/internal/notice"
)

// A slash command of a skill reaches the model as the skill's whole text
// (agent/skill_commands.py build_skill_invocation_message and
// build_stacked_skill_invocation_message), with the words the user typed
// after the command in one marked line. The user typed only the command and
// those words, so the bubble shows them and the rest is a card after it.
// The markers are the ones Hermes cuts the same text at
// (extract_user_instruction_from_skill_message).
var (
	skillSingle = regexp.MustCompile(`^\[IMPORTANT: The user has invoked the "([^"\n]*)" skill, indicating they want you to follow its instructions\. The full skill content is loaded below\.\]\n`)
	skillBundle = regexp.MustCompile(`^\[IMPORTANT: The user has invoked the "([^"\n]*)" (?:[^\n]*? )?skill bundle, loading \d+ skills together\. [^\n]*\]\n(?:[^\n]*\n)*?Skills loaded: ([^\n]+)\n`)
)

const (
	skillInstruction       = "The user has provided the following instruction alongside the skill invocation: "
	skillRuntimeNote       = "\n\n[Runtime note:"
	skillBundleInstruction = "\nUser instruction: "
	skillBundleBlock       = "\n\n[Loaded as part of the "
)

// skillTurn reads the text of a slash skill command: what the user typed,
// and the card for the text Hermes added. ok is false for any other text.
func skillTurn(text string) (typed string, n *notice.Notice, ok bool) {
	t := strings.TrimSpace(text)
	var name, title, instruction string
	switch {
	case skillSingle.MatchString(t):
		name = skillSingle.FindStringSubmatch(t)[1]
		title = "Skill loaded: " + name
		if i := strings.LastIndex(t, skillInstruction); i >= 0 {
			instruction, _, _ = strings.Cut(t[i+len(skillInstruction):], skillRuntimeNote)
		}
	case skillBundle.MatchString(t):
		m := skillBundle.FindStringSubmatch(t)
		name = m[1]
		title = "Skills loaded: " + strings.TrimSpace(m[2])
		if i := strings.Index(t, skillBundleInstruction); i >= 0 {
			instruction, _, _ = strings.Cut(t[i+len(skillBundleInstruction):], skillBundleBlock)
		}
	default:
		return "", nil, false
	}
	if !strings.HasPrefix(name, "/") {
		name = "/" + name
	}
	typed = name
	if instruction = strings.TrimSpace(instruction); instruction != "" {
		typed += " " + instruction
	}
	return typed, &notice.Notice{Kind: notice.KindNotice, Title: title, Result: t}, true
}

// skillFolded shows a user bubble whose text is a skill's expansion as the
// command the user typed, with the expansion as the first card after it.
func skillFolded(v View) View {
	if v.Show != ShowUser {
		return v
	}
	typed, n, ok := skillTurn(hub.CutInjectedNotes(v.Text))
	if !ok {
		return v
	}
	v.Text = typed
	v.After = append([]*notice.Notice{n}, v.After...)
	return v
}
