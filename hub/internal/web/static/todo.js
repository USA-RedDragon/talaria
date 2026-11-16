"use strict";
// HubTodo is the agent's to-do list in the Activity panel and above the
// message box. The list is the agent's stored one (Hermes patch 0126): the
// hub reads it with GET .../todos and Hermes sends the whole list again in
// each todo.updated event. An item has an id, its text (content), a status
// (pending, in_progress, completed, cancelled or blocked), the id of the item
// it is a subtask of (parent, to any depth), a note and the subagent it is
// assigned to (owner).
// The first half is plain functions (tree, counts, fold, strip) that read
// no page; the second half draws them: plan() is the Plan section, line()
// the one-line card of a subagent's own list, strip() the line above the
// message box.
window.HubTodo = (() => {
  const statuses = ["pending", "in_progress", "completed", "cancelled", "blocked"];
  const closed = (s) => s === "completed" || s === "cancelled";
  // How many finished items stay on show before the rest fold under "Show N done".
  const keepDone = 3;
  const maxDepth = 40;
  const text = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const squash = (s) => text(s).split(/\s+/).filter(Boolean).join(" ");

  // clean reads a list as Hermes sends it (a todo_state, or its todos) into
  // items the page trusts: every item has a unique id, a known status and text.
  function clean(state) {
    const list = Array.isArray(state) ? state : state && Array.isArray(state.todos) ? state.todos : [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      let id = text(raw.id).trim() || "#" + (out.length + 1);
      if (seen.has(id)) id = id + "#" + (out.length + 1);
      seen.add(id);
      out.push({
        id,
        content: squash(raw.content) || "(no text)",
        status: statuses.includes(raw.status) ? raw.status : "pending",
        parent: text(raw.parent).trim(),
        notes: text(raw.notes).trim(),
        owner: text(raw.owner).trim(),
      });
    }
    return out;
  }

  // tree nests the items under their parents, in the order the agent keeps
  // them. An item whose parent is not in the list, or whose parents loop, is
  // a top item. Every node: { item, depth, children }.
  function tree(items) {
    const byId = new Map(items.map((it) => [it.id, { item: it, depth: 0, children: [] }]));
    const roots = [];
    const loops = (it) => {
      const seen = new Set([it.id]);
      let p = it.parent;
      while (p) {
        if (seen.has(p)) return true;
        seen.add(p);
        const n = byId.get(p);
        if (!n) return false;
        p = n.item.parent;
      }
      return false;
    };
    for (const it of items) {
      const node = byId.get(it.id);
      const up = it.parent && it.parent !== it.id && byId.has(it.parent) && !loops(it) ? byId.get(it.parent) : null;
      if (up) up.children.push(node); else roots.push(node);
    }
    const level = (nodes, d) => {
      for (const n of nodes) {
        n.depth = Math.min(d, maxDepth);
        level(n.children, d + 1);
      }
    };
    level(roots, 0);
    return roots;
  }

  // walk lists the nodes of a tree in order.
  function walk(roots) {
    const out = [];
    const go = (nodes) => { for (const n of nodes) { out.push(n); go(n.children); } };
    go(roots);
    return out;
  }

  // counts is how many items there are in each state.
  function counts(items) {
    const c = { total: items.length, done: 0, cancelled: 0, inProgress: 0, blocked: 0, todo: 0 };
    for (const it of items) {
      if (it.status === "completed") c.done++;
      else if (it.status === "cancelled") c.cancelled++;
      else if (it.status === "in_progress") c.inProgress++;
      else if (it.status === "blocked") c.blocked++;
      else c.todo++;
    }
    c.open = c.inProgress + c.blocked + c.todo;
    return c;
  }

  // headline is "6 of 15 done".
  const headline = (c) => c.done + " of " + c.total + " done";

  // summary is the line under the header: what is left, by state.
  function summary(c) {
    const parts = [];
    if (c.inProgress) parts.push(c.inProgress + " in progress");
    if (c.blocked) parts.push(c.blocked + " blocked");
    if (c.todo) parts.push(c.todo + " to do");
    if (c.cancelled) parts.push(c.cancelled + " cancelled");
    return parts.length ? parts.join(" · ") : c.total ? "Nothing left to do" : "";
  }

  // fold says which rows show: the nodes in order with their depth, and how
  // many finished items are folded. A finished item whose subtasks are all
  // finished too is part of a part of the list that can fold; the first
  // keepDone items of those stay, the rest fold, a subtree at a time. A
  // finished item with work left under it always shows. all shows every row.
  function fold(roots, all) {
    const size = new Map();
    const shut = new Map();
    const measure = (n) => {
      let sz = 1, sh = closed(n.item.status);
      for (const c of n.children) { measure(c); sz += size.get(c); sh = sh && shut.get(c); }
      size.set(n, sz);
      shut.set(n, sh);
    };
    for (const r of roots) measure(r);
    const rows = [];
    let shown = 0, hidden = 0;
    const go = (nodes) => {
      for (const n of nodes) {
        if (shut.get(n) && !all) {
          if (shown + size.get(n) <= keepDone) shown += size.get(n);
          else { hidden += size.get(n); continue; }
        }
        rows.push(n);
        go(n.children);
      }
    };
    go(roots);
    return { rows, hidden };
  }

  // current is the item that says what the agent does now: the first item
  // in progress that has no item in progress under it (the most specific
  // one; when several subagents work at once, the first in the list's order),
  // else the first blocked one, else the first one still to do. null when
  // nothing is left.
  function current(items) {
    const order = walk(link(tree(items)));
    const busy = new Set();
    for (const n of order) {
      if (n.item.status !== "in_progress") continue;
      for (let up = n.up; up; up = up.up) busy.add(up.item.id);
    }
    const all = order.map((n) => n.item);
    return all.find((i) => i.status === "in_progress" && !busy.has(i.id)) || all.find((i) => i.status === "blocked") || all.find((i) => i.status === "pending") || null;
  }

  // stripInfo is what the line above the message box says, or null when it
  // shows nothing: there is no list, or every item is done or cancelled.
  function stripInfo(items) {
    if (!items.length) return null;
    const c = counts(items);
    if (!c.open) return null;
    const cur = current(items);
    return { status: cur.status, text: cur.content, done: c.done, total: c.total, count: c.done + " of " + c.total,
      pct: Math.round((c.done / c.total) * 100), id: cur.id };
  }

  // brief reads a subagent's todo brief (subagent.list's todo) into
  // { counts, current, revision }, or null.
  function brief(b) {
    if (!b || typeof b !== "object") return null;
    const n = (k) => (b.counts && Number.isFinite(b.counts[k]) ? b.counts[k] : 0);
    const c = { total: n("total"), done: n("completed"), cancelled: n("cancelled"), inProgress: n("in_progress"), blocked: n("blocked"), todo: n("pending") };
    if (!c.total) c.total = c.done + c.cancelled + c.inProgress + c.blocked + c.todo;
    if (!c.total) return null;
    c.open = c.inProgress + c.blocked + c.todo;
    const cur = Array.isArray(b.current) && b.current[0] ? squash(b.current[0].content) : "";
    return { counts: c, current: cur, revision: Number.isFinite(b.revision) ? b.revision : 0 };
  }

  // ownerName is the name of the subagent an item is assigned to: its goal,
  // from the names the chat knows (the same ones the agent message cards
  // use). Never its id: a subagent the chat does not list reads "a subagent".
  function ownerName(id, names) {
    if (!id) return "";
    const who = window.HubPeer ? window.HubPeer.who(id, names || window.HubPeer.names) : null;
    return (who && who.name) || "a subagent";
  }

  // ---- drawing ----

  const NS = "http://www.w3.org/2000/svg";
  const iconPaths = {
    completed: ['<path d="M3.5 8.5l3 3 6-7"/>'],
    in_progress: ['<circle cx="8" cy="8" r="5.6"/>', '<path class="fill" d="M8 2.4a5.6 5.6 0 0 1 0 11.2z"/>'],
    blocked: ['<circle cx="8" cy="8" r="5.6"/>', '<path d="M8 4.8v3.9M8 11v.01"/>'],
    pending: ['<circle cx="8" cy="8" r="5.6"/>'],
    cancelled: ['<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'],
  };
  const stateWord = { completed: "Done", in_progress: "In progress", blocked: "Blocked", pending: "To do", cancelled: "Cancelled" };

  // icon is the small state icon of an item, an SVG that takes the color of its class.
  function icon(status) {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("class", "tic " + status);
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", stateWord[status] || "To do");
    const tmp = document.createElementNS(NS, "g");
    tmp.innerHTML = (iconPaths[status] || iconPaths.pending).join("");
    while (tmp.firstChild) s.append(tmp.firstChild);
    return s;
  }

  const cls = { completed: "done", in_progress: "prog", blocked: "blk", pending: "", cancelled: "cx" };

  // listNode draws rows as nested lists. o: el, names (the chat's subagent
  // names), noOwner (a subagent's own list needs no owner chips), open (a Set
  // of item ids whose note shows whole) and flip(id) to toggle one.
  function listNode(rows, o) {
    const root = o.el("ul", "tl");
    const lists = new Map();
    const shown = new Set(rows.map((n) => n.item.id));
    for (const n of rows) {
      const it = n.item;
      const li = o.el("li", "ti " + cls[it.status]);
      li.dataset.todo = it.id;
      const line = o.el("div", "tl-line");
      line.append(icon(it.status), o.el("span", "tt", it.content));
      if (it.owner && !o.noOwner) {
        const name = ownerName(it.owner, o.names);
        const chip = o.el("span", "own", name);
        chip.title = "Assigned to " + name;
        line.append(chip);
      }
      li.append(line);
      if (it.notes) {
        const open = o.open.has(it.id);
        const note = o.el("div", "tn" + (open ? " open" : ""), it.notes);
        note.tabIndex = 0;
        note.setAttribute("role", "button");
        note.setAttribute("aria-expanded", String(open));
        note.title = open ? "Show one line" : "Show the whole note";
        note.onclick = () => o.flip(it.id);
        note.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.flip(it.id); } };
        li.append(note);
      }
      const up = n.up && shown.has(n.up.item.id) ? lists.get(n.up.item.id) : null;
      if (up) {
        li.classList.add("sub");
        up.append(li);
      } else {
        root.append(li);
      }
      const kids = o.el("ul", "tl sub");
      lists.set(it.id, kids);
      li.append(kids);
    }
    for (const ul of root.querySelectorAll("ul.sub")) if (!ul.children.length) ul.remove();
    return root;
  }

  // link gives every node of roots its parent node.
  function link(roots) {
    const go = (nodes, up) => { for (const n of nodes) { n.up = up; go(n.children, n); } };
    go(roots, null);
    return roots;
  }

  // plan draws the Plan section: header with the count, a line of what is
  // left, the tree and, below it, "Show N done". o is listNode's, with all
  // (finished items shown) and flipAll().
  function plan(items, o) {
    const roots = link(tree(items));
    const c = counts(items);
    const f = fold(roots, o.all);
    const box = o.el("section", "plan");
    box.id = "plan";
    box.setAttribute("aria-label", "Plan");
    const head = o.el("div", "plan-head");
    head.append(o.el("span", "", "Plan"), o.el("span", "plan-count", headline(c)));
    box.append(head);
    const sum = summary(c);
    if (sum) box.append(o.el("div", "plan-sum", sum));
    box.append(listNode(f.rows, o));
    if (f.hidden || o.all) {
      const closedN = items.filter((i) => closed(i.status)).length;
      if (f.hidden || closedN > keepDone) {
        const b = o.el("button", "plan-fold", o.all ? "Hide done" : "Show " + f.hidden + " done");
        b.type = "button";
        b.onclick = () => o.flipAll();
        box.append(b);
      }
    }
    return box;
  }

  // line draws a subagent's own list collapsed: its counts and current item
  // on one line, a button that opens the whole tree below it. b is the
  // subagent's todo brief, items its list when it was read (else null).
  function line(b, o) {
    const box = o.el("div", "subplan" + (o.expanded ? " open" : ""));
    const btn = o.el("button", "sp-line");
    btn.type = "button";
    btn.setAttribute("aria-expanded", String(o.expanded));
    btn.title = o.expanded ? "Hide this subagent's list" : "Show this subagent's list";
    const status = b.counts.inProgress ? "in_progress" : b.counts.blocked ? "blocked" : b.counts.open ? "pending" : "completed";
    const cur = b.current || (b.counts.open ? "" : "All done");
    btn.append(icon(status), o.el("span", "sp-cur", cur || b.counts.done + " of " + b.counts.total + " done"),
      o.el("span", "sp-cnt", b.counts.done + " of " + b.counts.total));
    const chev = window.HubIcons.icon("chev");
    chev.classList.add("chev");
    btn.append(chev);
    btn.onclick = (e) => { e.stopPropagation(); o.toggle(); };
    btn.onkeydown = (e) => e.stopPropagation();
    box.append(btn);
    if (o.expanded) {
      const body = o.el("div", "sp-body");
      if (o.items && o.items.length) body.append(listNode(fold(link(tree(o.items)), true).rows, Object.assign({}, o, { noOwner: true })));
      else body.append(o.el("div", "sp-wait", "Reading the list…"));
      box.append(body);
    }
    return box;
  }

  return { clean, tree, walk, counts, headline, summary, fold, current, stripInfo, brief, ownerName, plan, line, icon, listNode, link, keepDone, closed };
})();
