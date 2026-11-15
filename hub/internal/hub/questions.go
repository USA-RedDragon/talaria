package hub

import (
	"context"
	"encoding/json"
)

// MaxQuestionLog is how many settled questions of subagents the hub keeps
// for a chat.
const MaxQuestionLog = 20

// QuestionLog keeps the questions that subagents asked in a chat once they
// are over: what was asked, the choices, the answer and when and where it
// came. A chat's own question is kept in its transcript, with the clarify
// tool result. A subagent's is the child's, so nothing in the chat's
// transcript says it was asked, and the hub keeps it for the chat's card.
// Each record is the Data of a clarify.settled event.
type QuestionLog interface {
	// Questions returns the chat's records, oldest first.
	Questions(ctx context.Context, backendID, sessionID string) ([]json.RawMessage, error)
	// AddQuestion adds a record and drops the oldest beyond keep.
	AddQuestion(ctx context.Context, backendID, sessionID string, record json.RawMessage, keep int) error
}

// QuestionID is the prompt_id of a record, "" when it has none.
func QuestionID(record json.RawMessage) string {
	var p struct {
		PromptID string `json:"prompt_id"`
	}
	if json.Unmarshal(record, &p) != nil {
		return ""
	}
	return p.PromptID
}
