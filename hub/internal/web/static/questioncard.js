"use strict";
// HubQuestion draws a question the agent asked once it is over: the question,
// every choice that was offered with the answer checked, the Other row (a typed
// answer shows there, checked, as "Other: <text>"), and when and where it was
// answered, or that nobody answered it. A card is built from stored data only:
// Hermes's clarify.settled event, the copy of it the hub keeps for a subagent's
// question, or the stored result of the clarify tool call, so it reads the
// same live, after a reload, after a switch to another chat and after a
// restart. A record is
//   { questions: [{ text, choices, multi, picks, other, skipped }], subagent,
//     outcome, at, via, timeoutS }
// with at in Unix milliseconds. outcome is answered, skipped, timed_out,
// cancelled, lost or undelivered.
window.HubQuestion = (() => {
  const OTHER = "Other (type your own)";
  const label = /\s*\(Recommended\)\s*$/i;
  const bare = (s) => String(s == null ? "" : s).replace(label, "").trim().toLowerCase();

  // sort splits an answer into the choices it picked and the text typed in the
  // Other row. A single-select answer is one string; a multi-select answer is
  // an array or a JSON array string, whose entries that are no choice were
  // typed.
  function sort(answer, choices, multi) {
    const picks = [];
    const typed = [];
    const known = (v) => choices.find((c) => bare(c) === bare(v));
    let list = answer;
    if (multi && typeof answer === "string") {
      try {
        const j = JSON.parse(answer);
        list = Array.isArray(j) ? j : [answer];
      } catch (_) { list = [answer]; }
    }
    if (!Array.isArray(list)) list = [list];
    for (const v of list) {
      if (v == null || String(v).trim() === "") continue;
      const c = known(v);
      if (c !== undefined) { if (!picks.includes(c)) picks.push(c); } else typed.push(String(v).trim());
    }
    return { picks, other: typed.join(", ") };
  }

  // plain is a question's text without the prefix Hermes gives a subagent's:
  // the card names the subagent in a chip of its own.
  function plain(text, goal) {
    let t = String(text || "");
    if (goal) {
      const lead = "Subagent \"" + goal + "\" asks: ";
      if (t.startsWith(lead)) t = t.slice(lead.length);
    }
    return t.replace(/\n+\(?Type "?skip"? to skip\)?\.?\s*$/i, "").trim();
  }

  // fromSettled is the record of one question from clarify.settled's data. A
  // viewer that held the prompt gives it as prompt, for the parts an older
  // Hermes leaves out of the event.
  function fromSettled(p, prompt) {
    if (!p || !p.outcome) return null;
    const src = Object.assign({}, prompt || {}, p);
    const choices = Array.isArray(src.choices) ? src.choices.map(String) : [];
    const multi = !!src.multi_select && choices.length > 0;
    const q = { text: plain(src.question, src.subagent), choices, multi, picks: [], other: "", skipped: p.outcome === "skipped" };
    if (p.outcome === "answered") Object.assign(q, sort(p.answer, choices, multi));
    const at = Number(p.answered_at || p.ended_at || 0);
    return { questions: [q], subagent: src.subagent || "", outcome: p.outcome, at: at > 0 ? Math.round(at * 1000) : 0,
      via: p.answered_via || "", timeoutS: Number(p.timeout_s) > 0 ? Number(p.timeout_s) : (p.outcome === "timed_out" ? Number(src.timeout_s) || 0 : 0), id: p.prompt_id || "" };
  }

  // fromResult is the record of a clarify tool call from its stored result
  // (tools/clarify_tool.py), or null for a result that does not keep what a
  // card needs: one stored before Hermes did (it has no ended_at), which
  // stays a plain tool card.
  function fromResult(res) {
    if (!res || typeof res !== "object" || !Array.isArray(res.responses) || !res.responses.length) return null;
    if (typeof res.ended_at !== "number") return null;
    let at = 0;
    let via = "";
    const questions = res.responses.map((r) => {
      const choices = Array.isArray(r.choices_offered) ? r.choices_offered.map(String) : [];
      const multi = !!r.multi_select && choices.length > 0;
      const q = { text: String(r.question || ""), choices, multi, picks: [], other: "", skipped: r.status === "skipped" };
      if (r.status === "answered") {
        Object.assign(q, sort(r.user_response, choices, multi));
        if (Number(r.answered_at) > 0 && Number(r.answered_at) * 1000 >= at) { at = Math.round(Number(r.answered_at) * 1000); via = r.answered_via || ""; }
      }
      return q;
    });
    const out = res.outcome === "submitted" ? (questions.every((q) => q.skipped) ? "skipped" : "answered") : String(res.outcome || "answered");
    if (!at) at = Math.round(res.ended_at * 1000);
    return { questions, subagent: "", outcome: out, at, via, timeoutS: Number(res.timeout_s) > 0 ? Number(res.timeout_s) : 0, id: "" };
  }

  const where = (via) => ({ hub: " (in the hub)", telegram: " (on Telegram)", device: " (in a paired app)" })[via] || "";

  function minutes(s) {
    const m = Math.round(s / 60);
    if (s >= 90 && m >= 1) return m + (m === 1 ? " minute" : " minutes");
    return s + (s === 1 ? " second" : " seconds");
  }

  // status is the line under the card.
  function status(rec, clock) {
    const when = rec.at && clock ? clock(rec.at) : "";
    switch (rec.outcome) {
      case "answered": return when ? "Answered at " + when + where(rec.via) : "Answered" + where(rec.via);
      case "skipped": return when ? "Skipped at " + when + where(rec.via) : "Skipped" + where(rec.via);
      case "timed_out": return "No answer: timed out" + (rec.timeoutS ? " after " + minutes(rec.timeoutS) : "");
      case "cancelled": return "Withdrawn: the agent stopped waiting for an answer";
      case "lost": return "Withdrawn: the agent no longer waits for this question. It may have been answered elsewhere, or the agent restarted.";
      case "undelivered": return "No answer: the question could not be shown";
      default: return rec.note || "";
    }
  }

  // view draws a record as a card. deps: el(tag, cls, text), clock(ms), and
  // note (a line that replaces the status, such as why a send failed).
  function view(deps, rec) {
    const { el } = deps;
    const box = el("div", "approval done qdone");
    box.append(el("b", "", rec.questions.length > 1 ? "Questions" : "Question"));
    if (rec.subagent) {
      const by = el("div", "by");
      const goal = el("span", "goal", rec.subagent);
      goal.title = rec.subagent;
      by.append(el("span", "chip", "Subagent"), goal);
      box.append(by);
    }
    rec.questions.forEach((q, i) => {
      box.append(el("div", rec.questions.length > 1 ? "sub" : "q", (rec.questions.length > 1 ? i + 1 + ". " : "") + q.text));
      const list = el("ul", "qchoices");
      const row = (text, on, cls) => {
        const li = el("li", on ? "pick" + (cls ? " " + cls : "") : cls || "");
        li.append(el("span", "m", on ? "\u2713" : ""), el("span", "t", text));
        list.append(li);
      };
      for (const c of q.choices) row(c, q.picks.includes(c));
      row(q.other ? "Other: " + q.other : OTHER, !!q.other, "other");
      box.append(list);
    });
    box.append(el("div", "res", deps.note || status(rec, deps.clock)));
    return box;
  }

  return { OTHER, fromSettled, fromResult, view, status, sort, plain };
})();
