package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/USA-RedDragon/talaria/hub/internal/gateway"
	"github.com/USA-RedDragon/talaria/hub/internal/gateway/gatewaytest"
	"github.com/USA-RedDragon/talaria/hub/internal/service"
)

const (
	statusInProgress = "in_progress"
	statusPending    = "pending"
)

func planItems() []gateway.TodoItem {
	return []gateway.TodoItem{
		{ID: "1", Content: "Ship the build", Status: statusInProgress},
		{ID: "2", Content: "Check touch", Status: statusInProgress, Parent: "1", Notes: "libnx touch test", Owner: subMine},
		{ID: "3", Content: "Icon", Status: statusPending, Parent: "1"},
	}
}

// Todos reads the chat's stored list with session.todos, keeps every field
// of an item (parent, notes, owner) and the revision, and a child's list
// with subagent_id; the call names only the session and, for a child, it.
func TestTodosReadStoredLists(t *testing.T) {
	t.Parallel()
	e := activitySetup(t)
	ctx := context.Background()
	got, err := e.svc.Todos(ctx, userAlice, backendPC, sLive, "")
	if err != nil || !got.Supported || len(got.Todos) != 0 || got.Revision != 0 {
		t.Fatalf("no list stored = %+v, %v", got, err)
	}
	e.gw.SetTodos(sLive, planItems(), false)
	e.gw.SetChildTodos(sLive, subMine, []gateway.TodoItem{{ID: "a", Content: "Read the store", Status: statusInProgress}, {ID: "b", Content: "Report", Status: statusPending}})
	got, err = e.svc.Todos(ctx, userAlice, backendPC, sLive, "")
	if err != nil || !got.Supported || got.Revision != 1 || len(got.Todos) != 3 {
		t.Fatalf("chat list = %+v, %v", got, err)
	}
	if it := got.Todos[1]; it.ID != "2" || it.Parent != "1" || it.Notes != "libnx touch test" || it.Owner != subMine || it.Status != statusInProgress {
		t.Fatalf("item = %+v", it)
	}
	child, err := e.svc.Todos(ctx, userAlice, backendPC, sLive, subMine)
	if err != nil || len(child.Todos) != 2 || !child.Running || child.Todos[0].Content != "Read the store" {
		t.Fatalf("child list = %+v, %v", child, err)
	}
	for _, c := range e.gw.Calls() {
		if c.Method != gateway.MethodSessionTodos {
			continue
		}
		if c.Params["session_id"] != sLive || (len(c.Params) != 1 && c.Params["subagent_id"] != subMine) {
			t.Fatalf("session.todos params = %v", c.Params)
		}
	}
	// A subagent of another chat is not read through this one.
	other, err := e.svc.Todos(ctx, userAlice, backendPC, sLive, subOther)
	if err != nil || len(other.Todos) != 0 {
		t.Fatalf("another chat's subagent = %+v, %v", other, err)
	}
}

// subagent.list rows carry the child's todo brief: its in-progress item and
// the count per status.
func TestActivityCarriesSubagentTodoBrief(t *testing.T) {
	t.Parallel()
	e := activitySetup(t)
	e.gw.SetChildTodos(sLive, subMine, []gateway.TodoItem{
		{ID: "a", Content: "Read the store", Status: statusInProgress}, {ID: "b", Content: "Report", Status: statusPending}, {ID: "c", Content: "Done", Status: "completed"}})
	st, err := e.svc.Activity(context.Background(), userAlice, backendPC, sLive)
	if err != nil {
		t.Fatal(err)
	}
	b := st.Subagents[0].Todo
	if b == nil || len(b.Current) != 1 || b.Current[0].Content != "Read the store" || b.Counts["total"] != 3 || b.Counts["completed"] != 1 || b.Counts[statusPending] != 1 {
		t.Fatalf("brief = %+v", b)
	}
	if st.Subagents[1].Todo != nil {
		t.Fatalf("a child with no list has a brief: %+v", st.Subagents[1].Todo)
	}
}

// A Hermes from before patch 0126 has no session.todos: the hub reads that
// as no list, never as an error.
func TestTodosOnAnOlderHermes(t *testing.T) {
	t.Parallel()
	e := activitySetup(t)
	e.gw.NoTodoSupport()
	got, err := e.svc.Todos(context.Background(), userAlice, backendPC, sLive, "")
	if err != nil || got.Supported || len(got.Todos) != 0 {
		t.Fatalf("older hermes = %+v, %v", got, err)
	}
	got, err = e.svc.Todos(context.Background(), userAlice, backendPC, sLive, subMine)
	if err != nil || got.Supported || len(got.Todos) != 0 {
		t.Fatalf("older hermes, subagent = %+v, %v", got, err)
	}
}

// todo.updated reaches the chat's viewers with the whole list and its
// revision, as Hermes sent it.
func TestTodoUpdatedReachesViewers(t *testing.T) {
	t.Parallel()
	e := setup(t, service.Options{})
	e.gw.AddSession(&gatewaytest.Session{ID: sLive, Live: true})
	ctx := context.Background()
	ch, stop, err := e.svc.Attach(ctx, userAlice, backendPC, sLive, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	next(t, ch)
	e.gw.SetTodos(sLive, planItems(), true)
	for {
		ev := next(t, ch)
		if ev.Kind != gateway.TodoUpdatedEvent {
			continue
		}
		var p struct {
			Todos    []gateway.TodoItem `json:"todos"`
			Revision int64              `json:"revision"`
		}
		if err := json.Unmarshal(ev.Data, &p); err != nil || p.Revision != 1 || len(p.Todos) != 3 || p.Todos[1].Owner != subMine || p.Todos[1].Notes != "libnx touch test" {
			t.Fatalf("todo.updated = %s, %v", ev.Data, err)
		}
		return
	}
}
