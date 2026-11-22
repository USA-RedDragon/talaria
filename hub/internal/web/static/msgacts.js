"use strict";
// HubMsgActions adds the actions of each message in the open chat: Copy and
// Branch on every message, Rewind to here on each message of the user,
// Edit on the user's last message and Retry on the last reply. Edit and
// Retry go through the hub's rewind, which drops the user's last turn and
// sends it again; Rewind to here drops a chosen message and what follows,
// sends nothing and puts the message in the box; Branch starts a new chat
// from a message. Where a rewind hid messages the log shows a line with
// their count and a Show button that lists them. It also exports a chat as
// Markdown.
// ctx: api, el, chat(), running(), stop(), reopen(chat), toast(text),
// banner(text, bad), open(backend, session), stays() (what keeps running
// beside the chat: { subagents, commands, prompts, todos }).
window.HubMsgActions = (ctx) => {
  const { api, el } = ctx;
  const $ = (id) => document.getElementById(id);
  const I = window.HubIcons;
  const log = $("log");
  const coarse = () => matchMedia("(pointer: coarse)").matches;
  const agentHead = /^\[Agent message am_[0-9a-f]{16} from [^\]\n]{1,400}\]\n/;

  const bubbles = () => Array.from(log.querySelectorAll(":scope > .msg.user:not(.pending):not(.failed), :scope > .msg.assistant.md, " +
    ":scope > .older > .part > .msg.user, :scope > .older > .part > .msg.assistant.md"));
  const isUser = (b) => b.classList.contains("user");
  const textOf = (b) => (typeof b.raw === "string" ? b.raw : b.rawText != null ? b.rawText : b.textContent);

  let editing = null;
  let retrying = null;

  function decorate() {
    if (!ctx.chat()) return;
    const all = bubbles();
    const users = all.filter(isUser);
    const lastUser = users[users.length - 1];
    const last = all[all.length - 1];
    const lastReply = last && !isUser(last) ? last : null;
    const run = ctx.running();
    for (const b of all) {
      if (b === editing) continue;
      const state = (b === lastUser ? "u" : "") + (b === lastReply && !run ? "r" : "");
      let acts = b.nextElementSibling;
      while (acts && (acts.classList.contains("queued") || acts.classList.contains("lost"))) acts = acts.nextElementSibling;
      if (!acts || !acts.classList.contains("acts") || acts.owner !== b) {
        acts = el("div", "acts" + (isUser(b) ? " mine" : ""));
        acts.owner = b;
        acts.dataset.state = "-";
        b.after(acts);
      }
      if (acts.dataset.state === state) continue;
      acts.dataset.state = state;
      acts.replaceChildren();
      const add = (name, label, fn) => {
        const x = I.button(name, label, "");
        x.hubAct = fn;
        acts.append(x);
      };
      add("copy", "Copy", () => copy(textOf(b)));
      if (state.includes("u")) add("edit", "Edit and resend (↑)", () => edit(b));
      if (state.includes("r")) add("retry", "Run the last message again", () => retry(b));
      add("branch", "Start a new chat from here", (x) => branch(b, x));
      if (isUser(b)) add("rewind", "Rewind to here", () => rewindTo(b));
    }
    const shown = new Set(all);
    for (const a of log.querySelectorAll(":scope > .acts, :scope > .older > .part > .acts")) if (!a.owner || !a.owner.isConnected || !shown.has(a.owner)) { if (a.owner !== editing) a.remove(); }
    placeRewound();
  }

  // One listener on the log serves every message: a tap on a bubble shows
  // its actions (on a touch screen), a tap on an action runs it.
  log.addEventListener("click", (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const act = t.closest(".acts > button");
    if (act && act.hubAct) {
      e.stopPropagation();
      act.hubAct(act);
      return;
    }
    const b = t.closest(".msg");
    if (!b || !coarse() || t.closest("a, button, details, summary, pre, img")) return;
    let acts = b.nextElementSibling;
    while (acts && (acts.classList.contains("queued") || acts.classList.contains("lost"))) acts = acts.nextElementSibling;
    if (!acts || !acts.classList.contains("acts") || acts.owner !== b) return;
    for (const x of log.querySelectorAll(".acts.show")) if (x !== acts) x.classList.remove("show");
    acts.classList.toggle("show");
  });

  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; decorate(); });
  };
  // Only a change of the messages themselves needs a pass: a tool card, a
  // status line or the actions this very code adds do not, and a streamed
  // reply adds none of its own after the first.
  const mine = (n) => n.nodeType !== 1 || n.classList.contains("acts") || n.classList.contains("rewound") || !(n.classList.contains("msg") || n.classList.contains("older") || n.classList.contains("part") || n.classList.contains("queued") || n.classList.contains("lost"));
  new MutationObserver((list) => {
    for (const m of list) {
      for (const n of m.addedNodes) if (!mine(n)) { soon(); return; }
      for (const n of m.removedNodes) if (!mine(n) || (n.nodeType === 1 && n.classList.contains("acts"))) { soon(); return; }
    }
  }).observe(log, { childList: true });

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast("Copied");
    } catch (_) {
      ctx.toast("Could not copy: the browser did not allow it", { bad: true });
    }
  }

  // editLast opens the editor on the user's last message; false when
  // there is none.
  function editLast() {
    const users = bubbles().filter(isUser);
    const b = users[users.length - 1];
    if (!b || editing) return false;
    edit(b);
    return true;
  }

  function closeEdit() {
    if (!editing) return;
    const b = editing;
    editing = null;
    b.hidden = false;
    if (b.editBox) b.editBox.remove();
    b.editBox = null;
    soon();
  }

  function edit(b) {
    closeEdit();
    closeRetry();
    editing = b;
    const box = el("div", "editbox");
    const ta = el("textarea");
    ta.value = textOf(b);
    ta.setAttribute("aria-label", "Edit your message");
    const row = el("div", "row");
    row.append(el("span", "note", "Replaces this message and everything after it"));
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const go = el("button", "primary", "Resend");
    go.type = "button";
    cancel.onclick = () => closeEdit();
    go.onclick = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      go.disabled = cancel.disabled = true;
      if (await rewind({ text })) closeEdit();
      else go.disabled = cancel.disabled = false;
    };
    ta.onkeydown = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEdit(); $("input").focus(); }
      if (e.key === "Enter" && !e.shiftKey && !coarse()) { e.preventDefault(); go.click(); }
    };
    row.append(cancel, go);
    box.append(ta, row);
    b.hidden = true;
    const acts = b.nextElementSibling && b.nextElementSibling.classList.contains("acts") ? b.nextElementSibling : null;
    if (acts) acts.remove();
    b.after(box);
    b.editBox = box;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function closeRetry() {
    if (retrying) retrying.remove();
    retrying = null;
  }

  async function retry(b) {
    closeEdit();
    if (retrying) { closeRetry(); return; }
    const chat = ctx.chat();
    const box = el("div", "editbox retrybox");
    const row = el("div", "row");
    row.append(el("span", "note", "Run your last message again on:"));
    const sel = el("select");
    sel.setAttribute("aria-label", "Model for the retry");
    const cur = (chat.info && chat.info.model) || "";
    const o = el("option", "", cur || "The current model");
    o.value = "";
    sel.append(o);
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    cancel.onclick = closeRetry;
    const go = el("button", "primary", "Retry");
    go.type = "button";
    go.onclick = async () => {
      const [provider, model] = sel.value ? sel.value.split("\n") : ["", ""];
      go.disabled = cancel.disabled = true;
      if (await rewind({ retry: true, provider, model })) closeRetry();
      else go.disabled = cancel.disabled = false;
    };
    row.append(sel, cancel, go);
    box.append(row);
    const acts = b.nextElementSibling && b.nextElementSibling.classList.contains("acts") ? b.nextElementSibling : b;
    acts.after(box);
    retrying = box;
    await fillModels(chat, sel);
  }

  // fillModels adds the models the chat can switch to after the option for
  // its current one.
  async function fillModels(chat, sel) {
    const cur = (chat.info && chat.info.model) || "";
    const curP = (chat.info && chat.info.provider) || "";
    try {
      const m = await api("GET", chat.base + "/models");
      if (ctx.chat() !== chat) return;
      const many = (m.providers || []).length > 1;
      for (const p of m.providers || []) {
        const parent = many ? el("optgroup") : sel;
        if (many) { parent.label = p.name; sel.append(parent); }
        for (const x of p.models) {
          if (x.id === cur && (!curP || p.id === curP)) continue;
          const opt = el("option", "", x.id);
          opt.value = p.id + "\n" + x.id;
          parent.append(opt);
        }
      }
    } catch (_) { /* only the current model */ }
  }

  // rewind sends the edit or the retry. A running turn stops first, since
  // Hermes rewinds only an idle chat.
  async function rewind(body) {
    const chat = ctx.chat();
    if (!chat) return false;
    try {
      if (ctx.running()) {
        await ctx.stop();
        for (let i = 0; i < 40 && ctx.running() && ctx.chat() === chat; i++) await new Promise((r) => setTimeout(r, 250));
      }
      const r = await api("POST", chat.base + "/rewind", body);
      if (r && r.status === "confirm") {
        ctx.banner((r.message || "That model needs a confirmation.") + " Pick it in the model settings under the title first.", true);
        return false;
      }
      ctx.toast(body.retry ? "Retrying" + (body.model ? " on " + body.model : "") : "Resent");
      if (ctx.chat() === chat) ctx.reopen(chat);
      return true;
    } catch (e) {
      ctx.banner((body.retry ? "Could not retry: " : "Could not resend: ") + e.message, true);
      return false;
    }
  }


  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
  const snip = (t) => {
    const s = String(t).replace(/\s+/g, " ").trim();
    return s.length > 40 ? s.slice(0, 39).trimEnd() + "…" : s;
  };

  // staysLine says what a rewind leaves alone, counting only what the page
  // knows: the live subagents, background commands and prompts, the to-do
  // list and where the chat runs. It is "" when there is nothing to name.
  function staysLine(chat) {
    const st = ctx.stays ? ctx.stays() : null;
    const parts = [];
    if (st) {
      if (st.subagents) parts.push(plural(st.subagents, "running subagent", "running subagents") + (st.subagents === 1 ? " (its result still arrives here)" : " (their results still arrive here)"));
      if (st.commands) parts.push(plural(st.commands, "background command", "background commands"));
      if (st.prompts) parts.push(plural(st.prompts, "background prompt", "background prompts"));
      if (st.todos) parts.push("the todo list (" + (st.todos.open ? st.todos.open + " open of " + st.todos.total : "all " + st.todos.total + " done") + ")");
    }
    const p = chat.place;
    if (p && p.kind === "computer") {
      parts.push("the folder and computer (" + (p.mine ? p.name : "another computer") + (p.dir ? ", " + p.dir : "") + ")");
    } else if (p && p.kind === "sandbox") {
      parts.push("the sandbox and its folder");
    }
    if (!parts.length) return "";
    return parts.length === 1 ? parts[0] : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }

  // rewindTo asks for the user's word, then takes the chat back to the
  // message b: the hub hides b and everything after it from the model and
  // sends nothing, and b's text goes back in the box.
  async function rewindTo(b) {
    const chat = ctx.chat();
    if (!chat || document.querySelector("dialog.rewind")) return;
    closeEdit();
    closeRetry();
    const all = bubbles();
    const after = all.length - 1 - all.indexOf(b);
    const text = textOf(b);
    const box = $("input");
    const d = el("dialog", "picker rewind");
    d.setAttribute("aria-labelledby", "rewind-title");
    const h = el("h2", "", "Rewind to “" + snip(text) + "”?");
    h.id = "rewind-title";
    const body = el("div", "pbody");
    const lead = el("p", "");
    if (after > 0) {
      lead.append("This message and the ", el("b", "", plural(after, "message", "messages") + " after it"),
        " leave what the model sees. They are hidden, not deleted.");
    } else {
      lead.append("This message leaves what the model sees. It is hidden, not deleted.");
    }
    const list = el("ul", "rewind-facts");
    const stays = staysLine(chat);
    if (stays) {
      const li = el("li");
      li.append(el("b", "", "Stays:"), " " + stays + ".");
      list.append(li);
    }
    const back = el("li");
    back.append(el("b", "", "Your message"), " goes back in the box to edit before sending." +
      (box.value.trim() ? " It replaces what is in the box now." : ""));
    list.append(back);
    const row = el("div", "rewind-model");
    const label = el("label", "", "Model");
    const sel = el("select");
    label.htmlFor = sel.id = "rewind-model";
    const cur = (chat.info && chat.info.model) || "";
    const o = el("option", "", cur ? cur + " (unchanged)" : "The current model");
    o.value = "";
    sel.append(o);
    row.append(label, sel);
    const err = el("div", "err");
    err.setAttribute("role", "alert");
    body.append(lead, list, row, err);
    const foot = el("div", "pfoot");
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    const go = el("button", "primary", "Rewind");
    go.type = "button";
    foot.append(cancel, go);
    d.append(h, body, foot);
    d.addEventListener("close", () => d.remove());
    cancel.onclick = () => d.close();
    go.onclick = async () => {
      const [provider, model] = sel.value ? sel.value.split("\n") : ["", ""];
      go.disabled = cancel.disabled = true;
      err.textContent = "";
      try {
        if (await rewindDone(chat, b, text, after + 1, provider, model, err)) d.close();
      } finally {
        go.disabled = cancel.disabled = false;
      }
    };
    document.body.append(d);
    d.showModal();
    go.focus();
    fillModels(chat, sel);
  }

  // rewindDone makes the hub take the chat back to the message b. A running
  // turn stops first, since Hermes rewinds only an idle chat. It returns
  // false, with the reason in err, when the chat did not change.
  async function rewindDone(chat, b, text, count, provider, model, err) {
    try {
      const rows = ((await transcript(chat)) || {}).messages || [];
      const i = rowOf(rows, b);
      const id = i >= 0 && rows[i].role === "user" ? rowID(rows[i]) : null;
      if (id === null) throw new Error("could not find this message in the chat's history");
      if (ctx.running()) {
        await ctx.stop();
        for (let n = 0; n < 40 && ctx.running() && ctx.chat() === chat; n++) await new Promise((r) => setTimeout(r, 250));
      }
      const r = await api("POST", chat.base + "/rewind", { row_id: id, no_send: true, provider, model });
      if (r && r.status === "confirm") {
        err.textContent = (r.message || "That model needs a confirmation.") + " Pick it in the model settings under the title first.";
        return false;
      }
      const at = r && Date.parse(r.at) > 0 ? Date.parse(r.at) : Date.now();
      remember(chat, id, at);
      const box = $("input");
      box.value = (r && r.text) || text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.focus();
      ctx.toast("Rewound " + plural(count, "message", "messages") + ". Your message is in the box");
      loadRewound(chat);
      return true;
    } catch (e) {
      err.textContent = "Could not rewind: " + e.message;
      return false;
    }
  }

  // The rewinds of the open chat: the groups of hidden messages that the
  // plugin lists, and when this browser rewound each (the hub's clock,
  // kept per message so it survives a reload; another browser has none).
  const rw = { chat: null, groups: [], shown: new Set() };
  const stamps = (chat) => {
    try { return JSON.parse(localStorage.getItem("rewound:" + chat.backend + "/" + chat.session) || "{}") || {}; } catch (_) { return {}; }
  };
  function remember(chat, rowId, at) {
    const all = stamps(chat);
    all[rowId] = at;
    const keep = Object.keys(all).slice(-50);
    try {
      localStorage.setItem("rewound:" + chat.backend + "/" + chat.session, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))));
    } catch (_) { /* no storage: no time shown after a reload */ }
  }
  const groupTime = (chat, g) => {
    const all = stamps(chat);
    let at = 0;
    for (const [k, v] of Object.entries(all)) if (Number(k) >= g.first_row_id && Number(k) <= g.last_row_id && v > at) at = v;
    return at;
  };
  const zoneOf = (ms) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(ms).find((x) => x.type === "timeZoneName");
    return p ? p.value : "";
  };

  async function loadRewound(chat) {
    try {
      const got = await api("GET", chat.base + "/rewound");
      if (ctx.chat() !== chat || rw.chat !== chat) return;
      rw.groups = (got && got.groups) || [];
      for (const d of log.querySelectorAll(":scope .rewound")) d.remove();
      soon();
    } catch (_) { /* a server that cannot list them shows no line */ }
  }

  function dividerFor(chat, g) {
    const div = el("div", "rewound");
    div.dataset.first = g.first_row_id;
    div.dataset.last = g.last_row_id;
    div.setAttribute("role", "separator");
    const line = el("div", "rewound-line");
    const at = groupTime(chat, g);
    const said = plural(g.count, "message", "messages") + " rewound" + (at ? " at " + window.HubTimes.clock(at) + " " + zoneOf(at) : "") + " · ";
    const show = el("button", "link", "Show");
    show.type = "button";
    line.append(said, show);
    const rows = el("div", "rewound-list");
    rows.hidden = true;
    show.setAttribute("aria-expanded", "false");
    show.onclick = () => {
      const open = rows.hidden;
      rows.hidden = !open;
      show.textContent = open ? "Hide" : "Show";
      show.setAttribute("aria-expanded", String(open));
      if (open) rw.shown.add(g.first_row_id);
      else rw.shown.delete(g.first_row_id);
      if (open && !rows.firstChild) rows.append(...(g.rows || []).map(hiddenRow));
    };
    div.append(line, rows);
    if (rw.shown.has(g.first_row_id)) show.click();
    return div;
  }

  // hiddenRow draws one hidden message, read only.
  function hiddenRow(m) {
    const text = m.text != null ? m.text : "";
    if (m.role === "assistant") {
      const x = el("div", "hmsg hmsg-assistant");
      if (window.hubMarkdown) window.hubMarkdown.render(x, text);
      else x.textContent = text;
      return x;
    }
    const v = window.HubOrigin.classify(m);
    if (v.show !== "user") return el("div", "note", v.notice ? window.HubOrigin.line(v.notice) : text);
    const x = el("div", "hmsg hmsg-user");
    if (window.hubMarkdown && window.hubMarkdown.renderUser) window.hubMarkdown.renderUser(x, v.text);
    else x.textContent = v.text;
    return x;
  }

  // placeRewound keeps one line in the log for each group of hidden
  // messages, after the last message before it and before the first one
  // that came later (by row id), wherever the log was drawn again or older
  // messages were added above.
  function placeRewound() {
    const chat = ctx.chat();
    if (!chat) return;
    if (rw.chat !== chat) {
      rw.chat = chat;
      rw.groups = [];
      loadRewound(chat);
      return;
    }
    const rowed = Array.from(log.querySelectorAll("[data-row]")).filter((n) => n.classList.contains("msg"));
    for (const g of rw.groups) {
      let div = log.querySelector('.rewound[data-first="' + g.first_row_id + '"]');
      const ok = div && rowed.every((n) => {
        const before = !!(div.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING);
        return before === (Number(n.dataset.row) <= g.last_row_id);
      });
      if (ok) continue;
      if (!div) div = dividerFor(chat, g);
      const next = rowed.find((n) => Number(n.dataset.row) > g.last_row_id);
      if (next) next.before(div);
      else if (!rowed.length && log.firstChild) log.firstChild.before(div);
      else log.append(div);
    }
  }

  const rowID = (m) => (Number.isInteger(m.row_id) ? m.row_id : Number.isInteger(m._row_id) ? m._row_id : null);
  const rowText = (m) => (m.text != null ? m.text : typeof m.content === "string" ? m.content : "");
  // A user row is the user's turn when HubOrigin shows it as their bubble.
  const userTurn = (m) => m.role === "user" && window.HubOrigin.classify(m).show === "user";
  const visible = (m) => m.display_kind !== "hidden" && (userTurn(m) || (m.role === "assistant" && rowText(m)));

  async function transcript(chat) {
    return api("GET", chat.base + "/transcript");
  }

  // rowOf finds the transcript row of a bubble: its own row ID, or the row
  // in the same place counted from the end.
  function rowOf(rows, b) {
    if (b.dataset.row) {
      const id = Number(b.dataset.row);
      const i = rows.findIndex((m) => rowID(m) === id);
      if (i >= 0) return i;
    }
    const all = bubbles();
    const shown = rows.map((m, i) => ({ m, i })).filter((x) => visible(x.m));
    const k = all.length - 1 - all.indexOf(b);
    const cand = shown[shown.length - 1 - k];
    const role = isUser(b) ? "user" : "assistant";
    if (cand && cand.m.role === role) return cand.i;
    const same = all.filter((x) => isUser(x) === isUser(b));
    const kk = same.length - 1 - same.indexOf(b);
    const pick = shown.filter((x) => x.m.role === role);
    return pick.length - 1 - kk >= 0 ? pick[pick.length - 1 - kk].i : -1;
  }

  async function branch(b, btn) {
    const chat = ctx.chat();
    if (!chat) return;
    btn.disabled = true;
    try {
      const t = await transcript(chat);
      const rows = (t && t.messages) || [];
      const i = rowOf(rows, b);
      if (i < 0) throw new Error("could not find this message in the chat's history");
      let through = null;
      let prefill = "";
      if (isUser(b)) {
        for (let j = i - 1; j >= 0 && through === null; j--) through = rowID(rows[j]);
        prefill = textOf(b);
        if (through === null) {
          ctx.toast("First message: copy it to a new chat");
          return;
        }
      } else {
        let end = i;
        for (let j = i + 1; j < rows.length && !userTurn(rows[j]); j++) end = j;
        for (let j = end; j >= i && through === null; j--) through = rowID(rows[j]);
      }
      if (through === null) throw new Error("this message has no row ID yet");
      const r = await api("POST", chat.base + "/branch", { row_id: through });
      const base = "/api/sessions/" + encodeURIComponent(r.backend_id) + "/" + encodeURIComponent(r.session_id);
      if (prefill) await api("PUT", base + "/draft", { text: prefill }).catch(() => {});
      ctx.toast("New chat started from this message");
      ctx.open(r.backend_id, r.session_id);
    } catch (e) {
      ctx.banner("Could not branch: " + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // Markdown export: messages in order, tool steps folded under <details>.
  function fence(text) {
    const s = String(text);
    let f = "```";
    while (s.includes(f)) f += "`";
    return f + "\n" + s + "\n" + f;
  }

  function argsLine(args) {
    if (args == null) return "";
    if (typeof args === "string") { try { args = JSON.parse(args); } catch (_) { return args.slice(0, 200); } }
    if (typeof args.command === "string") return args.command;
    if (typeof args.path === "string") return args.path;
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 199) + "…" : s;
  }

  function markdown(title, rows) {
    const out = ["# " + (title || "Chat"), "", "_Exported from Talaria on " + new Date().toLocaleString() + "._", ""];
    const calls = new Map();
    let steps = [];
    let who = "";
    const flush = () => {
      if (!steps.length) return;
      const names = [...new Set(steps.map((s) => s.name))];
      out.push("<details>", "<summary>" + steps.length + (steps.length === 1 ? " tool step: " : " tool steps: ") +
        names.join(", ").replace(/[<>&]/g, "") + "</summary>", "");
      for (const s of steps) {
        out.push("**" + s.name + "**" + (s.args ? " `" + s.args.replace(/`/g, "'").replace(/\n/g, " ") + "`" : ""), "");
        if (s.result) out.push(fence(s.result.length > 4000 ? s.result.slice(0, 4000) + "\n…" : s.result), "");
      }
      out.push("</details>", "");
      steps = [];
    };
    const head = (h) => { if (who !== h) { out.push("## " + h, ""); who = h; } };
    for (const m of rows) {
      if (m.display_kind === "hidden") continue;
      const text = rowText(m);
      if (m.role === "user") {
        flush();
        const v = window.HubOrigin.classify(m);
        const n = v.notice;
        // A card of a block Hermes joined after the user's words.
        const card = (c, whole) => {
          if (c.kind === "agent") {
            who = "";
            head("Agent message");
            out.push(c.result || whole.replace(agentHead, ""), "");
          } else out.push("> " + window.HubOrigin.line(c), "");
        };
        if (n && n.kind === "agent") {
          card(n, text);
          for (const a of v.after || []) card(a.notice, a.text);
          continue;
        }
        if (n) out.push("> " + window.HubOrigin.line(n), "");
        if (v.show !== "user") {
          for (const a of v.after || []) card(a.notice, a.text);
          continue;
        }
        who = "";
        head("You");
        out.push(v.text, "");
        for (const a of v.after || []) card(a.notice, a.text);
      } else if (m.role === "assistant") {
        for (const c of m.tool_calls || []) {
          const fn = c.function || {};
          const call = { name: fn.name || "tool", args: argsLine(fn.arguments) };
          if (c.id) calls.set(c.id, call);
          if (c.call_id) calls.set(c.call_id, call);
        }
        if (text) {
          flush();
          head("Talaria");
          out.push(text, "");
        }
      } else if (m.role === "tool") {
        const call = calls.get(m.tool_call_id) || {};
        head("Talaria");
        const res = m.content != null ? m.content : text;
        steps.push({ name: m.name || m.tool_name || call.name || "tool", args: call.args || "",
          result: typeof res === "string" ? res : JSON.stringify(res, null, 2) });
      }
    }
    flush();
    return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  }

  async function exportChat(backend, session, title) {
    const base = "/api/sessions/" + encodeURIComponent(backend) + "/" + encodeURIComponent(session);
    try {
      const t = await api("GET", base + "/transcript");
      const name = (title || (t && t.title) || "chat").replace(/[^\w .-]+/g, "").trim().slice(0, 80) || "chat";
      const blob = new Blob([markdown(title || (t && t.title), (t && t.messages) || [])], { type: "text/markdown" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = name + ".md";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      ctx.toast("Exported " + name + ".md");
    } catch (e) {
      ctx.banner("Could not export: " + e.message, true);
    }
  }

  function reset() {
    editing = null;
    retrying = null;
  }

  return { decorate: soon, editLast, exportChat, reset, markdown };
};
