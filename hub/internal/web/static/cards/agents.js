"use strict";
// Cards of agents: subagents (delegate_task), messages between chats
// (agent_send, agent_peers, agent_set_name), a question to the user
// (clarify) and an approval that was answered. Each renderer turns a call
// into the card model described at the top of toolcard.js and is registered
// with HubToolCard.register. clarify and approval are drawn by
// questioncard.js and approvals.js through this same component.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, verb, errorText, upperFirst, who, toolLabel } = H.util;

  const arr = (v) => (Array.isArray(v) ? v : []);
  const firstLine = (s) => cut(first(str(s)), 140);
  const sub = (c, id) => (id && c.mem ? short(c.mem.sub(id)) : "");

  // routeLabel is the name of the route a subagent runs on, from the
  // "route opus: model via provider" text of a result's ran_on, or "".
  function routeLabel(s) {
    const m = /^route\s+([^:]+):/.exec(str(s));
    return m ? m[1].trim() : "";
  }

  // plainError is a failure in plain words: the ids of subagents in it
  // become their goals, as far as the chat knows them.
  function plainError(c, text) {
    return squash(str(text).replace(/'?\bsa-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*\b'?/g, (m) => {
      const g = sub(c, m.replace(/'/g, ""));
      return g ? "\"" + g + "\"" : "the subagent";
    }));
  }

  // resumeReason is why Hermes refused a resume, in words.
  function resumeReason(c, e) {
    if (/still running/i.test(e)) return "it is still running, message it instead";
    if (/no finished-run record/i.test(e)) return "it has no finished run to resume from";
    if (/spawn tree|cannot be resumed|not a nested one/i.test(e)) return "it is not one of this chat's subagents";
    return cut(plainError(c, e), 80);
  }

  // stateWords is a subagent's state in a list, in words.
  function stateWords(s) {
    const t = str(s).toLowerCase().replace(/_/g, " ");
    if (t === "stalling") return { tone: "warn", text: "stalling" };
    return t || "running";
  }

  function delegate(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const act = str(a.action) || "spawn";
    const out = { icon: "bot", blocks: [], lines: [] };
    const id = str(a.subagent_id) || str(res.subagent_id);
    const goalOf = () => sub(c, id) || "a subagent";
    const msg = str(a.message);
    const queued = str(res.status).toLowerCase() === "queued";
    if (act === "list") {
      out.icon = "list";
      out.title = verb(c, "Listed", "Listing") + " subagents";
      out.idle = true;
      const rows = arr(res.subagents).filter(isObj);
      if (c.res && Array.isArray(res.subagents)) {
        const wait = rows.filter((r) => str(r.status).toLowerCase() === "queued").length;
        const run = rows.length - wait;
        out.status = !rows.length ? "None running" : [run ? run + " running" : "", wait ? wait + " queued" : ""].filter(Boolean).join(", ");
        const names = rows.map((r) => short(str(r.goal))).filter(Boolean);
        if (names.length) out.lines.push({ parts: names.join(", "), dim: true, closed: true });
        out.blocks.push({
          kind: "kv",
          rows: rows.map((r) => {
            const bits = [stateWords(r.status)];
            if (typeof r.tool_count === "number") bits.push(plural(r.tool_count, "step"));
            const route = routeLabel(r.route) || str(typeof r.route === "string" ? r.route : "") || "";
            if (route) bits.push(route);
            const v = [];
            bits.forEach((b, i) => {
              if (i) v.push(", ");
              v.push(b);
            });
            return { k: short(str(r.goal)) || "a subagent", v };
          }),
        });
      }
    } else if (act === "steer") {
      out.icon = "compass";
      out.title = verb(c, "Message to subagent: ", "Sending a message to subagent: ") + goalOf();
      out.status = "Delivered at its next step";
      if (msg) {
        out.lines.push({ parts: firstLine(msg), dim: true, closed: true });
        out.blocks.push({ label: "Message", text: msg });
      }
    } else if (act === "resume") {
      out.icon = "bot";
      out.title = verb(c, "Resumed subagent: ", "Resuming subagent: ") + goalOf();
      if (c.failed) {
        out.title = "Resume subagent: " + goalOf();
        out.ownFailure = true;
        out.status = "Refused: " + resumeReason(c, errorText(c.res) || str(c.error));
        out.tone = "bad";
      } else {
        out.status = queued ? "Queued, starts when a slot frees" : "Running again";
        if (queued) out.tone = "warn";
        if (msg) {
          out.lines.push({ parts: firstLine(msg), dim: true, closed: true });
          out.blocks.push({ label: "Message", text: msg });
        }
      }
    } else if (act === "transcript") {
      out.icon = "list";
      out.title = verb(c, "Read subagent steps: ", "Reading subagent steps: ") + goalOf();
      const entries = arr(res.entries).filter(isObj);
      const n = typeof res.returned === "number" ? res.returned : Array.isArray(res.entries) ? entries.length : null;
      const all = typeof res.total_entries === "number" ? res.total_entries : null;
      if (n !== null) {
        const w = all !== null && all > n ? "Last " + n + " of " + plural(all, "step") : plural(n, "step");
        out.more = res.running === true ? [w + ", ", { tone: "warn", text: "still running" }] : [w];
      }
      out.idle = true;
      const rows = [];
      for (const e of entries) {
        if (e.role === "tool") {
          const t = cut(squash(str(e.result)), 200);
          if (t) rows.push({ k: "output", v: t });
          continue;
        }
        const text = cut(squash(str(e.text)), 300);
        if (e.role === "user") {
          if (text) rows.push({ k: "user", v: text });
          continue;
        }
        if (text) rows.push({ k: "said", v: text });
        for (const t of arr(e.tool_calls).filter(isObj)) {
          let args = t.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch (_) { /* keep the text */ }
          }
          const cmd = isObj(args) && typeof args.command === "string" ? args.command : "";
          rows.push(cmd ? { k: "ran", v: [{ code: short(cmd) }] } : { k: "used", v: toolLabel(str(t.name)) });
        }
      }
      if (rows.length) out.blocks.push({ kind: "kv", rows });
    } else if (act === "stop") {
      out.icon = "stop";
      out.title = "Stopping subagent: " + goalOf();
      const s = str(res.status).toLowerCase();
      out.status = !s || s === "interrupt_requested" ? "Stop requested" : upperFirst(s.replace(/_/g, " "));
    } else {
      spawn(c, a, res, out, queued);
    }
    return out;
  }

  // spawn is the card of a call that starts subagents.
  function spawn(c, a, res, out, queued) {
    const tasks = arr(a.tasks).filter(isObj);
    const list = tasks.length ? tasks : [a];
    const goals = list.map((t) => str(t.goal));
    const runs = arr(res.runs_on).filter(isObj);
    const routes = list.map((_, i) => {
      const r = runs.find((x) => x.task_index === i) || runs[i];
      return r ? routeLabel(r.runs_on) : "";
    });
    const many = tasks.length > 1;
    const word = c.failed ? "Could not start" : verb(c, "Started", "Starting");
    out.title = many ? word + " " + tasks.length + " subagents" : word + " subagent: " + (short(goals[0]) || "a task");
    out.chips = routes.filter(Boolean);
    if (Array.isArray(res.results)) {
      const bad = res.results.filter((r) => isObj(r) && !/^(completed|success)$/i.test(str(r.status))).length;
      out.status = plural(res.results.length, "subagent") + " finished" + (bad ? ", " + bad + " failed" : "");
      if (bad) out.tone = "warn";
    } else if (queued) {
      out.status = "Queued, starts when a slot frees";
      out.tone = "warn";
    } else {
      out.status = "Running in the background";
    }
    if (many) {
      out.lines.push({ parts: goals.filter(Boolean).map(short).join("; "), dim: true, closed: true });
      const rows = list.map((_, i) => ({ k: routes[i] || String(i + 1), v: short(goals[i]) || "a task" }));
      out.blocks.push({ label: "Goals", kind: "kv", rows });
    } else if (goals[0] && (/\n/.test(goals[0].trim()) || short(goals[0]) !== squash(goals[0]))) {
      out.blocks.push({ label: "Goal", text: goals[0].trim() });
    }
    const ctx = str(a.context).trim();
    if (ctx) out.blocks.push({ label: "Context", text: ctx });
    if (many) {
      tasks.forEach((t) => {
        const x = str(t.context).trim();
        if (x && x !== ctx) out.blocks.push({ label: "Context: " + short(str(t.goal)), text: x });
      });
    } else if (!ctx && tasks[0] && tasks[0].context) {
      out.blocks.push({ label: "Context", text: str(tasks[0].context).trim() });
    }
  }

  // deliveryWords reads the sentence the hub gives for how a message got to
  // its target: the status word and what follows it.
  function deliveryWords(d) {
    const t = squash(d).toLowerCase();
    if (!t) return { head: "Sent", rest: "" };
    if (t.startsWith("started a turn")) return { head: "Delivered", rest: "started a turn, the chat was idle" };
    if (t.startsWith("steered into the subagent")) return { head: "Delivered", rest: "steered into the subagent, it reads it after its current step" };
    if (t.startsWith("steered into its running turn")) return { head: "Delivered", rest: "steered into its running turn, read with its next tool result" };
    if (t.startsWith("it arrives with")) return { head: "Delivered", rest: "arrives with the next tool result" };
    if (t.startsWith("queued for when")) return { head: "Queued", rest: "the chat is busy, it gets it when its turn ends", tone: "warn" };
    if (t === "queued") return { head: "Queued", rest: "", tone: "warn" };
    return { head: upperFirst(t), rest: "" };
  }

  function send(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "mail", blocks: [], lines: [] };
    // The hub names the peer in the result ("chat 'name' (session id)",
    // "subagent sa-..."); the title says it in words: a subagent by its goal,
    // a chat by its title.
    const peer = who(str(res.to) || str(a.to), c.mem);
    out.title = verb(c, "Sent a message to ", "Sending a message to ") + peer.label;
    const text = str(a.text);
    if (text) {
      out.lines.push({ parts: "\"" + firstLine(text) + "\"", dim: true, closed: true });
      out.blocks.push({ label: "Message", text });
    }
    if (c.failed) {
      out.ownFailure = true;
      out.tone = "bad";
      out.status = "Not sent";
      const why = cut(plainError(c, errorText(c.res) || str(c.error)), 120);
      out.more = why ? [why] : [];
      return out;
    }
    const d = deliveryWords(res.delivery);
    out.status = d.head;
    if (d.tone) out.tone = d.tone;
    out.more = [[d.rest, a.reply_to ? "a reply" : ""].filter(Boolean).join(" \u00b7 ")];
    return out;
  }

  // chatName is how a chat is called in a list of chats: its name, else its
  // title.
  const chatName = (x) => short(str(x.name) || str(x.title)) || "a chat";

  function agentPeers(c) {
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "list", blocks: [], lines: [], idle: true };
    out.title = verb(c, "Listed", "Listing") + " your chats";
    if (!isObj(c.res) || !Array.isArray(res.chats)) return out;
    const chats = res.chats.filter(isObj);
    const subs = arr(res.subagents).filter(isObj);
    const working = chats.filter((x) => x.running).length;
    const bits = [];
    if (chats.length) bits.push(plural(chats.length, "chat") + (working ? " (" + working + " working)" : ""));
    if (subs.length) bits.push(plural(subs.length, "subagent"));
    out.status = bits.join(", ") || "No other chats or subagents";
    const subName = (x) => (str(x.goal) ? "the subagent \"" + short(str(x.goal)) + "\"" : str(x.relation).startsWith("parent") ? "the parent" : "a subagent");
    const names = [...chats.map(chatName), ...subs.map(subName)];
    if (names.length) {
      const shown = names.slice(0, 4);
      const rest = names.length - shown.length;
      out.lines.push({ parts: shown.join(", ") + (rest ? " and " + rest + " more" : ""), dim: true, closed: true });
    }
    const rows = chats.map((x) => {
      const v = [x.running ? { tone: "ok", text: "working" } : "idle"];
      if (str(x.where)) v.push(" \u00b7 " + str(x.where));
      if (x.partner) v.push(" ", { chip: "works with this chat" });
      return { k: chatName(x), v };
    });
    for (const x of subs) {
      const rel = str(x.relation).startsWith("parent") ? "parent" : str(x.relation);
      rows.push({ k: "Subagent", v: [subName(x).replace(/^the subagent /, "") + (rel ? " \u00b7 " + rel : "")] });
    }
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    return out;
  }

  function agentName(c) {
    const a = isObj(c.args) ? c.args : {};
    const name = short(str(a.name));
    const out = { icon: "edit", blocks: [], status: "Done" };
    out.title = name ? verb(c, "Named this chat ", "Naming this chat ") + name : verb(c, "Cleared", "Clearing") + " this chat's name";
    return out;
  }

  // clarify is a question to the user. Once it is answered its result gives
  // the card (questioncard.js); a call that has no such result is a plain
  // card of the question.
  function clarify(c) {
    const Q = window.HubQuestion;
    const rec = isObj(c.args) && c.args.rec ? c.args.rec : Q && c.done && c.res ? Q.fromResult(c.res) : null;
    if (Q && rec) return Q.model(rec, c.args && c.args.clock);
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "info", title: "Question", blocks: [], lines: [] };
    const q = str(a.question);
    if (q) out.lines.push({ parts: firstLine(q), closed: true });
    if (q) out.blocks.push({ text: q, plain: true, copy: false });
    return out;
  }

  // approval is an approval that was answered; approvals.js gives the card
  // its model.
  function approval(c) {
    const A = window.HubApprovals;
    return A && isObj(c.args) && c.args.rec ? A.model(c.args.rec) : { icon: "lock", title: "Approval:", status: "Done", blocks: [] };
  }

  H.register({ delegate_task: delegate, agent_send: send, agent_peers: agentPeers, agent_set_name: agentName, clarify, approval });
})();
