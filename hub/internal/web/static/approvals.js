"use strict";
// HubApprovals keeps the cards of the approvals and questions a chat waits
// on. Every pending prompt gets a card of its own with its own buttons, and
// a card says only what the page knows: "Sent" once the hub took the answer
// to Hermes, a settled state when Hermes says the prompt is over, and "Not
// answered" when Hermes dropped it (a restart) with no answer to it.
window.HubApprovals = (() => {
  const closedWords = "The agent closed this, or restarted, before an answer arrived. Nothing was sent from this page.";

  // outcomeOf reads the text of an outcome ("Allowed once (in the hub)",
  // "Denied (in Telegram)", "Answered", or why a card was closed) into
  // { allowed, head, where, closed }.
  function outcomeOf(text) {
    const m = /^(Allowed once|Allowed for this chat|Allowed always|Allowed|Denied) \((.+)\)$/.exec(String(text || ""));
    if (m) return { allowed: m[1] !== "Denied", head: m[1], where: m[2] };
    if (text === "Answered") return { allowed: null, head: "Answered" };
    return { allowed: null, closed: true, head: "Not answered" };
  }

  // model is the card of an approval that is over, as HubToolCard draws it
  // (the approval renderer of cards/agents.js calls this): the outcome, the
  // action, who asked and why on three lines; every part of the approval
  // when it is open.
  function model(rec) {
    const p = rec.prompt || {};
    const clock = (window.HubTimes && window.HubTimes.clock) || (() => "");
    const out = { icon: "lock", title: "Approval:", blocks: [], lines: [], idle: !rec.closed && rec.allowed === null };
    out.status = rec.head;
    if (rec.allowed === true) out.tone = "ok";
    if (rec.allowed === false) {
      out.tone = "bad";
      out.bad = true;
    }
    const line = (x) => String(x || "").split("\n").map((t) => t.trim()).find(Boolean) || "";
    // A plugin's description may carry the script it asks to run after "Script:".
    const split = p.description ? /^([\s\S]*?)\s*\bScript:\s*([\s\S]+)$/.exec(p.description) : null;
    const words = line(split ? split[1] : p.description);
    const command = p.command && !/^<[\w.-]+>/.test(p.command) ? p.command : "";
    const shown = p.command || (split ? split[2] : "");
    if (rec.closed) {
      out.lines.push({ parts: closedWords, dim: true, closed: true });
    } else {
      const head = [];
      if (command) {
        const k = command.search(/\s/);
        if (k > 0) head.push(command.slice(0, k) + " ", { code: command.slice(k + 1).trim() });
        else head.push({ code: command });
      } else if (words) head.push(words);
      if (p.subagent) head.push(" ", { chip: "Subagent" }, " " + p.subagent);
      if (head.length) out.lines.push({ parts: head, closed: true });
      const why = p.rule ? p.rule + (p.reason ? ": " + line(p.reason) : "") : command ? words : "";
      const dim = [];
      if (why) dim.push(why);
      if (p.grant_source && Array.isArray(p.choices) && p.choices.includes("source")) dim.push("source " + p.grant_source);
      const place = [rec.where, rec.at && clock(rec.at)].filter(Boolean).join(", ");
      if (place) dim.push(place);
      if (dim.length) out.lines.push({ parts: dim.join(" \u00b7 "), dim: true, closed: true });
    }
    const rows = [];
    if (p.subagent) rows.push({ k: "Asked by", v: [{ chip: "Subagent" }, " " + p.subagent] });
    if (p.rule) rows.push({ k: "Rule", v: p.rule });
    const reason = String(p.reason || "").split("\n").map((t) => t.trim()).filter(Boolean).join(" ");
    if (reason) rows.push({ k: "Why", v: reason });
    else if (words && !p.rule) rows.push({ k: "Action", v: words });
    if (p.grant_source && Array.isArray(p.choices) && p.choices.includes("source")) rows.push({ k: "Source", v: p.grant_source });
    if (rec.where) rows.push({ k: "Answered", v: rec.where.charAt(0).toUpperCase() + rec.where.slice(1) + (rec.at && clock(rec.at) ? ", " + clock(rec.at) : "") });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    if (shown) out.blocks.push({ label: "Command", text: shown });
    return out;
  }

  // create makes the cards of one chat. deps:
  //   el(tag, cls, text), api(method, path, body), base (the chat's API path),
  //   words(key) for the fixed texts, banner(text, bad), add(node) to put a
  //   card in the chat, setTimeout/clearTimeout, ackMs (how long an answer
  //   may wait for Hermes to confirm it before the card offers a retry).
  function create(deps) {
    const { el, api, base, words, banner, add } = deps;
    const setT = deps.setTimeout || setTimeout;
    const clearT = deps.clearTimeout || clearTimeout;
    const ackMs = deps.ackMs || 15000;
    const cards = new Map();

    const done = (card) => card.state === "settled";
    const Q = deps.question || window.HubQuestion;
    const clock = deps.clock || ((ms) => (window.HubTimes ? window.HubTimes.clock(ms) : ""));

    // answerOf is the answer a card sent, as clarify.respond takes it: the
    // text the page knows when Hermes says nothing of the answer.
    function sentRecord(card) {
      const b = card.body || {};
      const picks = Array.isArray(b.picks) ? b.picks : [];
      const text = typeof b.text === "string" ? b.text.trim() : "";
      const data = { prompt_id: card.id, outcome: b.skip ? "skipped" : "answered", answered_at: Date.now() / 1000, answered_via: "hub" };
      const all = text ? [...picks, text] : picks;
      data.answer = card.prompt && card.prompt.multi_select ? JSON.stringify(all) : all[0] || "";
      return data;
    }

    // closeQuestion turns a question's card into the card of the answered
    // question: the question, the choices, the answer checked and when and where
    // it came, from what Hermes said when it settled (data), else from what
    // the page sent. note replaces the status line.
    function closeQuestion(card, data, note) {
      if (card.timer) clearT(card.timer);
      card.timer = null;
      card.state = "settled";
      const rec = Q.fromSettled(data, card.prompt);
      const shown = Q.view({ el, clock, note, toast }, rec || { questions: [], outcome: "" });
      replace(card, shown);
      card.note = null;
    }

    const toast = (text, o) => banner(text, !!(o && o.bad));

    // replace puts a card's answered form in its box, which stays where it is in the chat.
    function replace(card, shown) {
      card.box.className = "settled";
      card.box.replaceChildren(shown);
    }

    // finish turns the card of an approval that is over into the card of its
    // outcome: the answer, the action, who asked and why. text is what the
    // page knows of it.
    function finish(id, text) {
      const card = cards.get(id);
      if (!card) return;
      if (card.timer) clearT(card.timer);
      card.timer = null;
      card.state = "settled";
      const rec = Object.assign({ prompt: card.prompt, at: Date.now() }, outcomeOf(text));
      const shown = window.HubToolCard.create({ el, toast }, { name: "approval", args: { rec, clock }, res: null, out: "", done: true, failed: false, startedAt: 0, endedAt: 0, mem: window.HubToolCard.memory() }).node;
      replace(card, shown);
      card.note = null;
    }

    // note shows a line under the buttons, such as why an answer was not
    // taken. An empty text removes it.
    function note(card, text, bad) {
      if (card.note) card.note.remove();
      card.note = null;
      if (!text) return;
      card.note = el("div", bad ? "sendnote bad" : "sendnote", text);
      card.box.append(card.note);
    }

    function offer(p) {
      const id = p && p.prompt_id;
      if (!id || cards.has(id)) return;
      const box = el("div", "approval");
      const clarify = p.kind === "clarify";
      box.append(el("b", "", clarify ? "Question" : words("approval")));
      // A smart approval card comes in parts (Hermes sends rule, reason, the subagent's goal and the source as
      // fields of their own): who asks, then Rule, Why and Source as a list, then the command. A Hermes that
      // sends only the description gets the one-sentence card below.
      const parted = !clarify && (p.rule || p.reason);
      if (parted) {
        if (p.subagent) {
          const by = el("div", "by");
          const goal = el("span", "goal", p.subagent);
          goal.title = p.subagent;
          by.append(el("span", "chip", "Subagent"), goal);
          box.append(by);
        }
        const list = el("dl", "parts");
        if (p.rule) list.append(el("dt", "", "Rule"), el("dd", "rulename", p.rule));
        // The reason's lines (a ledger write adds its entry and the source of the approval it claims) are one block
        // each: the page collapses a newline in a block.
        const why = String(p.reason || "").split("\n").filter((x) => x.trim());
        if (why.length) {
          const dd = el("dd", "why");
          for (const line of why) dd.append(el("div", "", line));
          list.append(el("dt", "", "Why"), dd);
        }
        if (p.grant_source && Array.isArray(p.choices) && p.choices.includes("source")) list.append(el("dt", "", "Source"), el("dd", "", p.grant_source));
        box.append(list);
        if (p.command) box.append(el("pre", "", p.command));
      } else {
        // A plugin's description may carry the script it asks to run after "Script:"; that goes in a code box of its
        // own, not in the sentence. The command of a plugin rule is "<tool> (plugin approval rule)", which is
        // internal: the description already says it, and without one the card says it in words.
        const rule = p.command ? /^<([\w.-]+)> \(plugin approval rule\)$/.exec(p.command) : null;
        const split = p.description ? /^([\s\S]*?)\s*\bScript:\s*([\s\S]+)$/.exec(p.description) : null;
        // A description of several lines (a ledger write names the entry, the note and where the approval came
        // from) is one block per line: the page collapses a newline in a block.
        const sentence = split ? split[1] : p.description;
        for (const line of sentence ? String(sentence).split("\n") : []) if (line.trim()) box.append(el("div", "", line));
        if (split) box.append(el("pre", "", split[2]));
        if (p.command && !rule) box.append(el("pre", "", p.command));
        if (rule && !p.description) box.append(el("div", "rule", "An approval rule requires approval before the " + rule[1].replace(/_/g, " ") + " tool runs."));
        if (p.subagent && !parted && !clarify) box.append(el("div", "who", "Asked by a subagent: " + p.subagent));
      }
      if (clarify && p.subagent) {
        const by = el("div", "by");
        const goal = el("span", "goal", p.subagent);
        goal.title = p.subagent;
        by.append(el("span", "chip", "Subagent"), goal);
        box.append(by);
      }
      if (p.question) box.append(el("div", clarify ? "q" : "", clarify ? Q.plain(p.question, p.subagent) : p.question));
      const actions = el("div", "actions");
      const buttons = [];
      const card = { id, box, actions, buttons, state: "open", timer: null, note: null, body: null, clarify, prompt: p };
      cards.set(id, card);
      const enable = (on) => { for (const b of buttons) b.disabled = !on; };

      const send = async (body) => {
        card.body = body;
        card.state = "sending";
        enable(false);
        note(card, "");
        try {
          if (body.allow !== undefined) await api("POST", base + "/approvals/" + encodeURIComponent(id), body);
          else await api("POST", base + "/prompts/" + encodeURIComponent(id) + "/answer", body);
        } catch (e) {
          if (done(card)) return;
          // 404: the prompt was settled where this page could not see it (another tab, Telegram, a timeout,
          // a restart of Hermes)
          if (e && e.status === 404) {
            const gone = "No longer waiting: the agent closed this before the answer arrived";
            if (card.clarify) closeQuestion(card, { outcome: "lost" }, gone); else finish(id, gone);
            return;
          }
          card.state = "open";
          enable(true);
          note(card, "Not delivered: " + ((e && e.message) || "the hub did not answer") + ". Press a button to try again.", true);
          banner("Could not answer: " + ((e && e.message) || "the hub did not answer"), true);
          return;
        }
        if (done(card)) return;
        // The hub answers 202 once Hermes took the answer. The card is settled only when Hermes says so.
        card.state = "sent";
        note(card, "Sent. Waiting for the agent to confirm.");
        card.timer = setT(() => {
          card.timer = null;
          if (card.state !== "sent") return;
          card.state = "open";
          enable(true);
          note(card, "The agent has not confirmed this answer. Press a button to send it again.", true);
        }, ackMs);
      };

      const button = (cls, text, body) => {
        const b = el("button", cls, text);
        b.type = "button";
        b.onclick = () => send(typeof body === "function" ? body() : body);
        buttons.push(b);
        return b;
      };
      const choices = Array.isArray(p.choices) ? p.choices : [];
      if (!clarify && !choices.length) {
        actions.append(button("primary", words("allow"), { allow: true }), button("danger", words("deny"), { allow: false }));
      } else if (!clarify) {
        const names = { once: words("allow"), session: "Allow in this chat", always: "Always allow", source: p.grant_source ? "Allow code from " + p.grant_source + " in this chat" : "Allow code from this source in this chat", deny: words("deny") };
        // Deny stays the last button; the source choice names what it allows.
        for (const c of [...choices.filter((x) => x !== "deny"), ...choices.filter((x) => x === "deny")]) actions.append(button(c === "deny" ? "danger" : c === "once" ? "primary" : "", names[c] || c, { choice: c }));
      } else {
        // Every question has an Other row to type an answer in, whatever the
        // agent offered: the only input of a question with no choices and, for
        // a multi-select question, an answer that goes with the picks.
        const input = el("input", "answer");
        input.type = "text";
        input.placeholder = choices.length ? "Or type your own answer" : "Type your answer";
        input.setAttribute("aria-label", Q.OTHER);
        buttons.push(input);
        const picks = [];
        let sendBtn = null;
        if (p.multi_select) {
          const list = el("div", "picks");
          for (const c of choices) {
            const row = el("label", "pick");
            const cb = el("input");
            cb.type = "checkbox";
            cb.value = c;
            picks.push(cb);
            buttons.push(cb);
            row.append(cb, el("span", "", c));
            list.append(row);
          }
          box.append(list);
        } else if (choices.length) {
          const list = el("div", "choices");
          for (const c of choices) {
            const b = button("choice", c, { picks: [c] });
            list.append(b);
          }
          box.append(list);
        }
        const typed = el("div", "typed");
        typed.append(el("div", "otherlabel", Q.OTHER));
        const field = el("div", "otherfield");
        field.append(input);
        if (p.multi_select) {
          // Send takes the picks and the typed text together.
          sendBtn = button("primary sendpicks", "Send", () => {
            const body = { picks: picks.filter((b) => b.checked).map((b) => b.value) };
            if (input.value.trim()) body.text = input.value;
            return body;
          });
        } else {
          sendBtn = button(choices.length ? "" : "primary", "Answer", () => ({ text: input.value }));
        }
        field.append(sendBtn);
        input.onkeydown = (e) => { if (e.key === "Enter" && input.value.trim()) { e.preventDefault(); sendBtn.click(); } };
        typed.append(field);
        box.append(typed);
        actions.append(button("ghost", "Skip", { skip: true }));
      }
      box.append(actions);
      add(box);
    }

    // settled is Hermes's approval.settled: the prompt is over. The hub's
    // outcome event that follows says how, when the hub knows.
    function settled(id, data) {
      const card = cards.get(id);
      if (!card || done(card)) return;
      if (card.clarify) {
        // What Hermes says of the answer; an older Hermes says nothing, and
        // the card then shows what this page sent, or that it was closed.
        const sent = card.state === "sent" || card.state === "sending";
        if (data && data.outcome) closeQuestion(card, data);
        else if (sent && card.body) closeQuestion(card, sentRecord(card));
        else closeQuestion(card, { outcome: "lost" }, "Closed by the agent, no answer was seen here");
        return;
      }
      finish(id, card.state === "sent" || card.state === "sending" ? "Answered" : "Closed by the agent, no answer was seen here");
    }

    // outcome is the hub's approval.outcome: what became of the approval.
    function outcome(id, text) {
      const card = cards.get(id);
      if (!card) return;
      finish(id, text);
    }

    // lost is the hub's word that Hermes no longer holds these prompts and
    // nobody answered them: a restart or a drop. They get no answer.
    function lost(ids) {
      for (const id of ids || []) {
        const card = cards.get(id);
        if (card && !done(card) && card.clarify) closeQuestion(card, { outcome: "lost" });
        else if (card && !done(card)) finish(id, "Closed: this is no longer open. It was answered elsewhere, or the agent restarted and dropped it. Nothing was sent from this page.");
      }
    }

    function cancelled(ids) {
      for (const id of ids || []) {
        const card = cards.get(id);
        if (card && card.clarify && !done(card)) closeQuestion(card, { outcome: "cancelled" });
        else finish(id, "Cancelled");
      }
    }

    // restore shows the card of a question that was over before this page drew
    // the chat (a subagent's, which the hub kept): data is its clarify.settled
    // record.
    function restore(data) {
      const rec = Q.fromSettled(data);
      if (!rec || cards.has("done:" + rec.id)) return;
      const box = Q.view({ el, clock }, rec);
      cards.set("done:" + rec.id, { id: rec.id, box, state: "settled", clarify: true, prompt: data, restored: true });
      add(box);
    }

    // retire takes away the cards of the chat's own questions that are over:
    // the call that asked them ended, and its stored result draws one card for
    // all of its questions, as it does after a reload.
    function retire() {
      for (const [id, card] of [...cards]) {
        if (!card.clarify || !done(card) || card.restored || (card.prompt && card.prompt.subagent)) continue;
        card.box.remove();
        cards.delete(id);
      }
    }

    function dispose() {
      for (const card of cards.values()) if (card.timer) clearT(card.timer);
      cards.clear();
    }

    return { offer, settled, outcome, lost, cancelled, restore, retire, dispose, has: (id) => cards.has(id), card: (id) => cards.get(id) };
  }
  return { create, model, outcomeOf };
})();
