package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

var _ hub.QuestionLog = (*Store)(nil)

// questionKey is the meta key of a chat's settled questions.
func questionKey(backendID, sessionID string) string {
	return "questions:" + backendID + ":" + sessionID
}

// Questions returns the settled questions of subagents the hub kept for a
// chat, oldest first.
func (s *Store) Questions(ctx context.Context, backendID, sessionID string) ([]json.RawMessage, error) {
	var v string
	err := s.row(ctx, `SELECT value FROM meta WHERE key = ?`, questionKey(backendID, sessionID)).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []json.RawMessage
	if err := json.Unmarshal([]byte(v), &out); err != nil {
		// A record that cannot be read is no record.
		out = nil
	}
	return out, nil
}

// AddQuestion adds a settled question to a chat's records, and keeps the
// newest keep. A record whose prompt_id is kept already is not added again.
func (s *Store) AddQuestion(ctx context.Context, backendID, sessionID string, record json.RawMessage, keep int) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		key := questionKey(backendID, sessionID)
		var v string
		err := tx.QueryRowContext(ctx, s.q(`SELECT value FROM meta WHERE key = ?`), key).Scan(&v)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var list []json.RawMessage
		if v != "" {
			_ = json.Unmarshal([]byte(v), &list)
		}
		id := hub.QuestionID(record)
		for _, r := range list {
			if id != "" && hub.QuestionID(r) == id {
				return nil
			}
		}
		list = append(list, record)
		if keep > 0 && len(list) > keep {
			list = list[len(list)-keep:]
		}
		out, err := json.Marshal(list)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, s.q(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`), key, string(out))
		return err
	})
}
