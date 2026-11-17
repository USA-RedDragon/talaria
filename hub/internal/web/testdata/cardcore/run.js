"use strict";
// The one tool card component (toolcard.js): the parts of its model drawn
// into a small fake DOM, a failure found in any of the shapes results use,
// the Raw toggle, mount and finish (the one path of the chat and the
// subagent steps), and the model's answer tied to a vision card.
// usage: node run.js STATIC_DIR
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");
const { el, document } = require("../fakedom.js");

const dir = process.argv[2];
const sandbox = { window: {}, document, Date, Math, JSON, Intl, Promise, setTimeout };
sandbox.window.HubIcons = { icon: (name) => el("svg", "ico i-" + name), button: (name, label, cls) => el("button", cls) };
vm.createContext(sandbox);
for (const f of ["times.js", "toolcard.js", ...fs.readdirSync(path.join(dir, "cards")).filter((x) => x.endsWith(".js")).sort().map((x) => "cards/" + x)]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), sandbox);
}
const H = sandbox.window.HubToolCard;
const ctx = { el, toast() {}, diff: (t) => el("pre", "diff", t) };
const text = (n) => (n ? n.textContent : "");

// A renderer of a made-up tool shows every part of the model.
H.register({
  demo_tool: (c) => ({
    icon: "tool",
    title: ["Edited ", { code: "handlers.go" }, " ", { code: "src/server/" }],
    chips: ["Global"],
    sub: { parts: [{ code: "/home/alice/app/" }], dim: true, mono: true },
    status: "+12 -3", more: ["2 places"],
    lines: [{ parts: ["in func ", { code: "loadConfig" }], dim: true }, { parts: ["only while closed"], closed: true }, "third", "a fourth is dropped"],
    blocks: [
      { label: "Diff", text: "-a\n+b", kind: "diff" },
      { label: "Where", kind: "kv", rows: [{ k: "Folder", v: [{ code: "/home/alice" }] }, { k: "Matching", v: "File contents" }] },
      { label: "Hits", kind: "list", items: [{ parts: ["db/conn.go:42"], mono: true }, "api.go"] },
      { label: "Empty", text: "" },
    ],
    raw: c.done ? "{\"ok\":true}" : "",
  }),
});

{
  const d = H.derive({ name: "demo_tool", done: true, failed: false, args: {}, res: null, out: "" });
  assert.strictEqual(d.title, "Edited handlers.go src/server/");
  assert.strictEqual(d.lines.length, 3, "at most three short lines");
  assert.deepStrictEqual(d.blocks.map((b) => b.label), ["Diff", "Where", "Hits"], "an empty block is dropped");
  assert.strictEqual(d.code, "src/server/");

  const v = H.create(ctx, { name: "demo_tool", done: true, failed: false, args: {}, res: null, out: "", mem: H.memory() });
  const n = v.node;
  const title = n.querySelector(".notice-title");
  assert.deepStrictEqual(title.childNodes.map((k) => (k.tagName ? k.tagName + ":" + k.textContent : k.textContent)), ["Edited ", "CODE:handlers.go", " ", "CODE:src/server/"]);
  assert.strictEqual(text(n.querySelector(".tool-chips")), "Global");
  assert.strictEqual(text(n.querySelector(".tool-sub")), "/home/alice/app/");
  assert.ok(n.querySelector(".tool-sub .tool-line").classList.contains("mono"));
  assert.strictEqual(text(n.querySelector(".notice-meta .notice-ok")), "+12 -3");
  assert.ok(text(n.querySelector(".notice-meta")).startsWith("+12 -3 · 2 places"), text(n.querySelector(".notice-meta")));
  const lines = () => n.querySelectorAll(".tool-lines .tool-line").map(text);
  assert.deepStrictEqual(lines(), ["in func loadConfig", "only while closed", "third"]);
  // The head order: icon, title, chips, chevron, line under the title, status, lines.
  const head = n.querySelector(".notice-head");
  assert.deepStrictEqual(head.children.map((k) => (k.classList.contains("notice-chev") ? "notice-chev" : k.className.split(" ")[0])), ["ico", "notice-title", "tool-chips", "notice-chev", "tool-sub", "notice-meta", "tool-lines"]);
  // Closed: nothing of the expanded part is built.
  assert.strictEqual(n.querySelector(".notice-body").children.length, 0);
  assert.ok(n.querySelector(".tool-raw").hidden);
  v.toggle();
  assert.deepStrictEqual(lines(), ["in func loadConfig", "third"], "a closed-only line hides when the card opens");
  const secs = n.querySelectorAll(".notice-body .tool-sec");
  assert.deepStrictEqual(secs.map((s) => text(s.querySelector("b"))), ["Diff", "Where", "Hits"]);
  assert.deepStrictEqual(n.querySelectorAll(".tool-kv dt").map(text), ["Folder", "Matching"]);
  assert.strictEqual(n.querySelector(".tool-kv dd").children[0].tagName, "CODE");
  assert.deepStrictEqual(n.querySelectorAll(".tool-list .tool-li").map(text), ["db/conn.go:42", "api.go"]);
  const raw = n.querySelector(".tool-raw");
  assert.ok(!raw.hidden, "Raw shows when the model has raw text");
  assert.ok(!raw.open, "Raw starts closed");
  assert.strictEqual(text(raw.querySelector("summary")), "Raw");
  assert.strictEqual(text(raw.querySelector("pre")), "{\"ok\":true}");
}

// A failure in any shape a result uses is a failure, never "Done".
{
  const shapes = [
    { result: "{\"error\":\"Permission denied\"}" },
    { result: "{\"error\":{\"message\":\"no such tab\"}}" },
    { result: "{\"success\":false,\"message\":\"Skill 'gitub' not found.\"}" },
    { result: "{\"status\":\"refused\",\"reason\":\"looks like a secret\"}" },
    { result: "{\"status\":\"not_found\"}" },
    { result: "{\"is_error\":true,\"message\":\"x\"}" },
    { result: "plain text", is_error: true },
    { result: "{}", error: "boom" },
  ];
  for (const p of shapes) assert.ok(H.outcome("some_tool", p).failed, JSON.stringify(p));
  for (const p of [{ result: "{\"status\":\"offered\"}" }, { result: "{\"success\":true}" }, { result: "{\"error\":\"\"}" }, { result: "ok" }]) {
    assert.ok(!H.outcome("some_tool", p).failed, JSON.stringify(p));
  }
  const o = H.outcome("some_tool", { result: "{\"success\":false,\"message\":\"Skill 'gitub' not found.\"}" });
  const d = H.derive({ name: "some_tool", done: true, failed: o.failed, res: o.res, out: o.out, args: { a: 1 } });
  assert.strictEqual(d.state, "bad");
  assert.strictEqual(d.status, "Failed: Skill 'gitub' not found.");
  assert.ok(d.raw.includes("gitub"), "an unknown tool's result is behind Raw");
}

// mount and finish: the one path of every log. A card mounted and finished
// twice, with the same call, is the same DOM.
function shape(n) {
  if (!n || !n.tagName) return n ? JSON.stringify(n.textContent) : "";
  const attrs = Object.keys(n.attrs).sort().map((k) => k + "=" + n.attrs[k]).join(",");
  return n.tagName + "." + n.className + (n.hidden ? "[hidden]" : "") + "{" + attrs + "}(" + n.childNodes.map(shape).join(" ") + ")";
}
{
  const draw = () => {
    const mem = H.memory();
    const node = H.mount(ctx, { key: "c1", name: "terminal", args: { command: "make", workdir: "/home/alice/app" }, startedAt: 0, mem });
    assert.ok(node.classList.contains("running"));
    assert.strictEqual(node.dataset.ukey, "t:c1");
    H.finish(ctx, node, { result: "{\"output\":\"done\",\"exit_code\":2}", endedAt: 0, duration: 4 });
    return node;
  };
  const a = draw();
  const b = draw();
  assert.strictEqual(shape(a), shape(b));
  assert.ok(a.failed && a.classList.contains("failed"));
  assert.strictEqual(a.dataset.state, "bad");
  assert.ok(text(a.querySelector(".notice-meta")).startsWith("Exit 2"));
  // A finished card is not finished again.
  H.finish(ctx, a, { result: "{\"output\":\"\",\"exit_code\":0}" });
  assert.ok(text(a.querySelector(".notice-meta")).startsWith("Exit 2"));
  // A result cut short says how long the whole was.
  const c = H.mount(ctx, { key: "c2", name: "some_tool", args: {}, mem: H.memory() });
  H.finish(ctx, c, { result: "abc", size: 9000 });
  assert.ok(c.call.out.endsWith("(9000 characters in all)"), c.call.out);
  // What the log can do is in its context: Show in Activity, Run in background.
  const asked = [];
  const rich = Object.assign({}, ctx, { activity: { opens: (n) => n === "delegate_task", open: () => {} }, background: (k) => { asked.push(k); return el("div", "acts"); } });
  const t = H.mount(rich, { key: "c3", name: "terminal", args: { command: "sleep 9" }, mem: H.memory() });
  assert.deepStrictEqual(asked, ["c3"]);
  assert.ok(t.querySelector(".tool-live .acts"));
  const s = H.mount(rich, { key: "c4", name: "delegate_task", args: { goal: "x" }, mem: H.memory() });
  assert.strictEqual(text(s.querySelector(".tool-open")), "Show in Activity");
  // A log without them draws the same card otherwise.
  const plainT = H.mount(ctx, { key: "c3", name: "terminal", args: { command: "sleep 9" }, mem: H.memory() });
  assert.strictEqual(shape(plainT.querySelector(".notice-head")), shape(t.querySelector(".notice-head")));
  // A file offer and a screenshot row come from the log's context.
  const offers = [];
  const files = Object.assign({}, ctx, { fileCard: (o) => { offers.push(o.status); return el("div", "fcard"); } });
  const host = el("div");
  const f = H.mount(files, { key: "c5", name: "send_file", args: { path: "/home/alice/a.pdf" }, mem: H.memory() });
  host.append(f);
  H.finish(files, f, { result: JSON.stringify({ status: "offered", file_offer: { path: "/home/alice/a.pdf", name: "a.pdf", size: 10 } }), endedAt: 5 });
  assert.deepStrictEqual(offers, ["offered"]);
  assert.ok(host.querySelector(".file-offer .fcard"), "the file card sits after the tool card");
}

// A card with nothing more to show does not open: no chevron, a click does
// nothing. A failed card whose status cut the error opens to the whole error.
{
  const short = H.mount(ctx, { key: "f1", name: "acme_lookup", args: {}, mem: H.memory() });
  H.finish(ctx, short, { result: "{\"error\":\"No such kind\"}", is_error: true, endedAt: 5000, duration: 2 });
  // Not this one: an unknown tool keeps its result behind Raw.
  assert.ok(!short.querySelector(".notice-head").classList.contains("flat"));
  H.register({ flat_tool: (c) => ({ icon: "tool", title: "Did a thing", status: "Done" }) });
  const flat = H.mount(ctx, { key: "f2", name: "flat_tool", args: {}, mem: H.memory() });
  H.finish(ctx, flat, { result: "{\"error\":\"Permission denied\"}", endedAt: 5000, duration: 2 });
  const head = flat.querySelector(".notice-head");
  assert.ok(head.classList.contains("flat"), "nothing to open");
  assert.strictEqual(head.getAttribute("aria-expanded"), null);
  flat.view.toggle();
  assert.ok(flat.querySelector(".notice-body-wrap").hidden, "a click opens no empty body");
  assert.strictEqual(text(flat.querySelector(".notice-meta")), "Failed: Permission denied · 2.0 s", "no clock time on a card");
  const long = "x".repeat(50) + " " + "y".repeat(60);
  const cut = H.mount(ctx, { key: "f3", name: "flat_tool", args: {}, mem: H.memory() });
  H.finish(ctx, cut, { result: JSON.stringify({ error: long }) });
  assert.ok(!cut.querySelector(".notice-head").classList.contains("flat"));
  cut.view.toggle();
  assert.strictEqual(text(cut.querySelector(".notice-body .tool-q")), long, "the whole error when open");
  // A done card with nothing more is flat too, and Show in Activity opens it.
  const ok = H.mount(ctx, { key: "f4", name: "flat_tool", args: {}, mem: H.memory() });
  H.finish(ctx, ok, { result: "{}" });
  assert.ok(ok.querySelector(".notice-head").classList.contains("flat"));
  const act = Object.assign({}, ctx, { activity: { opens: () => true, open() {} } });
  const withLink = H.mount(act, { key: "f5", name: "flat_tool", args: {}, mem: H.memory() });
  H.finish(act, withLink, { result: "{}" });
  assert.ok(!withLink.querySelector(".notice-head").classList.contains("flat"));
}

// A link part is an anchor to a web page, in a new tab; any other address
// is plain text.
{
  H.register({ link_tool: () => ({ title: "Linked", status: "Done", blocks: [{ label: "Results", kind: "list", items: [
    { parts: [{ link: "https://go.dev/doc", text: "Go docs" }] }, { parts: ["go.dev"], dim: true },
    { parts: [{ link: "javascript:alert(1)", text: "bad" }], gap: true }] }] }) });
  const v = H.create(ctx, { name: "link_tool", done: true, failed: false, args: {}, res: null, out: "", mem: H.memory() });
  v.toggle();
  const a = v.node.querySelector(".tool-list a");
  assert.strictEqual(a.className, "tlink");
  assert.strictEqual(a.href, "https://go.dev/doc");
  assert.strictEqual(a.target, "_blank");
  assert.strictEqual(a.rel, "noopener noreferrer nofollow");
  const rows = v.node.querySelectorAll(".tool-list .tool-li");
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[2].querySelector("a"), null, "no link to a script address");
  assert.ok(rows[2].classList.contains("gap"));
}

// A long block can start folded: closed under its label, opened by a tap.
{
  H.register({ fold_tool: () => ({ title: "Folded", status: "Done", blocks: [{ label: "Page text", text: "long text", fold: true }] }) });
  const v = H.create(ctx, { name: "fold_tool", done: true, failed: false, args: {}, res: null, out: "", mem: H.memory() });
  v.toggle();
  const d = v.node.querySelector("details.tool-fold");
  assert.ok(d, "a folded block");
  assert.ok(!d.open, "starts closed");
  assert.strictEqual(text(d.querySelector("summary")), "Page text");
  assert.strictEqual(text(d.querySelector("pre")), "long text");
  // A title may wrap to a second line.
  H.register({ wrap_tool: () => ({ title: "A long title", titleWrap: true, status: "Done" }) });
  const w = H.create(ctx, { name: "wrap_tool", done: true, failed: false, args: {}, res: null, out: "", mem: H.memory() });
  assert.ok(w.node.querySelector(".notice-title").classList.contains("wrap"));
}

// A log without Show in Activity (the subagent steps are in Activity) draws
// no such link.
{
  const inAct = Object.assign({}, ctx, { activity: null });
  const s = H.mount(inAct, { key: "x9", name: "delegate_task", args: { goal: "x" }, mem: H.memory() });
  assert.strictEqual(s.querySelector(".tool-open"), null);
}

// A diff shows its lines, not the file and hunk headers.
{
  const d = H.diffLines("--- a/x.go\n+++ b/x.go\n@@ -1 +1,3 @@\n-\treturn nil\n+\tif err != nil {\n ctx\n@@ -9 +11 @@\n-a\n+b\n");
  assert.deepStrictEqual([...d].map((l) => l.kind + ":" + l.text), ["del:-\treturn nil", "add:+\tif err != nil {", ": ctx", "hunk:⋯", "del:-a", "add:+b"]);
  assert.deepStrictEqual([...H.diffLines("\n+ note")].map((l) => l.kind), ["add"]);
  assert.deepStrictEqual([...H.diffLines("\x1b[1ma/x.go → b/x.go\x1b[0m\n\x1b[32m+new\x1b[0m")].map((l) => l.text), ["+new"]);
}

// The model's answer about an image: the first block of thinking or reply
// after a vision call, shown on its card.
{
  const ctxV = Object.assign({}, ctx, { zoom() {}, image: () => "" });
  const ans = H.answers();
  const node = H.mount(ctxV, { key: "v1", name: "vision_analyze", args: { image_url: "/home/alice/q3.png", question: "Which quarter peaks?" }, mem: H.memory() });
  H.finish(ctxV, node, { result: "{\"success\":true,\"analysis\":\"Image loaded into your context\"}" });
  ans.tool(node);
  ans.text("think", "Q4 peaks at about 1.8 million,", true);
  ans.text("think", " up from 1.2 million in Q3.\nNext I will reply.", true);
  ans.text("say", "Q4 peaks.", true);
  assert.strictEqual(node.call.answer, "Q4 peaks at about 1.8 million, up from 1.2 million in Q3.\nNext I will reply.");
  assert.strictEqual(text(node.querySelector(".vis-q .qt")), "Q4 peaks at about 1.8 million, up from 1.2 million in Q3.");
  assert.strictEqual(text(node.querySelector(".vis-q .vis-ask")), "Which quarter peaks?");
  node.view.toggle();
  assert.ok(text(node.querySelector(".vis-sec .vis-answer")).includes("Next I will reply."));
}

// Shaped like stored rows: a vision call and its result, then what the model
// does next. look(n, key) mounts and finishes a vision card.
{
  const ctxV = Object.assign({}, ctx, { zoom() {}, image: () => "" });
  const look = (ans, key, path, q) => {
    ans.start();
    const n = H.mount(ctxV, { key, name: "vision_analyze", args: { image_url: path, question: q }, mem: H.memory() });
    H.finish(ctxV, n, { result: "{\"success\":true,\"analysis\":\"Image loaded into your context\"}" });
    ans.tool(n);
    return n;
  };
  const other = (ans, key) => {
    ans.start();
    return H.mount(ctxV, { key, name: "terminal", args: { command: "ls" }, mem: H.memory() });
  };
  const sub = (n) => text(n.querySelector(".tool-lines"));

  // Thinking, then a tool call: the thinking is the answer.
  {
    const ans = H.answers();
    const n = look(ans, "a1", "/home/alice/a.png", "What is the job name?");
    ans.step();
    ans.text("think", "The job is nightly-backup and it failed.", true);
    other(ans, "t1");
    ans.text("think", "Second step thinking must not land on the card.", true);
    assert.strictEqual(n.call.answer, "The job is nightly-backup and it failed.");
    assert.strictEqual(text(n.querySelector(".vis-q .qt")), "The job is nightly-backup and it failed.");
    assert.strictEqual(text(n.querySelector(".vis-q .vis-ask")), "What is the job name?");
  }
  // A tool call straight after the result, then thinking: still its answer.
  {
    const ans = H.answers();
    const n = look(ans, "a2", "/home/alice/b.png", "q");
    ans.step();
    other(ans, "t2");
    ans.text("think", "It is a bar chart.", true);
    assert.strictEqual(n.call.answer, "It is a bar chart.");
  }
  // Reply text, then a tool call.
  {
    const ans = H.answers();
    const n = look(ans, "a3", "/home/alice/c.png", "q");
    ans.step();
    ans.text("say", "Looks like a login page.", false);
    other(ans, "t3");
    assert.strictEqual(n.call.answer, "Looks like a login page.");
  }
  // Nothing at all: no answer, and the question is the subtitle, not a block
  // that waits.
  {
    const ans = H.answers();
    const n = look(ans, "a4", "/home/alice/d.png", "Quote all visible text");
    ans.step();
    other(ans, "t4");
    ans.step();
    ans.text("think", "Thinking of a later step is not its answer.", true);
    assert.strictEqual(n.call.answer, undefined);
    assert.strictEqual(sub(n), "Quote all visible text");
    assert.strictEqual(n.querySelector(".vis-q .qt"), null);
    assert.strictEqual(n.querySelector(".vis-path"), null);
    n.view.toggle();
    const labels = [...n.querySelectorAll(".vis-sec b")].map((b) => text(b));
    assert.deepStrictEqual(labels, ["Question"]);
    assert.ok(!text(n).includes("/home/alice"), "no folder or path under the chip");
  }
  // The step after the call brings nothing and the next brings thinking: that
  // thinking belongs to the later call only.
  {
    const ans = H.answers();
    const a = look(ans, "d1", "/home/alice/k.png", "first?");
    ans.step();
    const b = look(ans, "d2", "/home/alice/l.png", "second?");
    ans.step();
    ans.text("think", "Only the second matters.", true);
    assert.strictEqual(a.call.answer, undefined);
    assert.strictEqual(b.call.answer, "Only the second matters.");
  }
  // A new turn ends the wait.
  {
    const ans = H.answers();
    const n = look(ans, "a5", "/home/alice/e.png", "q");
    ans.end();
    ans.text("say", "unrelated", false);
    assert.strictEqual(n.call.answer, undefined);
  }
  // Two images in one step share the block that follows; one looked at in the
  // next step gets that step's own thinking.
  {
    const ans = H.answers();
    const a = look(ans, "b1", "/home/alice/f.png", "left?");
    const b = look(ans, "b2", "/home/alice/g.png", "right?");
    ans.step();
    ans.text("think", "Both show the same chart.", true);
    other(ans, "t5");
    const c = look(ans, "b3", "/home/alice/h.png", "third?");
    ans.step();
    ans.text("think", "The third is a table.", true);
    assert.strictEqual(a.call.answer, "Both show the same chart.");
    assert.strictEqual(b.call.answer, "Both show the same chart.");
    assert.strictEqual(c.call.answer, "The third is a table.");
  }
  // Sequential: each image gets the thinking right after its own call.
  {
    const ans = H.answers();
    const a = look(ans, "c1", "/home/alice/i.png", "q1");
    ans.step();
    ans.text("think", "First is red.", true);
    const b = look(ans, "c2", "/home/alice/j.png", "q2");
    ans.step();
    ans.text("think", "Second is blue.", true);
    assert.strictEqual(a.call.answer, "First is red.");
    assert.strictEqual(b.call.answer, "Second is blue.");
  }
}
console.log("ok");
