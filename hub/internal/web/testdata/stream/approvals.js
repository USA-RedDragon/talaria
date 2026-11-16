"use strict";
const assert = require("assert");
const { load } = require("./harness.js");

// A DOM just big enough for the cards.
class Node {
  constructor(tag, cls) {
    this.tag = tag;
    this.className = cls || "";
    this.children = [];
    this.textContent = "";
    this.disabled = false;
    this.parent = null;
    this.attrs = {};
  }
  append(...kids) { for (const k of kids) { if (typeof k === "string") { const n = new Node("#text"); n.textContent = k; this.append(n); } else { k.parent = this; this.children.push(k); } } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  walk(fn) { for (const c of this.children) { fn(c); c.walk(fn); } }
  matches(sel) { return sel.split(",").some((s) => this.className.split(" ").includes(s.trim().replace(/^\./, ""))); }
  querySelector(sel) { let r = null; this.walk((n) => { if (!r && n.matches(sel)) r = n; }); return r; }
  querySelectorAll(sel) { const r = []; this.walk((n) => { if (n.matches(sel)) r.push(n); }); return r; }
  text() { let s = this.textContent; for (const c of this.children) s += " " + c.text(); return s.trim(); }
  buttons() { const r = []; this.walk((n) => { if (n.tag === "button") r.push(n); }); return r; }
}
const el = (tag, cls, text) => { const n = new Node(tag, cls); if (text !== undefined && text !== null) n.textContent = text; return n; };

const textOf = (parts) => parts.map((p) => (typeof p === "string" ? p : p.code || p.chip || p.text || "")).join("");
const words = (k) => ({ approval: "Approval needed: run this command", allow: "Allow", deny: "Deny" })[k];

const flush = () => new Promise((r) => setImmediate(r));

function harness(over) {
  const h = load(process.argv.slice(2));
  // The card component draws into the fake DOM as its model, as text.
  const T = h.win.HubToolCard;
  T.create = (ctx, c) => {
    const d = T.derive(c);
    const node = ctx.el("div", "tool notice");
    node.derived = d;
    node.append(ctx.el("span", "", [d.title, d.status, textOf(d.more), ...d.lines.map((l) => textOf(l.parts))].filter(Boolean).join(" ")));
    return { node };
  };
  const log = [];
  const shown = [];
  const banners = [];
  const tracker = h.win.HubApprovals.create(Object.assign({
    el, base: "/api/sessions/b/s", words, banner: (t) => banners.push(t),
    add: (box) => shown.push(box),
    api: async (method, path, body) => { log.push(JSON.parse(JSON.stringify({ method, path, body }))); },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id),
    clock: (ms) => "12:56 PM",
  }, over || {}));
  return { h, tracker, log, shown, banners };
}

const prompt = (id, cmd) => ({ kind: "approval", prompt_id: id, command: cmd, description: "recursive delete", choices: ["once", "session", "always", "deny"] });

// The card of a question, live and once it is over (Jacob's approved mockup: every choice that was offered, the
// answer checked, a typed answer in the Other row, when and where it was answered, or how it ended).
const dv = (card) => card.derived || card.children[0].derived;
const rows = (card) => JSON.parse(JSON.stringify(dv(card).blocks.filter((b) => b.kind === "list").flatMap((b) => b.items.map((i) => [i.dim ? "" : "pick", textOf(i.parts)]))));
const res = (card) => textOf(dv(card).more);
const OTHER = "Other (type your own)";
async function questionCards() {
  const ask = { kind: "clarify", question: "What should cpus/a64 be renamed to?", choices: ["cpus/aarch64", "cpus/arm64", "Keep cpus/a64"] };
  // Every question has an Other row with a text box, whatever the agent sent: choices, several picks, or none.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "a" }, ask));
    tracker.offer({ kind: "clarify", prompt_id: "b", question: "Layouts?", choices: ["Switch", "NDS"], multi_select: true });
    tracker.offer({ kind: "clarify", prompt_id: "c", question: "What should the release notes call this?" });
    for (const card of shown) {
      assert.ok(card.text().includes(OTHER), "Other row: " + card.text());
      assert.strictEqual(card.querySelectorAll("answer").length, 1, "one text box");
      assert.ok(card.buttons().some((b) => b.textContent === "Skip"));
    }
    // An open question has the Other row as its only input.
    assert.deepStrictEqual(shown[2].buttons().map((b) => b.textContent), ["Answer", "Skip"]);
    assert.strictEqual(shown[2].querySelectorAll("pick").length, 0);
  }
  // A multi-select answer sends the picks together with the Other text.
  {
    const { tracker, shown, log } = harness();
    tracker.offer({ kind: "clarify", prompt_id: "m", question: "Layouts?", choices: ["Switch", "NDS"], multi_select: true });
    const boxes = shown[0].querySelectorAll("pick").map((r) => r.children[0]);
    boxes[1].checked = true;
    shown[0].querySelector("answer").value = "Game Boy";
    shown[0].buttons().find((b) => b.textContent === "Send").onclick();
    await flush();
    assert.deepStrictEqual(log[0].body, { picks: ["NDS"], text: "Game Boy" });
  }
  // A choice that was picked: all the choices stay, the pick is checked, with the time and where.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "a" }, ask));
    tracker.settled("a", { prompt_id: "a", outcome: "answered", answer: "cpus/aarch64", answered_at: 1, answered_via: "hub", question: ask.question, choices: ask.choices });
    assert.deepStrictEqual(rows(shown[0]), [["pick", "\u2713 cpus/aarch64"], ["", "cpus/arm64"], ["", "Keep cpus/a64"], ["", OTHER]]);
    assert.strictEqual(res(shown[0]), "Answered at 12:56 PM (in the hub)");
    assert.strictEqual(shown[0].buttons().length, 0);
    assert.strictEqual(dv(shown[0]).title, "Question: cpus/aarch64");
  }
  // A typed answer shows in the Other row, checked.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "a" }, ask));
    tracker.settled("a", { outcome: "answered", answer: "cpus/armv8, and rename the symbols to rl_armv8_*", answered_at: 1, answered_via: "telegram" });
    assert.deepStrictEqual(rows(shown[0]), [["", "cpus/aarch64"], ["", "cpus/arm64"], ["", "Keep cpus/a64"], ["pick", "\u2713 Other: cpus/armv8, and rename the symbols to rl_armv8_*"]]);
    assert.strictEqual(res(shown[0]), "Answered at 12:56 PM (on Telegram)");
  }
  // Several picks and a typed one in a multi-select question; an open question's answer is the Other row, checked.
  {
    const { tracker, shown } = harness();
    tracker.offer({ kind: "clarify", prompt_id: "m", question: "Layouts?", choices: ["Switch", "Game Boy", "NDS"], multi_select: true });
    tracker.settled("m", { outcome: "answered", answer: JSON.stringify(["Switch", "NDS", "SNES"]), answered_at: 1, answered_via: "hub" });
    assert.deepStrictEqual(rows(shown[0]), [["pick", "\u2713 Switch"], ["", "Game Boy"], ["pick", "\u2713 NDS"], ["pick", "\u2713 Other: SNES"]]);
    tracker.offer({ kind: "clarify", prompt_id: "o", question: "Call it?" });
    tracker.settled("o", { outcome: "answered", answer: "Pocket mode", answered_at: 1, answered_via: "hub" });
    assert.deepStrictEqual(rows(shown[1]), [["pick", "\u2713 Other: Pocket mode"]]);
  }
  // A subagent's question: the chip with its goal, the question without Hermes's prefix, then the same card.
  {
    const { tracker, shown } = harness();
    tracker.offer({ kind: "clarify", prompt_id: "s", subagent: "relift lane android-apk: on-screen controller", question: "Subagent \"relift lane android-apk: on-screen controller\" asks: Stick clicks?", choices: ["Double-tap", "Separate"] });
    assert.deepStrictEqual(shown[0].querySelector("by").children.map((c) => [c.className, c.textContent]), [["chip", "Subagent"], ["goal", "relift lane android-apk: on-screen controller"]]);
    assert.ok(!shown[0].text().includes("asks:"));
    tracker.settled("s", { outcome: "answered", answer: "Double-tap", answered_at: 1, answered_via: "telegram" });
    assert.strictEqual(dv(shown[0]).titleParts[0].chip, "Subagent");
    assert.ok(dv(shown[0]).blocks[0].rows[0].v.join("").includes("relift lane android-apk: on-screen controller") || textOf(dv(shown[0]).blocks[0].rows[0].v).includes("relift lane android-apk: on-screen controller"));
    assert.deepStrictEqual(rows(shown[0])[0], ["pick", "\u2713 Double-tap"]);
  }
  // No answer: a timeout says how long it waited; a withdrawn question says so; the choices stay.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "t" }, ask, { timeout_s: 1800 }));
    tracker.settled("t", { outcome: "timed_out", timeout_s: 1800 });
    assert.strictEqual(res(shown[0]), "Timed out after 30 minutes");
    assert.strictEqual(rows(shown[0]).length, 4);
    assert.ok(rows(shown[0]).every((r) => !r[0].includes("pick")));
    assert.strictEqual(dv(shown[0]).title, "Question");
    tracker.offer(Object.assign({ prompt_id: "w" }, ask));
    tracker.settled("w", { outcome: "cancelled" });
    assert.ok(res(shown[1]).startsWith("Withdrawn"));
    tracker.offer(Object.assign({ prompt_id: "l" }, ask));
    tracker.lost(["l"]);
    assert.ok(res(shown[2]).startsWith("Withdrawn"));
  }
  // A Hermes that says nothing of the answer: a card the page answered shows what it sent; others say they were closed.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "a" }, ask));
    shown[0].buttons()[1].onclick();
    await flush();
    tracker.settled("a", { prompt_id: "a" });
    assert.deepStrictEqual(rows(shown[0])[1], ["pick", "\u2713 cpus/arm64"]);
    tracker.offer(Object.assign({ prompt_id: "z" }, ask));
    tracker.settled("z", { prompt_id: "z" });
    assert.ok(res(shown[1]).includes("no answer was seen here"));
  }
  // A question kept by the hub is drawn when the chat loads, and not twice.
  {
    const { tracker, shown } = harness();
    const rec = { prompt_id: "k", outcome: "answered", answer: "Separate", answered_at: 1763228160, answered_via: "telegram", subagent: "lane", question: "Subagent \"lane\" asks: Stick clicks?", choices: ["Double-tap", "Separate"] };
    tracker.restore(rec);
    tracker.restore(rec);
    assert.strictEqual(shown.length, 1);
    assert.deepStrictEqual(rows(shown[0])[1], ["pick", "\u2713 Separate"]);
    assert.strictEqual(res(shown[0]), "Answered at 12:56 PM (on Telegram)");
    // Retiring the chat's own cards leaves it alone.
    let removed = false;
    shown[0].remove = () => { removed = true; };
    tracker.retire();
    assert.ok(!removed);
  }
  // The chat's own settled cards go when the call that asked ends: its stored result draws them. A subagent's stay.
  {
    const { tracker, shown } = harness();
    tracker.offer(Object.assign({ prompt_id: "a" }, ask));
    tracker.offer(Object.assign({ prompt_id: "b" }, ask, { subagent: "lane" }));
    tracker.offer(Object.assign({ prompt_id: "c" }, ask));
    tracker.settled("a", { outcome: "answered", answer: "cpus/arm64" });
    tracker.settled("b", { outcome: "answered", answer: "cpus/arm64" });
    const removed = [];
    shown.forEach((box, i) => { box.remove = () => removed.push(i); });
    tracker.retire();
    assert.deepStrictEqual(removed, [0], "only the chat's own answered question goes; an open one and a subagent's stay");
  }
}

(async () => {
  // Three approvals at once: three cards, each with its own buttons.
  {
    const { tracker, shown } = harness();
    for (const id of ["a", "b", "c"]) tracker.offer(prompt(id, "cleanup " + id));
    tracker.offer(prompt("b", "cleanup b again")); // a repeat adds no second card
    assert.strictEqual(shown.length, 3);
    for (const box of shown) assert.strictEqual(box.buttons().length, 4, "each card has Allow, chat, always and Deny");
    // Answering one touches no other card.
    shown[0].buttons()[0].onclick();
    await flush();
    assert.ok(shown[0].buttons().every((b) => b.disabled));
    assert.ok(shown[1].buttons().every((b) => !b.disabled));
    assert.ok(shown[2].buttons().every((b) => !b.disabled));
  }

  // An answer the hub took is "Sent" until Hermes settles it; then it is answered.
  {
    const { tracker, log, shown } = harness();
    tracker.offer(prompt("a", "cleanup a"));
    shown[0].buttons()[0].onclick();
    await flush();
    assert.deepStrictEqual(log, [{ method: "POST", path: "/api/sessions/b/s/prompts/a/answer", body: { choice: "once" } }]);
    assert.ok(shown[0].text().includes("Sent. Waiting for the agent to confirm."));
    tracker.settled("a");
    assert.ok(shown[0].text().includes("Answered"));
    assert.strictEqual(shown[0].buttons().length, 0);
    tracker.outcome("a", "Allowed once (in the hub)");
    assert.ok(shown[0].text().includes("Allowed once") && shown[0].text().includes("in the hub"), shown[0].text());
  }

  // A prompt Hermes closed that this page did not answer is not "Answered".
  {
    const { tracker, shown } = harness();
    tracker.offer(prompt("a", "cleanup a"));
    tracker.settled("a");
    const t = shown[0].text();
    assert.ok(!t.includes("Answered"), t);
    assert.ok(t.includes("Not answered") && t.includes("closed this, or restarted"), t);
  }

  // An answer Hermes does not confirm re-offers the buttons with a note.
  {
    const timers = [];
    const { tracker, shown } = harness({ setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1, clearTimeout: () => {}, ackMs: 7000 });
    tracker.offer(prompt("a", "cleanup a"));
    shown[0].buttons()[0].onclick();
    await flush();
    assert.strictEqual(timers[0].ms, 7000);
    assert.ok(shown[0].buttons().every((b) => b.disabled));
    timers[0].fn();
    assert.ok(shown[0].buttons().every((b) => !b.disabled));
    assert.ok(shown[0].text().includes("The agent has not confirmed this answer"));
  }

  // A confirmation that comes in time cancels the retry offer.
  {
    const cleared = [];
    const { tracker, shown } = harness({ setTimeout: () => 42, clearTimeout: (id) => cleared.push(id) });
    tracker.offer(prompt("a", "cleanup a"));
    shown[0].buttons()[1].onclick();
    await flush();
    tracker.settled("a");
    assert.deepStrictEqual(cleared, [42]);
  }

  // A failed send says so on the card and keeps the buttons; a 404 closes it.
  {
    let fail = { message: "network down" };
    const { tracker, shown, banners } = harness({ api: async () => { throw fail; } });
    tracker.offer(prompt("a", "cleanup a"));
    shown[0].buttons()[0].onclick();
    await flush();
    assert.ok(shown[0].buttons().every((b) => !b.disabled));
    assert.ok(shown[0].text().includes("Not delivered: network down"));
    assert.strictEqual(banners.length, 1);
    fail = { status: 404, message: "gone" };
    shown[0].buttons()[0].onclick();
    await flush();
    assert.ok(shown[0].text().includes("Not answered"));
    assert.strictEqual(shown[0].buttons().length, 0);
  }

  // Prompts the hub says Hermes lost close without an answer; others stay.
  {
    const { tracker, shown } = harness();
    for (const id of ["a", "b", "c"]) tracker.offer(prompt(id, "cleanup " + id));
    tracker.lost(["a", "c"]);
    assert.ok(shown[0].text().includes("closed this, or restarted"));
    assert.ok(shown[2].text().includes("closed this, or restarted"));
    assert.strictEqual(shown[0].buttons().length, 0);
    assert.strictEqual(shown[1].buttons().length, 4);
    tracker.cancelled(["b"]);
    assert.ok(shown[1].text().includes("Not answered"));
  }

  // Questions keep their answer box and Skip.
  {
    const { tracker, shown, log } = harness();
    tracker.offer({ kind: "clarify", prompt_id: "q", question: "Which?", choices: ["x", "y"] });
    const names = shown[0].buttons().map((b) => b.textContent);
    assert.deepStrictEqual(names, ["x", "y", "Answer", "Skip"]);
    shown[0].buttons()[0].onclick();
    await flush();
    assert.deepStrictEqual(log[0].body, { picks: ["x"] });
  }

  // Plain approvals with no choices get Allow and Deny, sent as allow.
  {
    const { tracker, shown, log } = harness();
    tracker.offer({ kind: "approval", prompt_id: "p", command: "ls" });
    assert.deepStrictEqual(shown[0].buttons().map((b) => b.textContent), ["Allow", "Deny"]);
    shown[0].buttons()[1].onclick();
    await flush();
    assert.deepStrictEqual(log[0], { method: "POST", path: "/api/sessions/b/s/approvals/p", body: { allow: false } });
  }
  // A smart approval card for outside code offers its source for the chat, named plainly, and sends the choice.
  {
    const { tracker, shown, log } = harness();
    tracker.offer({ kind: "approval", prompt_id: "s", command: "curl -o x https://github.com/AppImage/appimagetool/x",
      description: "Smart approval rule \"Code from External\"", choices: ["once", "deny", "source"], grant_source: "github.com/AppImage/appimagetool", subagent: "relift chunk" });
    assert.deepStrictEqual(shown[0].buttons().map((b) => b.textContent),
      ["Allow", "Allow code from github.com/AppImage/appimagetool in this chat", "Deny"]);
    shown[0].buttons()[1].onclick();
    await flush();
    assert.deepStrictEqual(log[0], { method: "POST", path: "/api/sessions/b/s/prompts/s/answer", body: { choice: "source" } });
    // A card that does not name the source still says what the button does.
    const other = harness();
    other.tracker.offer({ kind: "approval", prompt_id: "t", command: "x", choices: ["once", "deny", "source"] });
    assert.strictEqual(other.shown[0].buttons()[1].textContent, "Allow code from this source in this chat");
  }
  // A description of several lines (a ledger write: the entry, the note, where the approval came from) shows as
  // one block per line, with the rule sentence first and the command after.
  {
    const { tracker, shown } = harness();
    tracker.offer({ kind: "approval", prompt_id: "l", command: "<ledger> {\"action\": \"close\"}",
      description: "Smart approval rule \"Self-Modification\": no user message gives that approval\nIt closes ledger entry L3da0b8 (a question waiting on the user, open): \"Download libadrenotools?\"\n\nNothing you said in this chat matches what this entry claims.",
      choices: ["once", "deny"], subagent: "relift chunk" });
    const divs = shown[0].children.filter((c) => c.tag === "div" && c.className === "").map((c) => c.textContent);
    assert.deepStrictEqual(divs, [
      "Smart approval rule \"Self-Modification\": no user message gives that approval",
      "It closes ledger entry L3da0b8 (a question waiting on the user, open): \"Download libadrenotools?\"",
      "Nothing you said in this chat matches what this entry claims."]);
    assert.ok(shown[0].text().includes("Asked by a subagent: relift chunk"));
    // A plugin's script still gets its own box, and a one-line description is one block as before.
    const one = harness();
    one.tracker.offer({ kind: "approval", prompt_id: "m", command: "x", description: "recursive delete" });
    assert.deepStrictEqual(one.shown[0].children.filter((c) => c.tag === "div" && c.className === "").map((c) => c.textContent), ["recursive delete"]);
  }
  // A smart approval card in parts: who asks once (a chip and the goal), Rule, Why with one block per line, Source
  // only when the card offers the source choice, then the command. No "Asked by a subagent" line, no description.
  {
    const { tracker, shown } = harness();
    tracker.offer({ kind: "approval", prompt_id: "pa", command: "<process_manage> {\"action\": \"kill\"}",
      description: "Subagent \"relift chunk\" asks: Smart approval rule \"Interfere With Workloads\": old text",
      choices: ["once", "deny"], subagent: "relift chunk", rule: "Interfere With Workloads",
      reason: "The kill names no process.\nA kill like this one was blocked earlier." });
    const card = shown[0];
    const kids = (cls) => card.children.filter((c) => c.className === cls);
    const by = kids("by")[0];
    assert.deepStrictEqual(by.children.map((c) => [c.className, c.textContent]), [["chip", "Subagent"], ["goal", "relift chunk"]]);
    const dl = kids("parts")[0];
    assert.strictEqual(dl.tag, "dl");
    assert.deepStrictEqual(dl.children.map((c) => c.tag + ":" + c.text()), [
      "dt:Rule", "dd:Interfere With Workloads", "dt:Why", "dd:The kill names no process. A kill like this one was blocked earlier."]);
    assert.deepStrictEqual(dl.children[3].children.map((c) => c.textContent), ["The kill names no process.", "A kill like this one was blocked earlier."]);
    assert.ok(!card.text().includes("Asked by a subagent") && !card.text().includes("old text") && !card.text().includes("asks:"));
    assert.deepStrictEqual(card.children.map((c) => c.tag), ["b", "div", "dl", "pre", "div"]);
    assert.strictEqual(card.children[0].textContent, "Approval needed: run this command");
    assert.deepStrictEqual(card.buttons().map((b) => b.textContent), ["Allow", "Deny"]);
    // The chat's own card has no who line; a source row only with the source choice.
    const own = harness();
    own.tracker.offer({ kind: "approval", prompt_id: "pb", command: "x", choices: ["once", "deny"], rule: "Auto-Mode Bypass", reason: "Retries a blocked command.", grant_source: "github.com/o/r" });
    assert.deepStrictEqual(own.shown[0].children.map((c) => c.className || c.tag), ["b", "parts", "pre", "actions"]);
    assert.ok(!own.shown[0].text().includes("Source") && !own.shown[0].text().includes("Subagent"));
    const src = harness();
    src.tracker.offer({ kind: "approval", prompt_id: "pc", command: "x", choices: ["once", "deny", "source"], rule: "Code from External", reason: "Downloads and runs it.", grant_source: "github.com/AppImage/appimagetool", subagent: "g" });
    assert.deepStrictEqual(src.shown[0].querySelector("parts").children.map((c) => c.text()), ["Rule", "Code from External", "Why", "Downloads and runs it.", "Source", "github.com/AppImage/appimagetool"]);
    // A reason without a rule (a review that could not decide) still gets its list.
    const unsure = harness();
    unsure.tracker.offer({ kind: "approval", prompt_id: "pd", command: "x", choices: ["once", "deny"], reason: "Could not decide (no answer)" });
    assert.deepStrictEqual(unsure.shown[0].querySelector("parts").children.map((c) => c.text()), ["Why", "Could not decide (no answer)"]);
    // A prompt from a Hermes that sends only the description keeps the old card, with its subagent line.
    const old = harness();
    old.tracker.offer({ kind: "approval", prompt_id: "pe", command: "x", choices: ["once", "deny"], subagent: "relift chunk", description: "Subagent \"relift chunk\" asks: Smart approval rule \"R\": why" });
    assert.ok(old.shown[0].text().includes("Asked by a subagent: relift chunk") && old.shown[0].text().includes("asks: Smart approval rule"));
    assert.strictEqual(old.shown[0].querySelector("parts"), null);
  }
  // A sign-in card: drawn from the hub's fields, with the computer's name, the saved-login line without a name, a
  // method picker, and three buttons. The picked method goes with the allowing choices only.
  {
    const lgPrompt = (over) => Object.assign({ kind: "approval", prompt_id: "lg", command: "browser_login", description: "pod text that is not shown",
      choices: ["once", "device", "deny"], login_grant: { device_id: "d1", device_name: "upstairs-pc", host: "portal.example.com", saved_logins: 1, methods: ["Password", "Email link"] } }, over || {});
    const { tracker, shown, log } = harness();
    tracker.offer(lgPrompt());
    const card = shown[0];
    assert.ok(card.text().includes("Sign in with the saved login on portal.example.com?"));
    assert.ok(card.text().includes("upstairs-pc") && card.text().includes("Firefox has one saved login for this site"));
    assert.ok(!card.text().includes("pod text"));
    assert.deepStrictEqual(card.buttons().map((b) => b.textContent), ["Allow once", "Allow on upstairs-pc", "Deny"]);
    const radios = []; card.walk((n) => { if (n.tag === "input" && n.attrs !== undefined && n.type === "radio") radios.push(n); });
    assert.deepStrictEqual(radios.map((r) => r.value), ["", "Password", "Email link"]);
    radios[2].onchange();
    card.buttons()[1].onclick();
    await flush();
    assert.deepStrictEqual(log[0], { method: "POST", path: "/api/sessions/b/s/prompts/lg/answer", body: { choice: "device", method: "Email link" } });
    const deny = harness();
    deny.tracker.offer(lgPrompt({ prompt_id: "lg2" }));
    deny.shown[0].buttons()[2].onclick();
    await flush();
    assert.deepStrictEqual(deny.log[0].body, { choice: "deny" });
    // Saved login lines.
    for (const [n, text] of [[0, "Firefox has no saved login for this site"], [3, "Firefox has 3 saved logins for this site and fills none of them"], [-1, "Whether Firefox has a saved login here is not known"]]) {
      const x = harness();
      x.tracker.offer(lgPrompt({ prompt_id: "n" + n, login_grant: { device_id: "d1", device_name: "pc", host: "a.example.com", saved_logins: n } }));
      assert.ok(x.shown[0].text().includes(text), text);
    }
    // A computer the hub does not know cannot be allowed.
    const unk = harness();
    unk.tracker.offer(lgPrompt({ prompt_id: "u", login_grant: { device_id: "dx", host: "a.example.com", saved_logins: 1 } }));
    assert.ok(unk.shown[0].buttons()[0].disabled && unk.shown[0].buttons()[1].disabled && !unk.shown[0].buttons()[2].disabled);
  }
  await questionCards();
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
