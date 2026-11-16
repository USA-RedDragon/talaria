"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const path = require("path");
const [script, cases, peer] = process.argv.slice(2);
// load runs toolcard.js and the card modules beside it (static/cards) in ctx.
const cardDir = path.join(path.dirname(script), "cards");
const load = (ctx) => {
  vm.runInNewContext(fs.readFileSync(script, "utf8"), ctx);
  for (const f of fs.readdirSync(cardDir).filter((x) => x.endsWith(".js")).sort()) vm.runInNewContext(fs.readFileSync(path.join(cardDir, f), "utf8"), ctx);
};
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(peer, "utf8"), sandbox);
load(sandbox);
const { derive, memory } = sandbox.window.HubToolCard;
for (const c of JSON.parse(fs.readFileSync(cases, "utf8"))) {
  const mem = memory();
  for (const l of c.learn || []) mem.learn(l.name, l.args, l.res);
  const call = Object.assign({ done: true, failed: false, out: "", mem }, c.call);
  if (call.res === undefined) call.res = null;
  const got = derive(call);
  const seen = { icon: got.icon, title: got.title, status: got.status, state: got.state };
  if (c.want.page !== undefined) seen.page = got.page || null;
  if (c.want.vision !== undefined) seen.vision = got.vision || null;
  if (c.blocks) seen.blocks = got.blocks.map((b) => b.label);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), c.want, c.name);
}

// A batch refused before any step: the body has the whole error and the steps
// the agent asked for, from the call's arguments, never empty.
{
  const err = "step 2 (click): give ref (from the last snapshot) or name (the element's label on the page), and then some more words to be sure it is longer than the status line";
  const d = derive({ name: "browser_batch", done: true, failed: true, out: "", mem: memory(), args: { steps: [{ action: "navigate", url: "https://a.example/x" }, { action: "click", role: "button" }, { action: "type", name: "Email", text: "secret" }, { action: "press", key: "Enter" }] }, res: { error: err } });
  const got = JSON.parse(JSON.stringify(d.blocks));
  assert.strictEqual(got[0].text, err);
  assert.deepStrictEqual(got[1].items.map((x) => x.text + "|" + x.state), ["Open a.example|not_run", "Click the button|failed", "Type into \"Email\"|not_run", "Press Enter|not_run"]);
  assert.ok(!JSON.stringify(got).includes("secret"), "typed text is never shown");
  assert.strictEqual(d.title, "Browser steps not run: 4");
}

const { wrapped, take } = sandbox.window.HubToolCard;
const batch = wrapped("tool_call", { calls: [{ name: "process_manage", arguments: { action: "kill" } }, { name: "process_manage", arguments: { action: "list" } }, { name: "terminal", arguments: { command: "ls" } }, 5] });
assert.strictEqual(batch.length, 3);
assert.deepStrictEqual(JSON.parse(JSON.stringify(take(batch, "process_manage"))), { name: "process_manage", args: { action: "kill" } });
assert.deepStrictEqual(JSON.parse(JSON.stringify(take(batch, "process_manage"))), { name: "process_manage", args: { action: "list" } });
assert.strictEqual(take(batch, "process_manage"), null);
assert.strictEqual(wrapped("terminal", { calls: [] }), null);
assert.strictEqual(wrapped("tool_call", "x"), null);

// The status line under a running subagent: a plain sentence and an icon, in
// the words of the cards, never the raw text.
{
  const { statusLine } = sandbox.window.HubToolCard;
  const mem = memory();
  mem.learn("terminal", { command: "npm test", background: true }, { session_id: "proc_283637f9d51" });
  const say = (n, p, m) => { const l = statusLine(n, p, m); return l.icon + "|" + l.text; };
  assert.strictEqual(say("process_manage", "wait proc_283637f9d51 180s"), "clock|Waiting on a background command");
  assert.strictEqual(say("process_manage", "wait proc_283637f9d51 180s", mem), "clock|Waiting on background command npm test");
  assert.strictEqual(say("process_manage", "kill proc_283637f9d51", mem), "stop|Stopping background command npm test");
  assert.strictEqual(say("process_manage", "list"), "list|Listing background commands");
  assert.strictEqual(say("terminal", "npm test"), "terminal|Running npm test");
  assert.strictEqual(say("read_file", "/srv/app/hub/web/static/app.js"), "file|Reading app.js");
  assert.strictEqual(say("session_search", "dns split horizon"), "search|Searching past chats for dns split horizon");
  assert.strictEqual(say("browser_vault", "list"), "key|Looking for a saved login");
  assert.strictEqual(say("mcp_device_call", "github.create_issue"), "plug|Calling github.create_issue on your computer");
  assert.strictEqual(say("tool_call", "3 calls"), "tool|Running 3 tools");
  assert.strictEqual(say("todo_list", ""), "checkcircle|Updating the to-do list");
  assert.strictEqual(say("tool_search", "gmail"), "search|Looking up a tool");
  assert.strictEqual(say("browser_navigate", "https://example.com/a"), "globe|Opening example.com");
  assert.strictEqual(say("some_new_tool", "{...}"), "tool|Using some new tool");
  // A batch is a sentence, with or without Hermes's emoji and a tool name.
  assert.strictEqual(say("tool_call", "[set 5] terminal, terminal, process_manage"), "tool|Running 5 tools: terminal, process_manage");
  assert.strictEqual(say("", "\u{1F500} [set 5] terminal, terminal, process_manage"), "tool|Running 5 tools: terminal, process_manage");
  assert.strictEqual(say("tool_call", "\u{1F500} [set 2] read_file, read_file"), "tool|Running 2 tools: read_file");
  // An unknown tool with an emoji is never printed raw.
  assert.strictEqual(say("\u{1F9EA} brand_new_tool", "\u2705 {...}"), "tool|Using brand new tool");
  assert.strictEqual(say("\u{1F9EA}", "x"), "tool|Working");
  const pict = /\p{Extended_Pictographic}|\uFE0F/u;
  for (const [n, p] of [["delegate_task", "\u{1F500} go"], ["terminal", "\u{1F4BB} ls"], ["web_search", "\u{1F50E} cats"], ["browser_navigate", "\u{1F310} https://a.com/"], ["x\u{1F680}y", "\u2699\uFE0F"]]) {
    assert.ok(!pict.test(say(n, p)), say(n, p));
  }
  assert.strictEqual(say("", ""), "tool|Working");
  // Whatever the tool, the raw preview is not the sentence.
  assert.ok(!say("some_new_tool", "{...}").includes("{...}"));
}
// A wait that did not finish says how long it really waited (the card's own
// duration, not the timeout it asked for) and is not a success.
{
  const wait = (extra) => derive(Object.assign({ name: "process_manage", args: { action: "wait", session_id: "proc_1", timeout: 3600 }, res: { status: "running" }, done: true, failed: false }, extra));
  const d = wait({ duration: 181 });
  assert.strictEqual(d.status, "Still running");
  assert.ok(d.idle, "an unfinished wait is not colored as success");
  assert.strictEqual(wait({ duration: 12 }).status, "Still running");
  assert.strictEqual(wait({ duration: 3720 }).status, "Still running");
  assert.strictEqual(wait({}).status, "Still running");
  assert.ok(!/1800|3600/.test(wait({ duration: 180 }).status));
  const pict = /\p{Extended_Pictographic}|\uFE0F/u;
  const e = derive({ name: "\u{1F500}delegate_task", args: { goal: "x" }, done: true, failed: false });
  assert.ok(!pict.test(e.title + e.status), e.title);
}
// The vault's call is shown with its secrets hidden, and its output not at all.
{
  const d = derive({ name: "browser_vault", args: { action: "fill", password: "hunter2", url: "https://x.com" }, res: { password: "hunter2" }, out: "hunter2", done: true, failed: false });
  assert.ok(!JSON.stringify(d.blocks).includes("hunter2"), JSON.stringify(d.blocks));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.blocks.map((b) => b.label))), ["Call"]);
}

// A live tool_call (the stream sends one start and one end for all of its
// calls) draws a card for each call, not one wrench, and splits its result.
{
  const { calls, split } = sandbox.window.HubToolCard;
  const got = JSON.parse(JSON.stringify(calls("t9", "tool_call", { calls: [{ name: "terminal", arguments: { command: "ls" } }, { name: "session_search", arguments: { query: "x" } }] })));
  assert.deepStrictEqual(got, [
    { key: "t9:0", name: "terminal", args: { command: "ls" }, batch: "t9" },
    { key: "t9:1", name: "session_search", args: { query: "x" }, batch: "t9" },
  ]);
  assert.strictEqual(calls("t9", "tool_call", { calls: [{ name: "terminal", arguments: {} }] })[0].batch, "");
  assert.strictEqual(calls("t9", "terminal", { command: "ls" }), null);
  assert.strictEqual(calls("t9", "tool_call", { calls: [] }), null);
  assert.strictEqual(JSON.stringify(split('[{"a":1},{"b":2}]', 2)), '[{"a":1},{"b":2}]');
  assert.strictEqual(JSON.stringify(split({ results: [1, 2, 3] }, 3)), "[1,2,3]");
  assert.strictEqual(split("[1]", 2), null);
  assert.strictEqual(split("not json", 2), null);
  assert.strictEqual(split(undefined, 2), null);
}

// A card builds its output blocks when it first opens, and asks for the rest
// of a cut output once, as it opens.
(async () => {
  const { el } = require("../fakedom.js");
  const box = { window: { HubIcons: { icon: () => el("span"), button: () => el("button") } } };
  load(box);
  const asked = [];
  const call = { name: "terminal", args: { command: "make" }, res: null, out: "start of it\u2026", done: true, failed: false, partial: { row: 7, call: "c1", size: 90000 }, mem: box.window.HubToolCard.memory() };
  const view = box.window.HubToolCard.create({ el, toast() {}, diff: () => el("pre"), more: (c) => { asked.push(c.partial.row); } }, call);
  const body = view.node.querySelector(".notice-body");
  assert.strictEqual(body.children.length, 0, "a closed card builds no blocks");
  view.toggle();
  assert.ok(body.children.length > 0, "an opened card has its blocks");
  assert.deepStrictEqual(asked, [7], "the cut output is asked for once, as the card opens");
  view.toggle();
  view.toggle();
  assert.strictEqual(asked.length, 1, "not asked again while the first request runs");
  await new Promise((r) => setTimeout(r, 5));
  view.toggle();
  view.toggle();
  assert.strictEqual(asked.length, 2, "asked again while the call is still cut (the page clears it when it arrives)");
  if (view.node.querySelector(".notice-head").getAttribute("aria-expanded") !== "true") view.toggle();
  view.update(Object.assign({}, call, { out: "all of it", partial: null }));
  assert.ok(view.node.querySelectorAll(".tool-box").pop().textContent.includes("all of it"), "an opened card redraws with the full output");
  view.toggle();
  assert.strictEqual(view.node.querySelector(".notice-head").getAttribute("aria-expanded"), "false");
  view.update(Object.assign({}, call, { out: "changed", partial: null }));
  assert.strictEqual(body.children.length, 0, "a closed card drops its blocks on an update and builds them again on opening");
})().catch((e) => { console.error(e); process.exit(1); });

// The command or code in a title is its own monospace element; the leading
// words stay plain text. The title string itself is unchanged.
{
  const { drawTitle, statusLine } = sandbox.window.HubToolCard;
  const el = (tag, cls, text) => ({ tag, cls: cls || "", kids: [], textContent: text || "" });
  const node = el("span", "notice-title");
  node.replaceChildren = (...k) => { node.kids = k; };
  const mem = memory();
  mem.learn("terminal", { command: "npm test", background: true }, { session_id: "proc_283637f9d51" });
  const draw = (call) => {
    const d = derive(Object.assign({ done: true, failed: false, out: "", mem, res: null }, call));
    drawTitle(el, node, d);
    return { d, kids: node.kids.slice() };
  };
  const split = (call, lead, code, title) => {
    const { d, kids } = draw(call);
    assert.strictEqual(d.title, title, "the title text is as it was: " + d.title);
    assert.strictEqual(kids.length, 2, title + ": a lead and a code element");
    assert.strictEqual(kids[0], lead, title + ": lead");
    assert.strictEqual(kids[1].tag, "code");
    assert.strictEqual(kids[1].cls, "tcode");
    assert.strictEqual(kids[1].textContent, code, title + ": code");
  };
  split({ name: "terminal", args: { command: "ls -la /usr/bin/zig; file /usr/bin/zig" }, res: { exit_code: 0 } }, "Ran ", "ls -la /usr/bin/zig; file /usr/bin/zig", "Ran ls -la /usr/bin/zig; file /usr/bin/zig");
  split({ name: "terminal", args: { command: "sleep 60" }, done: false }, "Running ", "sleep 60", "Running sleep 60");
  split({ name: "terminal", args: { command: "make -j8", background: true }, res: { session_id: "proc_1" } }, "Started in the background: ", "make -j8", "Started in the background: make -j8");
  split({ name: "execute_code", args: { code: "import json\nprint(1)" }, res: { output: "1" } }, "Ran Python ", "print(1)", "Ran Python print(1)");
  split({ name: "process_manage", args: { action: "wait", session_id: "proc_283637f9d51" }, res: { status: "exited", exit_code: 0 } }, "Waited for background command ", "npm test", "Waited for background command npm test");
  split({ name: "process_manage", args: { action: "kill", session_id: "proc_283637f9d51" }, res: { status: "killed" } }, "Stopped background command ", "npm test", "Stopped background command npm test");
  // Titles with no command stay one plain string.
  for (const call of [{ name: "process_manage", args: { action: "list" } }, { name: "terminal", args: {} }]) {
    const { kids } = draw(call);
    assert.strictEqual(kids.length, 1, call.name + ": no code element");
    assert.strictEqual(typeof kids[0], "string");
  }
  // The status line under a subagent, in the Activity panel.
  const l = statusLine("terminal", "npm test", mem);
  assert.deepStrictEqual([l.text, l.code], ["Running npm test", "npm test"]);
  const w = statusLine("process_manage", "wait proc_283637f9d51 180s", mem);
  assert.deepStrictEqual([w.text, w.code], ["Waiting on background command npm test", "npm test"]);
  assert.strictEqual(statusLine("process_manage", "list", mem).code, "");
  assert.strictEqual(statusLine("read_file", "/a/b.go", mem).code, "");
}
