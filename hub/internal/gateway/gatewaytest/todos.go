package gatewaytest

import (
	"slices"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
)

// NoTodoSupport makes session.todos an unknown method, as on a Hermes from
// before patch 0126.
func (g *Gateway) NoTodoSupport() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.noTodos = true
}

// SetTodos stores the session's to-do list, as the agent does on a write,
// and with publish sends the todo.updated event that carries it.
func (g *Gateway) SetTodos(sessionID string, items []gateway.TodoItem, publish bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.sessions[sessionID]
	rev := int64(1)
	if s.todos != nil {
		rev = s.todos.Revision + 1
	}
	s.todos = &gateway.TodoState{Todos: slices.Clone(items), Revision: rev}
	if publish {
		g.publishLocked(s, gateway.TodoUpdatedEvent, map[string]any{"todos": items, "revision": rev})
	}
}

// SetChildTodos stores the to-do list of subagent subagentID of the
// session, and updates the todo brief its subagent.list row carries.
func (g *Gateway) SetChildTodos(sessionID, subagentID string, items []gateway.TodoItem) {
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.sessions[sessionID]
	if s.childTodos == nil {
		s.childTodos = map[string]*gateway.TodoState{}
	}
	rev := int64(1)
	if old := s.childTodos[subagentID]; old != nil {
		rev = old.Revision + 1
	}
	s.childTodos[subagentID] = &gateway.TodoState{Todos: slices.Clone(items), Revision: rev}
	if i := s.subagent(subagentID); i >= 0 {
		s.Subagents[i].Todo = todoBrief(s.childTodos[subagentID])
	}
}

// todoBrief is TodoStore.brief: the in-progress items and a count per status.
func todoBrief(st *gateway.TodoState) *gateway.TodoBrief {
	b := &gateway.TodoBrief{Current: []gateway.TodoCurrent{}, Counts: map[string]int{"total": len(st.Todos)}, Revision: st.Revision}
	for _, it := range st.Todos {
		b.Counts[it.Status]++
		if it.Status == "in_progress" {
			b.Current = append(b.Current, gateway.TodoCurrent{ID: it.ID, Content: it.Content})
		}
	}
	return b
}

// hSessionTodos serves session.todos (gateway/session_ancillary.py): the
// stored list read from state.db, a child's with subagent_id, null when
// none is stored.
func (g *Gateway) hSessionTodos(_ *conn, p map[string]any) (any, string, func()) {
	s, rerr := g.sessionLocked(p, kSubagentID)
	if rerr != "" {
		return nil, rerr, nil
	}
	if s.NoTodos {
		return nil, "unknown method: " + gateway.MethodSessionTodos, nil
	}
	res := map[string]any{kSessionID: s.ID, kSubagentID: nil, "running": nil, "todo_state": nil}
	st := s.todos
	if id := str(p, kSubagentID); id != "" {
		res[kSubagentID] = id
		res["running"] = s.subagent(id) >= 0
		st = s.childTodos[id]
	}
	if st != nil {
		res["todo_state"] = st
	}
	return res, "", nil
}
