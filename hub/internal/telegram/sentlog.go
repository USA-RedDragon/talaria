package telegram

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/USA-RedDragon/talaria/hub/internal/hub"
)

// sentKeep is how long the bot keeps the record of the messages it sent
// for events: longer than a turn runs.
const sentKeep = 7 * 24 * time.Hour

// sentLog finds and records the messages the bot sent for the events of
// a chat (hub.TelegramSentLog). A replica that takes the bot over during a
// turn attaches the chat again and gets the turn from its start; the
// events it replays give the same keys, so it uses the messages the last
// leader sent instead of sending them again.
type sentLog struct {
	log    hub.TelegramSentLog
	botID  int64
	logger *slog.Logger
}

func newSentLog(state hub.TelegramState, botID int64, logger *slog.Logger) *sentLog {
	log, ok := state.(hub.TelegramSentLog)
	if !ok {
		return nil
	}
	return &sentLog{log: log, botID: botID, logger: logger}
}

// find is the message recorded under key in to, false when none is or
// the log cannot say.
func (l *sentLog) find(ctx context.Context, to dest, key string) (int64, bool) {
	if l == nil || key == "" {
		return 0, false
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer cancel()
	id, ok, err := l.log.TelegramSent(cctx, l.botID, to.chat, to.thread, key)
	if err != nil {
		l.logger.Warn("Failed to read what the bot sent", "chat", to.chat, "error", err)
		return 0, false
	}
	return id, ok && id != 0
}

// save records the message sent under key in to.
func (l *sentLog) save(ctx context.Context, to dest, key string, id int64) {
	if l == nil || key == "" || id == 0 {
		return
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
	defer cancel()
	if err := l.log.SaveTelegramSent(cctx, l.botID, to.chat, to.thread, key, id); err != nil {
		l.logger.Warn("Failed to record what the bot sent", "chat", to.chat, "error", err)
	}
}

// prune forgets the records older than sentKeep.
func (l *sentLog) prune(ctx context.Context, now time.Time) {
	if l == nil {
		return
	}
	if err := l.log.PruneTelegramSent(ctx, now.Add(-sentKeep)); err != nil {
		l.logger.Warn("Failed to prune what the bot sent", "error", err)
	}
}

// causeKey is the key of the next message sent for the event being
// handled: its place in the backend's stream and how many messages it
// sent before. "" between events and for events with no place, whose
// messages are not recorded.
func (r *renderer) causeKey() string {
	if r.sentLog == nil || r.cause.IsZero() {
		return ""
	}
	r.causeN++
	return "e:" + r.session + ":" + r.cause.Epoch + ":" + strconv.FormatInt(r.cause.Seq, 10) + ":" +
		strconv.Itoa(r.cause.Sub) + ":" + strconv.Itoa(r.causeN)
}

// promptKey is the key of the message that shows a prompt.
func (r *renderer) promptKey(id string) string {
	if r.sentLog == nil || id == "" {
		return ""
	}
	return "p:" + r.session + ":" + id
}

// sentBefore is the message recorded under key, as the last leader sent
// it.
func (r *renderer) sentBefore(ctx context.Context, key string) (int64, bool) {
	id, ok := r.sentLog.find(ctx, r.to, key)
	if ok {
		r.logger.Info("Not sending again what the last leader sent", "key", key, "message", id)
	}
	return id, ok
}

// approvalKey is the callback key of a prompt's buttons. It follows from
// the prompt, so every replica that shows the prompt gives it the same
// key and the buttons of a card the last leader sent still work. The bot
// token keys it, so nobody can make one for another prompt.
func approvalKey(token string, to dest, backendID, sessionID, promptID string) string {
	m := hmac.New(sha256.New, []byte(token))
	_, _ = fmt.Fprintf(m, "approval\x00%d\x00%d\x00%s\x00%s\x00%s", to.chat, to.thread, backendID, sessionID, promptID)
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:9])
}

// causeDraftID is the draft ID of a turn that starts at the event being
// handled, the same on every replica, so a replica that takes the bot
// over goes on with the draft that shows. 0 when the event has no place.
func (r *renderer) causeDraftID() int64 {
	if r.sentLog == nil || r.cause.IsZero() {
		return 0
	}
	sum := sha256.Sum256(fmt.Appendf(nil, "draft\x00%d\x00%d\x00%s\x00%s\x00%d\x00%d", r.to.chat, r.to.thread, r.session,
		r.cause.Epoch, r.cause.Seq, r.cause.Sub))
	return int64(binary.BigEndian.Uint64(sum[:8])>>2) + 1
}
