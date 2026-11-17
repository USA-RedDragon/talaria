"use strict";
// HubMiniChat shows the steps of one subagent in its Activity row with the
// chat's own view (chatview.js): the same bubbles, notice cards, thinking
// blocks, tool cards and tool groups as the chat, drawn by the same code,
// and the same jump to the latest message. Only the container differs: a
// log the height of the row (or of the steps dialog, full), no composer,
// the task the subagent was given at its top and a Done or Failed card at
// its end. The messages the user sent the subagent through the page show as
// the chat's pending bubbles, with whether it read them.
//
// Steps come from GET .../subagents/{id}/events (typed events with seq);
// each is drawn as the chat draws the same row or event: a stored user row
// or a reply or thinking as a stored row (ChatView.row), a call and its
// result as the live tool events. The pure parts (order, steerState, end,
// near) are run by a node test. create(ctx) builds a view; ctx: el, chat
// ({ env, base, backend, session, cards }: the view of the chat the
// subagent belongs to), full (no height cap).
window.HubMiniChat = (() => {
  const nearPx = 48;
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

  // briefLines is how many lines of the brief show before "Show all".
  const briefLines = 6;
  const briefChars = 360;

  // briefLong tells whether a brief needs the fold: more than briefLines
  // lines, or enough text to wrap past them on a narrow screen.
  const briefLong = (t) => t.split("\n").length > briefLines || t.length > briefChars;

  // steerLines are the lines of a stored user row that is a steer (the
  // steer marker around the user's words), or null for any other row.
  function steerLines(text) {
    const o = window.HubOrigin;
    const inner = o ? o.unwrapSteer(text) : text;
    if (inner === text) return null;
    return String(inner).split("\n").map((l) => l.trim());
  }

  function create(ctx) {
    const { el } = ctx;
    const T = window.HubTimes;
    const chat = ctx.chat || {};
    const env = chat.env;
    const box = el("div", "mc" + (ctx.full ? " full" : ""));
    const log = el("div", "log mc-log");
    log.setAttribute("role", "log");
    log.setAttribute("aria-label", "Subagent steps");
    log.tabIndex = 0;
    const jump = window.HubChatView.jumpButton(el, env.t);
    box.append(log, jump.hold);
    const ui = window.HubUIState(log);
    const scroll = window.HubChatView.scroller(log, jump.button, { ui, t: env.t });
    // The cards get the context of the chat's own cards in Activity
    // (Chat.subCtx); without a chat, the plain one.
    const cards = chat.cards || { el, toast: env.toast, diff: (t) => el("pre", "", t) };
    const v = new window.HubChatView.ChatView(log, env, { ui, scroll, base: chat.base, cards: () => cards });
    v.backend = chat.backend;
    v.session = chat.session;
    v.reset();
    const st = { events: [], steers: [], rows: [], ended: false, info: {}, endNode: null, started: null };
    const view = { node: box, log, events: () => st.events.slice(), memory: () => v.known || null, pinned: () => scroll.pinned(), chat: v };
    const stamp = (at) => T.stamp(el("span", "ts"), ms(at));

    // brief is one of the subagent's first entries, the task it was given
    // ("Task") or the context that came with it ("Context"), in full as
    // plain text (line breaks kept, selectable), folded after briefLines
    // lines with Show all / Show less.
    function brief(text, head) {
      const b = el("div", "mc-brief");
      const body = el("div", "mc-brief-text", String(text).trim());
      b.append(el("div", "mc-brief-head", head || "Task"), body);
      if (briefLong(body.textContent)) {
        body.classList.add("clamped");
        const more = el("button", "mc-brief-more", "Show all");
        more.type = "button";
        more.setAttribute("aria-expanded", "false");
        more.setAttribute("aria-label", (head || "Task") + ": show all");
        more.onclick = () => {
          const open = body.classList.toggle("clamped") === false;
          more.textContent = open ? "Show less" : "Show all";
          more.setAttribute("aria-expanded", String(open));
          more.setAttribute("aria-label", (head || "Task") + ": " + (open ? "show less" : "show all"));
        };
        b.append(more);
      }
      return b;
    }

    // steer draws a message the user sent through this page as the chat
    // draws one it sent to a running turn: a pending bubble with a line
    // under it (drawSteers says whether the subagent read it). A stored
    // row that already showed it gives way.
    function steer(e) {
      const text = String(e.text || "").trim();
      const row = st.rows.find((r) => !r.used && r.text === text);
      if (row) {
        row.used = true;
        for (const n of row.nodes) n.remove();
      }
      const bubble = v.userText(e.text || "", true);
      const p = v.pending.find((x) => x.bubble === bubble);
      st.steers.push({ e, p, text, used: !!row });
    }

    function drawSteers() {
      for (const s of st.steers) {
        if (!s.p) continue;
        const state = steerState(s.e, st.events, st.ended);
        s.p.bubble.classList.toggle("pending", state === "waits");
        const line = el("div", "queued");
        line.append(stamp(s.e.ts), " · " + steerWords[state]);
        v.label(s.p, line);
      }
    }

    // user draws a stored user row as the chat draws it. A steer row whose
    // lines the page already shows as its own bubbles keeps only the rest.
    function user(e) {
      let text = e.text || "";
      const lines = steerLines(text);
      if (lines) {
        let body = "\n" + lines.join("\n") + "\n";
        for (const s of st.steers) {
          if (s.used || !s.text) continue;
          const at = body.indexOf("\n" + s.text + "\n");
          if (at < 0) continue;
          s.used = true;
          body = body.slice(0, at) + body.slice(at + s.text.length + 1);
        }
        const left = body.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
        if (!left) return;
        if (left !== lines.filter(Boolean).join("\n")) text = left;
      }
      const before = log.lastElementChild;
      v.row({ role: "user", text, display_kind: lines && text !== e.text ? "steer" : e.display_kind, timestamp: ms(e.ts) / 1000 });
      const nodes = [];
      for (let n = before ? before.nextElementSibling : log.firstElementChild; n; n = n.nextElementSibling) nodes.push(n);
      if (lines) st.rows.push({ text: lines.filter(Boolean).join("\n"), nodes, used: false });
    }

    const callID = (e) => e.call_id || "s" + e.seq;

    function one(e) {
      const at = ms(e.ts);
      switch (e.type) {
        case "goal": {
          if (e.text) v.add(brief(e.text));
          const n = el("div", "note");
          n.append("Started");
          if (st.info.model) n.append(" · " + st.info.model);
          st.started = n;
          v.add(n);
          break;
        }
        case "context": {
          // The context belongs under the task, before the start note.
          if (!String(e.text || "").trim()) break;
          const c = brief(e.text, "Context");
          if (st.started && st.started.parentNode === log) log.insertBefore(c, st.started);
          else v.add(c);
          break;
        }
        case "user": user(e); break;
        case "compaction": v.compacted(); break;
        case "thinking": v.row({ role: "assistant", reasoning: e.text || "", timestamp: at / 1000 }); break;
        case "message": v.row({ role: "assistant", text: e.text || "", timestamp: at / 1000 }); break;
        case "tool_start":
          v.at = at;
          v.draw("tool.start", { tool_id: callID(e), name: e.name, args: e.args || null });
          break;
        case "tool_end":
          v.at = at;
          // Hermes keeps one result row for each call a tool_call carries.
          v.draw("tool.complete", { tool_id: callID(e), name: e.name, args: e.args || null, result: e.result, is_error: !!e.error, one: true,
            duration_s: typeof e.duration_ms === "number" ? e.duration_ms / 1000 : undefined, size: typeof e.result_size === "number" ? e.result_size : undefined });
          break;
        case "steer": steer(e); break;
      }
      v.at = 0;
    }

    // fold folds the finished calls into the chat's groups, as the chat
    // does at the end of a turn; while the subagent runs, its newest calls
    // stay cards, as in a chat's running turn.
    function fold() {
      let keep = null;
      if (!st.ended) {
        for (let n = v.lastNode(); n && n.classList.contains("tool"); n = n.previousElementSibling) keep = n;
      }
      v.groupTools(keep);
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
      n.append(window.HubIcons.icon(r.bad ? "alert" : "checkcircle"), text);
      st.endNode = n;
      v.add(n);
    }

    // add draws new events. A batch can hold a message the user sent and
    // older steps the hub read after it: they are drawn in time order.
    view.add = (events) => {
      if (!events.length) return;
      if (st.endNode) st.endNode.remove();
      for (const e of order(events)) {
        st.events.push(e);
        one(e);
      }
      if (st.endNode) log.append(st.endNode);
      fold();
      drawSteers();
    };

    // reset drops everything drawn, for a transcript Hermes rewrote.
    view.reset = () => {
      v.reset();
      v.known = null;
      v.answers = null;
      Object.assign(st, { events: [], steers: [], rows: [], endNode: null, started: null });
      drawEnd();
    };

    // set takes what the row knows: model, and end ({ state, durationS,
    // result, tokens, endedAt }) once the subagent ended.
    view.set = (info) => {
      const ended = !!(info && info.end);
      const changed = ended !== st.ended || JSON.stringify(info.end || null) !== JSON.stringify(st.info.end || null);
      st.info = info || {};
      st.ended = ended;
      if (!changed) return;
      drawEnd();
      fold();
      drawSteers();
    };

    // dispose is for a view that is gone (the steps dialog closed).
    view.dispose = () => scroll.dispose();

    view.empty = (text) => {
      if (st.events.length || log.querySelector(".mc-empty")) return;
      log.append(el("div", "note mc-empty", text));
    };
    view.clearEmpty = () => {
      const n = log.querySelector(".mc-empty");
      if (n) n.remove();
    };
    return view;
  }

  return { near, order, steerState, end, create };
})();
