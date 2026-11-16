"use strict";
// todo.js without a page: the tree, the counts and their words, the folding of
// finished items, the line above the message box and a subagent's brief.
// usage: node run.js PATH/todo.js
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const sandbox = { window: {}, document: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const T = sandbox.window.HubTodo;
// Values from the sandbox have its own Array and Object: compare them as JSON.
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b);

const item = (id, content, status, extra) => Object.assign({ id, content, status }, extra || {});
const list = (state) => T.clean({ todos: state });

// clean: unknown statuses become to do, ids are unique, text is one line, a bad row is dropped.
{
  const got = list([item("a", "  one \n two ", "weird"), item("a", "again", "completed"), null, 7, { content: "no id" }]);
  eq(got.map((i) => i.id), ["a", "a#2", "#3"]);
  assert.strictEqual(got[0].content, "one two");
  assert.strictEqual(got[0].status, "pending");
  assert.strictEqual(got[2].status, "pending");
  eq(T.clean(null), []);
  eq(T.clean({ todos: "x" }), []);
}

// tree: nesting to any depth, in the agent's order; a missing parent or a loop makes a top item.
{
  const items = list([
    item("1", "top", "in_progress"),
    item("2", "child", "in_progress", { parent: "1" }),
    item("3", "grandchild", "pending", { parent: "2" }),
    item("4", "great", "pending", { parent: "3" }),
    item("5", "second top", "pending"),
    item("6", "orphan", "pending", { parent: "nope" }),
    item("7", "loop a", "pending", { parent: "8" }),
    item("8", "loop b", "pending", { parent: "7" }),
    item("9", "self", "pending", { parent: "9" }),
  ]);
  const roots = T.tree(items);
  const ids = roots.map((n) => n.item.id);
  assert.ok(ids.includes("1") && ids.includes("5") && ids.includes("6") && ids.includes("9"), "tops " + ids);
  // A loop breaks at one item: both of its items still show, once.
  const all = T.walk(roots).map((n) => n.item.id);
  assert.strictEqual(all.length, 9);
  assert.strictEqual(new Set(all).size, 9);
  const great = T.walk(roots).find((n) => n.item.id === "4");
  assert.strictEqual(great.depth, 3);
  eq(all.slice(0, 4), ["1", "2", "3", "4"]);
}

// counts, headline and summary: 6 of 15 done and what is left, by state.
{
  const st = [];
  for (let i = 0; i < 6; i++) st.push(item("d" + i, "done " + i, "completed"));
  st.push(item("p", "now", "in_progress"), item("b", "stuck", "blocked"));
  for (let i = 0; i < 7; i++) st.push(item("t" + i, "later " + i, "pending"));
  const c = T.counts(list(st));
  eq([c.total, c.done, c.inProgress, c.blocked, c.todo, c.cancelled, c.open], [15, 6, 1, 1, 7, 0, 9]);
  assert.strictEqual(T.headline(c), "6 of 15 done");
  assert.strictEqual(T.summary(c), "1 in progress · 1 blocked · 7 to do");
  const c2 = T.counts(list([item("a", "a", "completed"), item("b", "b", "cancelled"), item("c", "c", "pending")]));
  assert.strictEqual(T.summary(c2), "1 to do · 1 cancelled");
  assert.strictEqual(T.summary(T.counts(list([item("a", "a", "completed")]))), "Nothing left to do");
  assert.strictEqual(T.summary(T.counts([])), "");
}

// fold: the first few finished items show, the rest fold; work left under a finished item keeps it on show.
{
  const rows = (state, all) => { const f = T.fold(T.tree(list(state)), all); return { ids: f.rows.map((n) => n.item.id), hidden: f.hidden }; };
  const done = (id, extra) => item(id, id, "completed", extra);
  const flat = [done("a"), done("b"), done("c"), done("d"), done("e"), item("x", "x", "pending")];
  eq(rows(flat), { ids: ["a", "b", "c", "x"], hidden: 2 });
  eq(rows(flat, true), { ids: ["a", "b", "c", "d", "e", "x"], hidden: 0 });
  eq(rows([done("a"), item("x", "x", "pending")]), { ids: ["a", "x"], hidden: 0 });
  // A cancelled item folds like a done one.
  eq(rows([done("a"), done("b"), done("c"), item("k", "k", "cancelled"), item("x", "x", "pending")]), { ids: ["a", "b", "c", "x"], hidden: 1 });
  // A finished parent with an open child stays, with its finished children counted one by one.
  const nest = [done("p"), done("p1", { parent: "p" }), done("p2", { parent: "p" }), done("p3", { parent: "p" }), item("p4", "p4", "pending", { parent: "p" })];
  eq(rows(nest), { ids: ["p", "p1", "p2", "p3", "p4"], hidden: 0 });
  // A finished subtree folds whole, never leaving a child without its parent.
  const sub = [done("a"), done("b"), done("c"), done("s"), done("s1", { parent: "s" }), item("x", "x", "pending")];
  eq(rows(sub), { ids: ["a", "b", "c", "x"], hidden: 2 });
}

// stripInfo: the item in progress, how far it is; nothing for no list or a finished one.
{
  assert.strictEqual(T.stripInfo([]), null);
  assert.strictEqual(T.stripInfo(list([item("a", "a", "completed"), item("b", "b", "cancelled")])), null);
  const st = list([item("1", "Android build", "completed"), item("2", "Re:Zero title screen", "in_progress"),
    item("3", "Thor touch: confirm touch reaches the guest", "in_progress", { parent: "2", owner: "sa-1" }),
    item("4", "later", "pending")]);
  const s = T.stripInfo(st);
  eq([s.text, s.count, s.status, s.pct], ["Thor touch: confirm touch reaches the guest", "1 of 4", "in_progress", 25]);
  // Several in progress: the first in the list's order, a subtask after its parent.
  const par = list([item("1", "top", "pending"), item("2", "lane b", "in_progress", { owner: "sa-b" }), item("3", "lane a", "in_progress", { owner: "sa-a" })]);
  assert.strictEqual(T.stripInfo(par).text, "lane b");
  // None in progress: a blocked item, else the next to do.
  assert.strictEqual(T.stripInfo(list([item("1", "a", "completed"), item("2", "wait", "blocked"), item("3", "next", "pending")])).text, "wait");
  const next = T.stripInfo(list([item("1", "a", "completed"), item("2", "next", "pending")]));
  eq([next.text, next.status, next.count], ["next", "pending", "1 of 2"]);
}

// brief: a subagent's counts and current item, from subagent.list.
{
  const b = T.brief({ current: [{ id: "a", content: " Read the  store " }], counts: { total: 7, completed: 3, in_progress: 1, pending: 2, blocked: 1 }, revision: 4 });
  eq([b.counts.total, b.counts.done, b.counts.open, b.current, b.revision], [7, 3, 4, "Read the store", 4]);
  assert.strictEqual(T.brief(null), null);
  assert.strictEqual(T.brief({ counts: { total: 0 } }), null);
  assert.strictEqual(T.brief({ counts: {} }), null);
  assert.strictEqual(T.brief({ counts: { completed: 2, pending: 1 } }).counts.total, 3);
}

// ownerName: the subagent's goal from the chat's names, never its id.
{
  sandbox.window.HubPeer = { names: { sub: (id) => (id === "sa-0-aa" ? "Check the touch input" : "") },
    who(ref, names) { const g = names.sub(ref); return { name: g }; } };
  assert.strictEqual(T.ownerName("sa-0-aa"), "Check the touch input");
  assert.strictEqual(T.ownerName("sa-0-zz"), "a subagent");
  assert.strictEqual(T.ownerName(""), "");
  assert.ok(!/sa-/.test(T.ownerName("sa-0-zz")));
}
console.log("todo ok");
