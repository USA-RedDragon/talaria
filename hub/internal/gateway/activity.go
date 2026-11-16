package gateway

// Methods of a session's subagents and background work, as the shared
// owner serves them (gateway/session_ancillary.py, session_tui_side.py and
// session_tui_ops.py). Each one acts only on the named session's own
// children and processes.
const (
	MethodSubagentList      = "subagent.list"
	MethodSubagentTail      = "subagent.tail"
	MethodSubagentSteer     = "subagent.steer"
	MethodSubagentInterrupt = "subagent.interrupt"
	MethodSubagentRoster    = "subagent.roster"
	MethodProcessList       = "process.list"
	MethodProcessKill       = "process.kill"
	MethodDelegationStatus  = "delegation.status"
	MethodDelegationPause   = "delegation.pause"
	MethodPromptBackground  = "prompt.background"
	// MethodSessionTodos reads a session's stored to-do list, or a
	// child's with subagent_id (Hermes patch 0126).
	MethodSessionTodos = "session.todos"
)

// CodeMethodNotFound is the JSON-RPC code of a method the server does not
// have, such as session.todos on a Hermes from before patch 0126.
const CodeMethodNotFound = -32601

// TodoUpdatedEvent carries the whole to-do list after it changed:
// {"todos", "revision"}.
const TodoUpdatedEvent = "todo.updated"

// BackgroundCompleteEvent ends a /bg prompt: {"task_id", "text"}.
const BackgroundCompleteEvent = "background.complete"

// SessionParams names one session and nothing else, as process.list and
// subagent.list take it.
type SessionParams struct {
	SessionID string `json:"session_id"`
}

// SubagentParams names one subagent of a session (subagent.tail,
// subagent.interrupt). The owner refuses any other key.
type SubagentParams struct {
	SessionID  string `json:"session_id"`
	SubagentID string `json:"subagent_id"`
}

// SteerParams is subagent.steer's params.
type SteerParams struct {
	SessionID  string `json:"session_id"`
	SubagentID string `json:"subagent_id"`
	Text       string `json:"text"`
}

// SubagentRow is one subagent.list row (session_ancillary.subagent_row).
type SubagentRow struct {
	SubagentID     string   `json:"subagent_id"`
	ParentID       *string  `json:"parent_id"`
	Depth          *int     `json:"depth"`
	Goal           string   `json:"goal"`
	DelegationID   *string  `json:"delegation_id"`
	Model          *string  `json:"model"`
	StartedAt      *float64 `json:"started_at"`
	Status         *string  `json:"status"`
	ToolCount      *int     `json:"tool_count"`
	LastTool       *string  `json:"last_tool"`
	LastPreview    *string  `json:"last_preview"`
	AcceptingSteer *bool    `json:"accepting_steer"`
	ChildSessionID *string  `json:"child_session_id"`
	// WaitingOn are the commands of the background processes a "waiting" subagent will be resumed by.
	WaitingOn []string `json:"waiting_on"`
	// The field holds the child's to-do list at a glance (Hermes patch 0126); nil while it keeps none.
	Todo *TodoBrief `json:"todo"`
}

// TodoBrief is a child's to-do list at a glance: its in-progress items and
// the count of each status (and "total").
type TodoBrief struct {
	Current  []TodoCurrent  `json:"current"`
	Counts   map[string]int `json:"counts"`
	Revision int64          `json:"revision"`
}

// TodoCurrent is one in-progress item of a TodoBrief.
type TodoCurrent struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

// TodoItem is one item of a to-do list (tools/todo_tool.py): Status is
// pending, in_progress, completed, cancelled or blocked; Parent nests it
// under another item to any depth; Owner is the subagent it is assigned to.
type TodoItem struct {
	ID      string `json:"id"`
	Content string `json:"content"`
	Status  string `json:"status"`
	Parent  string `json:"parent,omitempty"`
	Notes   string `json:"notes,omitempty"`
	Owner   string `json:"owner,omitempty"`
}

// TodoState is a whole to-do list with its revision.
type TodoState struct {
	Todos    []TodoItem `json:"todos"`
	Revision int64      `json:"revision"`
}

// SessionTodosParams is session.todos' params; SubagentID reads that
// child's list instead of the session's.
type SessionTodosParams struct {
	SessionID  string `json:"session_id"`
	SubagentID string `json:"subagent_id,omitempty"`
}

// SessionTodos is session.todos' result. TodoState is nil when no list was
// ever stored.
type SessionTodos struct {
	SessionID  string     `json:"session_id"`
	SubagentID string     `json:"subagent_id"`
	Running    *bool      `json:"running"`
	TodoState  *TodoState `json:"todo_state"`
}

// SubagentList is subagent.list's result.
type SubagentList struct {
	Subagents []SubagentRow `json:"subagents"`
}

// SubagentTail is subagent.tail's result: the end of the child's live
// transcript, at most 16 KiB.
type SubagentTail struct {
	SubagentID string `json:"subagent_id"`
	Available  bool   `json:"available"`
	Text       string `json:"text"`
	Truncated  bool   `json:"truncated"`
}

// SteerResult is subagent.steer's result: "queued", "delivered" (the subagent
// was waiting on a background job and the text woke it) or "rejected".
type SteerResult struct {
	Status string `json:"status"`
}

// InterruptResult is subagent.interrupt's result.
type InterruptResult struct {
	Found bool `json:"found"`
}

// ProcessRow is one process.list row (session_ancillary.process_snapshot).
// SessionID is the process's id in the registry.
type ProcessRow struct {
	SessionID        string   `json:"session_id"`
	Command          string   `json:"command"`
	Status           string   `json:"status"`
	ExitCode         *int     `json:"exit_code"`
	StartedEpoch     *float64 `json:"started_epoch"`
	ExitedAt         *float64 `json:"exited_at"`
	CompletionReason *string  `json:"completion_reason"`
	OutputTail       string   `json:"output_tail"`
}

// ProcessList is process.list's result.
type ProcessList struct {
	Processes []ProcessRow `json:"processes"`
}

// ProcessKillParams is process.kill's params.
type ProcessKillParams struct {
	SessionID string `json:"session_id"`
	ProcessID string `json:"process_id"`
}

// ProcessKillResult is the part of process.kill's result the hub reads
// (tools/process_registry.py kill_process).
type ProcessKillResult struct {
	Status string `json:"status"`
}

// DelegationStatus is the part of delegation.status's result the hub
// passes on. The result's "active" lists the subagents of every chat of
// the gateway, so the hub never passes it on.
type DelegationStatus struct {
	Paused bool `json:"paused"`
}

// DelegationPauseParams is delegation.pause's params. With a session the
// owner checks that the caller may control that session; the gate itself
// covers every chat of the gateway process.
type DelegationPauseParams struct {
	SessionID string `json:"session_id"`
	Paused    bool   `json:"paused"`
}

// BackgroundParams is prompt.background's params.
type BackgroundParams struct {
	SessionID string `json:"session_id"`
	Text      string `json:"text"`
}

// BackgroundResult is prompt.background's result. The answer comes later
// as a background.complete event with the same task_id.
type BackgroundResult struct {
	TaskID string `json:"task_id"`
}

// Roster is subagent.roster's result: the stored sessions of the profile
// that have subagents or background processes running now
// (tui_gateway/methods_subagents.py).
type Roster struct {
	Sessions []struct {
		SessionID  string `json:"session_id"`
		Subagents  int    `json:"subagents"`
		Background int    `json:"background"`
	} `json:"sessions"`
}
