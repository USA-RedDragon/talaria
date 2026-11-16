"use strict";
// HubMiniChat shows the steps of one subagent as a small chat inside its
// Activity row: its text as reply bubbles, its thinking folded, its tool
// calls as the chat's tool cards (toolcard.js) folded into the chat's groups
// (toolgroup.js), the messages the user sent it as small bubbles that say
// whether it read them, and a Done or Failed card at the end. Steps come
// from GET .../subagents/{id}/events (typed events with seq). It follows the
// newest step while the reader is at the bottom; scrolled up, it stays put
// and a pill counts the new steps.
// The pure parts (order, steerState, steps, near, pill, end) are run by a
// node test. create(ctx) builds a view; ctx: el, toast(text),
// highlight(code), diff(text), page(page) (the card of a published page),
// full (no height cap).
window.HubMiniChat = (() => {
  const nearPx = 48;
  const noteLen = 160;
  const endLen = 600;

  // ms reads a step's time. A step Hermes gave no time has none (0): the
  // hub sends year 1 for it.
  const ms = (ts) => {
    const v = typeof ts === "number" ? ts : Date.parse(ts) || 0;
    return v > 0 ? v : 0;
  };
  const cut = (s, n) => {
    const r = Array.from(String(s || "").trim());
    return r.length <= n ? r.join("") : r.slice(0, n).join("").trim() + "…";
  };

  // near says whether a box is scrolled to (about) its end.
  const near = (m) => m.scrollHeight - m.scrollTop - m.clientHeight < nearPx;
  const pill = (n) => n + (n === 1 ? " new step" : " new steps");

  // order sorts events for drawing from scratch: by time, then seq. A step
  // with no time of its own takes the time of the step before it, so it stays
  // in its place.
  function order(events) {
    const rows = events.map((e) => ({ e })).sort((a, b) => a.e.seq - b.e.seq);
    let last = 0;
    for (const r of rows) {
      const t = ms(r.e.ts);
      if (t) last = t;
      r.t = t || last;
    }
    return rows.sort((a, b) => a.t - b.t || a.e.seq - b.e.seq).map((r) => r.e);
  }

  // steerState says what became of a message to the subagent. Hermes hands
  // it over with the subagent's next tool result, so a result after it means
  // the subagent read it: "read". Without one it "waits", or was "missed"
  // when the subagent ended first.
  function steerState(steer, events, ended) {
    const at = ms(steer.ts);
    if (events.some((e) => e.type === "tool_end" && (ms(e.ts) ? ms(e.ts) >= at : e.seq > steer.seq))) return "read";
    return ended ? "missed" : "waits";
  }

  const steerWords = { read: "read by the subagent", waits: "waits for its next step", missed: "the subagent ended before reading it" };

  // steps counts the events that add something to read, for the pill: a
  // result adds nothing new when its call is already shown.
  function steps(events, shownCalls) {
    let n = 0;
    const seen = new Set(shownCalls || []);
    for (const e of events) {
      if (e.type === "tool_start") seen.add(e.call_id);
      if (e.type === "tool_end" && e.call_id && seen.has(e.call_id)) continue;
      if (e.type === "tool_end" && e.call_id) seen.add(e.call_id);
      n++;
    }
    return n;
  }

  // end is the closing card of a subagent that ended: state ("ok", "bad",
  // "stopped"), how long it ran, its result and tokens.
  function end(r) {
    const T = window.HubTimes;
    const took = r.durationS > 0 ? T.span(r.durationS) : "";
    const head = r.state === "ok" ? "Done" + (took ? " in " + took : "")
      : r.state === "stopped" ? "Stopped" + (took ? " after " + took : "")
        : "Failed" + (took ? " after " + took : "");
    const lines = [];
    if (r.result) lines.push(cut(r.result, endLen));
    if (r.tokens) lines.push(r.tokens);
    return { head, body: lines.filter(Boolean).join("\n"), bad: r.state !== "ok" };
  }

  // steerRow reads a stored user row that is a steer (wrapped in the steer
  // marker): { from, lines } with the sender's label when it names one (a
  // message from another agent), else the user's lines; null for any other row.
  function steerRow(text) {
    const o = window.HubOrigin;
    if (!o) return null;
    const inner = o.unwrapSteer(text);
    if (inner === text) return null;
    const c = o.classify({ text, display_kind: "steer" });
    if (c.show === "card" && c.notice) return { from: c.notice.title, lines: [c.notice.result] };
    return { from: "", lines: String(inner).split("\n").map((l) => l.trim()) };
  }

  // briefLines is how many lines of the brief show before "Show all".
  const briefLines = 6;
  const briefChars = 360;

  // briefLong tells whether a brief needs the fold: more than briefLines
  // lines, or enough text to wrap past them on a narrow screen.
  const briefLong = (t) => t.split("\n").length > briefLines || t.length > briefChars;

  function create(ctx) {
    const { el } = ctx;
    const T = window.HubTimes;
    const box = el("div", "mc" + (ctx.full ? " full" : ""));
    box.setAttribute("role", "log");
    box.setAttribute("aria-label", "Subagent steps");
    box.tabIndex = 0;
    const jump = el("button", "jump");
    jump.type = "button";
    jump.hidden = true;
    jump.append(window.HubIcons.icon("chev"), el("span"));
    box.append(jump);
    const st = { events: [], calls: new Map(), steers: [], rows: [], unseen: 0, ended: false, info: {}, endNode: null, known: null, started: null };
    // memory is what the steps taught so far: a background command by its
    // session id, for naming it in the row's status line.
    const view = { node: box, events: () => st.events.slice(), memory: () => st.known };

    const put = (node) => box.insertBefore(node, jump);
    const stamp = (at) => T.stamp(el("span", "ts"), ms(at));

    function showJump() {
      jump.hidden = st.unseen === 0;
      jump.lastChild.textContent = pill(st.unseen);
    }
    function toEnd() {
      box.scrollTop = box.scrollHeight;
      st.unseen = 0;
      showJump();
    }
    jump.onclick = toEnd;
    box.addEventListener("scroll", () => {
      if (st.unseen && near(box)) {
        st.unseen = 0;
        showJump();
      }
    });

    // card draws one tool card. o.key names it when it is one of the calls
    // a tool_call carries, which all share the wrapper's call id; o.batch
    // is that id, so the fold knows these calls ran together.
    function card(e, o) {
      o = o || {};
      if (!st.known) st.known = window.HubToolCard.memory();
      const call = { name: e.name || "tool", args: e.args || null, res: null, out: "", done: false, failed: false,
        startedAt: ms(e.ts), endedAt: 0, duration: undefined, mem: st.known, batch: o.batch || "" };
      const v = window.HubToolCard.create({ el, toast: ctx.toast || (() => {}), highlight: ctx.highlight, diff: ctx.diff || ((t) => el("pre", "", t)), page: ctx.page }, call);
      const node = v.node;
      node.view = v;
      node.call = call;
      node.toolName = call.name;
      node.classList.toggle("quiet", window.HubToolCard.quiet(call.name, false));
      node.dataset.ukey = "t:" + (o.key || e.call_id || "s" + e.seq);
      node.batch = o.batch || "";
      node.classList.add("running");
      const c = { node, call };
      if (e.call_id && !o.key) st.calls.set(e.call_id, c);
      put(node);
      return c;
    }

    function finish(c, e) {
      const { node, call } = c;
      const { res, failed, out } = window.HubToolCard.outcome(call.name, { result: e.result, is_error: e.error });
      if (!call.args && e.args) call.args = e.args;
      call.done = true;
      call.res = res;
      call.failed = failed;
      call.out = out + (e.result_size > (e.result || "").length ? "\n… (" + e.result_size + " characters in all)" : "");
      call.endedAt = ms(e.ts);
      // No time is shown when it is not known or 0.
      let sec;
      if (typeof e.duration_ms === "number" && e.duration_ms > 0) sec = e.duration_ms / 1000;
      else if (!(typeof e.duration_ms === "number") && call.startedAt && call.endedAt > call.startedAt) sec = (call.endedAt - call.startedAt) / 1000;
      call.duration = sec;
      node.duration = sec;
      node.failed = failed;
      node.finished = true;
      node.classList.remove("running");
      node.classList.toggle("failed", failed);
      node.classList.toggle("quiet", window.HubToolCard.quiet(call.name, failed));
      st.known.learn(call.name, call.args, res);
      node.view.update(call);
    }

    // open draws the calls a tool_call carries as the cards of the tools
    // inside it, so they fold with their neighbors like any other. Hermes
    // saves one result per inner call under the wrapper's call id; each
    // result goes to the next call of its tool that has none yet.
    function open(e, list) {
      const w = { inner: [], batch: e.call_id || "s" + e.seq };
      for (const x of window.HubToolCard.calls(w.batch, e.name, e.args)) {
        w.inner.push({ name: x.name, c: card({ ...e, name: x.name, args: x.args || null }, { key: x.key, batch: x.batch }), done: false });
      }
      if (e.call_id) st.calls.set(e.call_id, { wrapper: w });
      return w;
    }

    function close(w, e) {
      const free = w.inner.filter((x) => !x.done);
      const hit = free.find((x) => x.name === e.name) || (!e.name || e.name === "tool_call" ? free[0] : null);
      if (!hit) return;
      hit.done = true;
      finish(hit.c, { ...e, name: hit.name });
    }

    // brief is one of the subagent's first entries, the task it was given
    // ("Task") or the context that came with it ("Context"), in full as
    // plain text (line breaks kept, selectable), folded after briefLines
    // lines with Show all / Show less.
    function brief(text, head) {
      const box = el("div", "mc-brief");
      const body = el("div", "mc-brief-text", String(text).trim());
      box.append(el("div", "mc-brief-head", head || "Task"), body);
      if (briefLong(body.textContent)) {
        body.classList.add("clamped");
        const b = el("button", "mc-brief-more", "Show all");
        b.type = "button";
        b.setAttribute("aria-expanded", "false");
        b.setAttribute("aria-label", (head || "Task") + ": show all");
        b.onclick = () => {
          const open = body.classList.toggle("clamped") === false;
          b.textContent = open ? "Show less" : "Show all";
          b.setAttribute("aria-expanded", String(open));
          b.setAttribute("aria-label", (head || "Task") + ": " + (open ? "show less" : "show all"));
        };
        box.append(b);
      }
      return box;
    }

    function steer(e) {
      const b = el("div", "msg user sm");
      b.textContent = e.text || "";
      const line = el("div", "queued");
      put(b);
      put(line);
      st.steers.push({ e, b, line });
    }

    // settle decides what each stored steer row shows. Hermes stores a
    // steer as its own user row in the steer marker; the message the user
    // sent through this page is already drawn as a bubble, so the row's
    // lines that a bubble has are dropped, once per bubble. What is left came
    // from elsewhere and shows once, labeled.
    function settle() {
      const free = st.steers.map((s) => ({ text: String(s.e.text || "").trim(), used: false }));
      for (const r of st.rows) {
        let body = "\n" + r.lines.join("\n") + "\n";
        if (!r.from) {
          for (const f of free) {
            if (f.used || !f.text) continue;
            const at = body.indexOf("\n" + f.text + "\n");
            if (at < 0) continue;
            f.used = true;
            body = body.slice(0, at) + body.slice(at + f.text.length + 1);
          }
        }
        const left = r.from ? r.lines.join("\n") : body.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
        r.node.hidden = !left;
        r.node.replaceChildren(...(left ? [r.from ? r.from + ": " + cut(left, noteLen) : "Message from elsewhere: " + cut(left, noteLen)] : []));
      }
    }

    function drawSteers() {
      for (const s of st.steers) {
        const state = steerState(s.e, st.events, st.ended);
        s.b.classList.toggle("pending", state === "waits");
        s.line.replaceChildren(stamp(s.e.ts), " · " + steerWords[state]);
      }
    }

    function one(e) {
      switch (e.type) {
        case "goal": {
          if (e.text) put(brief(e.text));
          const n = el("div", "note");
          n.append("Started ", stamp(e.ts));
          if (st.info.model) n.append(" · " + st.info.model);
          st.started = n;
          put(n);
          break;
        }
        case "context": {
          // The context belongs under the task, before the start note.
          if (!String(e.text || "").trim()) break;
          const c = brief(e.text, "Context");
          if (st.started && st.started.parentNode === box) box.insertBefore(c, st.started);
          else put(c);
          break;
        }
        case "user": {
          const r = steerRow(e.text);
          if (!r) {
            put(el("div", "note", cut(e.text, noteLen)));
            break;
          }
          const n = el("div", "note steerrow");
          put(n);
          st.rows.push({ e, node: n, from: r.from, lines: r.lines });
          break;
        }
        case "compaction":
          put(el("div", "note", "Earlier steps were summarized to make room."));
          break;
        case "thinking": {
          const d = el("details", "reasoning");
          const s = el("summary", "", "Thinking ");
          s.append(stamp(e.ts));
          d.append(s, el("div", "body", e.text || ""));
          put(d);
          break;
        }
        case "message": {
          const m = el("div", "msg assistant md");
          const body = el("div", "mc-text");
          if (window.HubMarkdown) window.HubMarkdown.render(body, e.text || "");
          else body.textContent = e.text || "";
          m.append(body, stamp(e.ts));
          put(m);
          break;
        }
        case "tool_start": {
          if (st.calls.has(e.call_id)) break;
          const list = window.HubToolCard.wrapped(e.name, e.args);
          if (list && list.length) open(e, list);
          else card(e);
          break;
        }
        case "tool_end": {
          let c = e.call_id && st.calls.get(e.call_id);
          if (!c) {
            // A result whose call this view never saw: a wrapper's result still draws its inner tool.
            const list = window.HubToolCard.wrapped(e.name, e.args);
            if (list && list.length) c = { wrapper: open(e, list) };
          }
          if (c && c.wrapper) close(c.wrapper, e);
          else finish(c || card(e), e);
          break;
        }
        case "steer":
          steer(e);
          break;
      }
    }

    // fold folds the finished calls into the chat's groups; while the
    // subagent runs, the newest calls stay open as cards, as in a chat's
    // running turn.
    function fold() {
      let keep = null;
      if (!st.ended) {
        for (let n = jump.previousElementSibling; n && n.classList.contains("tool"); n = n.previousElementSibling) keep = n;
      }
      window.HubToolGroup.fold(el, box, keep, (c) => c.view && c.querySelector(".notice-head[aria-expanded=\"true\"]"), true);
    }

    function drawEnd() {
      if (st.endNode) st.endNode.remove();
      st.endNode = null;
      if (!st.ended || !st.info.end) return;
      const r = end(st.info.end);
      const n = el("div", "mc-end" + (r.bad ? " bad" : ""));
      const text = el("div");
      text.append(el("b", "", r.head));
      if (r.body) text.append(el("p", "", r.body));
      if (st.info.end.endedAt) text.append(stamp(st.info.end.endedAt));
      n.append(window.HubIcons.icon(r.bad ? "alert" : "checkcircle"), text);
      st.endNode = n;
      put(n);
    }

    // add draws new events (in seq order) and follows them when the reader
    // is at the end.
    view.add = (events) => {
      if (!events.length) return;
      const follow = near(box) || !st.events.length;
      const shown = [...st.calls.keys()];
      // A batch can hold a message the user sent and older steps the hub
      // read after it: draw it in time order.
      for (const e of order(events)) {
        st.events.push(e);
        one(e);
      }
      if (st.endNode) put(st.endNode);
      fold();
      settle();
      drawSteers();
      if (follow) toEnd();
      else {
        st.unseen += steps(events, shown);
        showJump();
      }
    };

    // reset drops everything drawn, for a transcript Hermes rewrote.
    view.reset = () => {
      for (const n of Array.from(box.children)) if (n !== jump) n.remove();
      Object.assign(st, { events: [], calls: new Map(), steers: [], rows: [], unseen: 0, endNode: null, known: null, started: null });
      showJump();
    };

    // set takes what the row knows: model, and end ({ state, durationS,
    // result, tokens, endedAt }) once the subagent ended.
    view.set = (info) => {
      const ended = !!(info && info.end);
      const changed = ended !== st.ended || JSON.stringify(info.end || null) !== JSON.stringify(st.info.end || null);
      st.info = info || {};
      st.ended = ended;
      if (!changed) return;
      const follow = near(box);
      drawEnd();
      fold();
      drawSteers();
      if (follow) toEnd();
    };

    view.empty = (text) => {
      if (st.events.length || box.querySelector(".mc-empty")) return;
      put(el("div", "note mc-empty", text));
    };
    view.clearEmpty = () => {
      const n = box.querySelector(".mc-empty");
      if (n) n.remove();
    };
    return view;
  }

  return { near, pill, order, steerState, steps, end, create };
})();
