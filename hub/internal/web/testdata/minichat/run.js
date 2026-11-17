"use strict";
// The subagent's steps as a small chat: the pure parts of minichat.js and
// toolgroup.js, then a view drawn into a small fake DOM: what it shows, how
// calls fold into the chat's groups, when it follows new steps and when
// the pill counts them, and the state of the messages the user sent.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const { el, document } = require("../fakedom.js");
const chatEnv = require("../chatenv.js");
const sandbox = chatEnv.sandbox(document);
sandbox.window.HubIcons = { icon: (name) => el("svg", "ico i-" + name), button: (name, label, cls) => el("button", cls) };
vm.createContext(sandbox);
for (const f of process.argv.slice(2)) vm.runInContext(fs.readFileSync(f, "utf8"), sandbox);
const { HubMiniChat: M, HubToolGroup: G } = sandbox.window;
// create builds a subagent's view with the chat view of a chat.
const env = chatEnv(el);
const create = (o) => M.create(Object.assign({ el, chat: { env, base: "/api/sessions/pc/s1", cards: null } }, o));

const T0 = Date.UTC(2026, 10, 12, 22, 0, 0);
const iso = (s) => new Date(T0 + s * 1000).toISOString();
let seq = 0;
const ev = (o) => Object.assign({ seq: ++seq }, o, { ts: iso(o.at) });

// Pure parts.
{
  const box = { scrollHeight: 1000, clientHeight: 200, scrollTop: 760 };
  assert.ok(M.near(box));
  box.scrollTop = 700;
  assert.ok(!M.near(box));
}
{
  const a = ev({ type: "message", at: 5 });
  const b = ev({ type: "steer", at: 2 });
  assert.deepStrictEqual(M.order([a, b]).map((e) => e.seq), [b.seq, a.seq]);
  const steer = ev({ type: "steer", at: 10 });
  assert.strictEqual(M.steerState(steer, [steer], false), "waits");
  assert.strictEqual(M.steerState(steer, [steer, ev({ type: "tool_end", at: 9 })], false), "waits");
  assert.strictEqual(M.steerState(steer, [steer, ev({ type: "tool_end", at: 11 })], false), "read");
  assert.strictEqual(M.steerState(steer, [steer, ev({ type: "message", at: 12 })], true), "missed");
  assert.strictEqual(M.end({ state: "ok", durationS: 1300, result: "Added it." }).head, "Done in 21 min 40 s");
  assert.strictEqual(M.end({ state: "bad", durationS: 723 }).head, "Failed after 12 min 3 s");
  assert.ok(M.end({ state: "bad" }).bad && !M.end({ state: "ok" }).bad);
}
// The group line uses the chat's words and total time.
{
  const card = (toolName, duration, failed) => ({ toolName, duration, failed, call: {} });
  const s = G.summary([card("terminal", 12.4), card("read_file", 0.1), card("terminal", 100.3, true)]);
  assert.strictEqual(s.text, "Ran 2 commands, read a file (1 min 53 s)");
  assert.strictEqual(s.failed, 1);
  assert.strictEqual(G.summary([card("browser_click"), card("my_tool")]).text, "Used the browser, used my tool");
}

// The view: the chat's own log (chatview.js) in a box, with the chat's jump button under it.
const v = create();
const box = v.log;
assert.ok(v.node.classList.contains("mc") && box.classList.contains("log"));
const kidsOf = (b) => b.children.map((n) => n.className.split(" ")[0] + (n.classList.contains("running") ? ".running" : ""));
const kids = () => kidsOf(box).filter((k) => k !== "when");
v.set({ model: "claude-opus-5-5" });
v.add([
  ev({ type: "goal", text: "Count the rows", at: 0 }),
  ev({ type: "thinking", text: "I need the log.", at: 1 }),
  ev({ type: "message", text: "I'll capture the screen.", at: 2 }),
  ev({ type: "tool_start", call_id: "c1", name: "terminal", args: { command: "hermes model > pick.log" }, at: 2 }),
  ev({ type: "tool_end", call_id: "c1", name: "terminal", result: '{"output": "", "exit_code": 0}', result_size: 30, duration_ms: 2500, at: 5 }),
  ev({ type: "tool_start", call_id: "c2", name: "read_file", args: { path: "a.py" }, at: 6 }),
  ev({ type: "tool_end", call_id: "c2", name: "read_file", result: "def clean(buf): ...", result_size: 9000, at: 6.1 }),
  ev({ type: "message", text: "The filter keeps duplicates.", at: 7 }),
  ev({ type: "tool_start", call_id: "c3", name: "terminal", args: { command: "grep -c x pick.log" }, at: 8 }),
  ev({ type: "tool_end", call_id: "c3", name: "terminal", result: '{"output": "0", "exit_code": 1}', result_size: 31, duration_ms: 100300, at: 108 }),
  ev({ type: "tool_start", call_id: "c4", name: "terminal", args: { command: "sed -i s/a/b/ x" }, at: 109 }),
]);
// The brief opens the chat, in full, then the start time and model.
assert.ok(box.children[0].classList.contains("mc-brief"));
assert.strictEqual(box.children[0].querySelector(".mc-brief-text").textContent, "Count the rows");
assert.strictEqual(box.children[0].querySelector(".mc-brief-more"), null);
assert.ok(box.children[1].textContent.startsWith("Started"), box.textContent);
assert.ok(box.children[1].textContent.endsWith(" · claude-opus-5-5"));
// Thinking and replies are the chat's: a closed thinking block, reply
// bubbles with their time under them.
const think = box.querySelector("details.reasoning");
assert.strictEqual(think.querySelector(".body").textContent, "I need the log.");
assert.strictEqual(think.firstChild.textContent, "Thinking");
assert.ok(!think.open);
assert.ok(box.querySelector(".msg.assistant").nextElementSibling.classList.contains("when"));
// Finished calls before newer text fold into a group with the chat's
// words; the newest calls of a running subagent stay open as cards, the
// failed one red, the running one running.
assert.deepStrictEqual(kids(), ["mc-brief", "note", "reasoning", "msg", "toolgroup", "msg", "tool", "tool.running"]);
const group = box.querySelector("details.toolgroup");
assert.strictEqual(group.firstChild.textContent.split(" \u00B7 ")[0], "Ran a command, read a file (2.6 s)");
assert.strictEqual(group.querySelectorAll(".tool").length, 2);
const failed = box.querySelectorAll(".tool").filter((c) => c.parentNode === box)[0];
assert.ok(failed.classList.contains("failed"), failed.className);
assert.strictEqual(failed.dataset.state, "bad");
// A cut result says how long it was.
const readCard = group.querySelectorAll(".tool")[1];
assert.ok(readCard.call.out.endsWith("(9000 characters in all)"), readCard.call.out);
// It started at the end, so it follows (the page keeps a followed log at its end, HubStick).
assert.ok(v.pinned());
const jump = v.node.querySelector(".tobottom");
assert.ok(jump.hidden);

// The running call ends and a reply comes: the reader at the end follows.
v.add([ev({ type: "tool_end", call_id: "c4", name: "terminal", result: '{"output": "", "exit_code": 0}', duration_ms: 400, at: 110 }),
  ev({ type: "message", text: "Done with the filter.", at: 111 })]);
assert.deepStrictEqual(kids(), ["mc-brief", "note", "reasoning", "msg", "toolgroup", "msg", "toolgroup", "msg"]);
const g2 = box.querySelectorAll("details.toolgroup")[1];
assert.match(g2.firstChild.textContent, /^Ran 2 commands \(1 min 41 s\)/);
assert.match(g2.textContent, /1 step failed/);
assert.ok(v.pinned());

// Scrolled up, new messages stay below and the chat's jump button counts them.
box.scrollTop = 0;
v.chat.scroll.heard(1000);
v.chat.scroll.scrolled();
assert.ok(!v.pinned());
v.add([ev({ type: "message", text: "Row count is 14.", at: 120 }), ev({ type: "tool_start", call_id: "c5", name: "terminal", args: { command: "wc -l" }, at: 121 })]);
assert.strictEqual(box.scrollTop, 0);
assert.ok(!jump.hidden);
assert.strictEqual(jump.querySelector(".lbl").textContent, "1 new message");
// The button takes the reader there.
jump.dispatch("click");
assert.ok(jump.hidden);
assert.ok(v.pinned());
assert.ok(v.pinned());
v.add([ev({ type: "tool_end", call_id: "c5", name: "terminal", result: '{"output": "14", "exit_code": 0}', at: 122 })]);

// A message the user sent shows as the chat's pending bubble: it waits for
// the subagent's next step, and reads as read once a tool result comes after it.
v.add([ev({ type: "steer", text: "Also print the count.", at: 140 })]);
const steerLine = () => box.querySelectorAll(".queued").pop().textContent;
const mine = () => box.querySelectorAll(".msg.user").pop();
assert.match(steerLine(), / · waits for its next step$/);
assert.ok(mine().classList.contains("pending"));
v.add([ev({ type: "tool_start", call_id: "c6", name: "terminal", args: { command: "echo 14" }, at: 141 }),
  ev({ type: "tool_end", call_id: "c6", name: "terminal", result: '{"output": "14", "exit_code": 0}', at: 142 })]);
assert.match(steerLine(), / · read by the subagent$/);
assert.ok(!mine().classList.contains("pending"));
// One sent after the last step, then the subagent ends: never read.
v.add([ev({ type: "steer", text: "Stop soon.", at: 150 })]);
v.set({ model: "claude-opus-5-5", end: { state: "ok", durationS: 1300, result: "Added the flag.", tokens: "3.1k in · 920 out", endedAt: T0 + 160000 } });
assert.match(steerLine(), / · the subagent ended before reading it$/);
// Ended: every call is folded, and the Done card closes the chat.
assert.strictEqual(box.querySelectorAll(".tool").filter((c) => c.parentNode === box).length, 0);
const endCard = box.lastElementChild;
assert.ok(endCard.classList.contains("mc-end") && !endCard.classList.contains("bad"));
assert.match(endCard.textContent, /^Done in 21 min 40 s/);
assert.match(endCard.textContent, /Added the flag\.\n3\.1k in · 920 out/);

// A failed end is red.
v.set({ end: { state: "bad", durationS: 723, result: "Timed out." } });
assert.ok(box.querySelector(".mc-end").classList.contains("bad"));
assert.match(box.querySelector(".mc-end").textContent, /^Failed after 12 min 3 s/);
// Reset clears it all for a transcript Hermes rewrote; the end card stays.
v.reset();
assert.deepStrictEqual(kids(), ["mc-end"]);

// A notice Hermes put into the subagent's transcript is the chat's notice
// card, not its raw text.
{
  const w = create();
  w.add([ev({ type: "goal", text: "Do it", at: 0 }),
    ev({ type: "user", text: "A process you were waiting on finished. Continue your task with its result.\n\n`OLD=$(kubectl get pods -A)` (proc_3f2a9c1d0b) exited with code 0 (exited).\nOutput tail:\nNAME READY", at: 3 })]);
  const card = w.log.querySelector(".notice");
  assert.ok(card, w.log.textContent);
  assert.ok(!w.log.querySelector(".msg.user"), "no bubble: " + w.log.textContent);
}

// A tool_call carries several calls. The small chat draws each as the card of
// its tool (not one wrench), keys each result to its own call (the results all
// carry the wrapper's call id and must not overwrite one another), and the
// cards fold with their neighbors like any others.
{
  const w = create();
  const b = w.log;
  const titles = () => b.querySelectorAll(".notice-title").map((n) => n.textContent);
  const wrapperArgs = { calls: [
    { name: "process_manage", arguments: { action: "wait", session_id: "proc_283637f9d51", timeout: 180 } },
    { name: "session_search", arguments: { query: "dns split horizon" } },
    { name: "browser_vault", arguments: { action: "list", url: "https://github.com" } },
  ] };
  w.set({ model: "m" });
  w.add([ev({ type: "tool_start", call_id: "w1", name: "tool_call", args: wrapperArgs, at: 10 })]);
  assert.deepStrictEqual(titles(), ["Waiting for background command", "Searching past chats for “dns split horizon”", "Looking for a saved login on github.com"]);
  assert.strictEqual(b.querySelectorAll(".tool").length, 3);
  assert.ok(b.querySelectorAll(".tool").every((c) => c.classList.contains("running")));
  // One result row per inner call, all under the wrapper's id, out of order.
  w.add([ev({ type: "tool_end", call_id: "w1", name: "session_search", result: '{"results": [1, 2, 3, 4]}', duration_ms: 320, at: 11 })]);
  assert.strictEqual(b.querySelectorAll(".tool").filter((c) => c.classList.contains("running")).length, 2);
  w.add([ev({ type: "tool_end", call_id: "w1", name: "process_manage", result: '{"status": "running"}', duration_ms: 180000, at: 190 }),
    ev({ type: "tool_end", call_id: "w1", name: "browser_vault", result: '{"logins": [{}]}', duration_ms: 88, at: 190 })]);
  const cards = b.querySelectorAll(".tool");
  assert.ok(cards.every((c) => !c.classList.contains("running") && c.finished), "every inner call finished");
  assert.deepStrictEqual(cards.map((c) => c.call.res && Object.keys(c.call.res)[0]), ["status", "results", "logins"]);
  assert.deepStrictEqual(titles(), ["Waited for background command", "Searched past chats for “dns split horizon”", "Looked for a saved login on github.com"]);
  assert.deepStrictEqual(cards.map((c) => c.dataset.ukey), ["t:w1:0", "t:w1:1", "t:w1:2"]);
  // The batch ran together: the fold shows the real time from the first
  // start to the last end, not the 3 min 0.4 s the three times add up to.
  w.set({ model: "m", end: { state: "ok", durationS: 190, result: "Done." } });
  const g = b.querySelectorAll("details.toolgroup");
  assert.strictEqual(g.length, 1, "the calls fold into one group");
  const line = g[0].firstChild.textContent.split(" \u00B7 ")[0];
  assert.match(line, /^Managed a background command, searched past chats, used a saved login \(3 min\)$/, line);

  // A result that names no tool goes to the first call that has none.
  const w2 = create();
  w2.add([ev({ type: "tool_start", call_id: "w2", name: "tool_call", args: { calls: [{ name: "terminal", arguments: { command: "a" } }, { name: "terminal", arguments: { command: "b" } }] }, at: 1 }),
    ev({ type: "tool_end", call_id: "w2", name: "tool_call", result: '{"output": "A", "exit_code": 0}', at: 2 }),
    ev({ type: "tool_end", call_id: "w2", name: "terminal", result: '{"output": "B", "exit_code": 0}', at: 3 })]);
  assert.deepStrictEqual(w2.log.querySelectorAll(".tool").map((c) => c.call.out), ["A", "B"]);
  // The same results again change nothing.
  w2.add([ev({ type: "tool_end", call_id: "w2", name: "terminal", result: '{"output": "C", "exit_code": 0}', at: 4 })]);
  assert.deepStrictEqual(w2.log.querySelectorAll(".tool").map((c) => c.call.out), ["A", "B"]);

  // One call in the wrapper is a plain card, no batch.
  const w3 = create();
  w3.add([ev({ type: "tool_start", call_id: "w3", name: "tool_call", args: { calls: [{ name: "terminal", arguments: { command: "ls" } }] }, at: 1 }),
    ev({ type: "tool_end", call_id: "w3", name: "terminal", result: '{"output": "", "exit_code": 0}', duration_ms: 1500, at: 3 })]);
  assert.strictEqual(w3.log.querySelectorAll(".tool").length, 1);
  assert.strictEqual(w3.log.querySelector(".tool").batch, "");
  assert.deepStrictEqual(w3.log.querySelectorAll(".notice-title").map((n) => n.textContent), ["Ran ls"]);
  w3.set({ end: { state: "ok" } });
  assert.match(w3.log.querySelector("details.toolgroup").firstChild.textContent, /^Ran a command \(1\.5 s\)/);
}

// Times that are not known are not shown: no "1 ms" for a call of 0 ms, no
// time for a step Hermes gave none (the hub sends year 1 or leaves it out),
// and such steps keep their order.
{
  const w = create();
  const none = (o) => Object.assign(ev(Object.assign({ at: 0 }, o)), { ts: o.ts });
  w.add([none({ type: "tool_start", call_id: "z1", name: "terminal", args: { command: "ls" }, ts: "0001-01-01T00:00:00Z" }),
    none({ type: "tool_end", call_id: "z1", name: "terminal", result: '{"output": "", "exit_code": 0}', duration_ms: 0, ts: "0001-01-01T00:00:00Z" }),
    none({ type: "tool_start", call_id: "z2", name: "terminal", args: { command: "pwd" } }),
    none({ type: "tool_end", call_id: "z2", name: "terminal", result: '{"output": "", "exit_code": 0}' })]);
  const cs = w.log.querySelectorAll(".tool");
  assert.strictEqual(cs.length, 2);
  for (const c of cs) {
    assert.strictEqual(c.call.startedAt, 0);
    assert.strictEqual(c.call.endedAt, 0);
    assert.strictEqual(c.call.duration, undefined);
    assert.ok(!/\bms\b/.test(c.textContent), c.textContent);
  }
  assert.deepStrictEqual(w.log.querySelectorAll(".notice-title").map((n) => n.textContent), ["Ran ls", "Ran pwd"]);
  // order keeps a step with no time next to the step before it.
  const a = ev({ type: "message", at: 5 });
  const u = Object.assign(ev({ type: "message", at: 0 }), { ts: undefined });
  const c2 = ev({ type: "message", at: 7 });
  assert.deepStrictEqual(M.order([c2, u, a]).map((e) => e.seq), [a.seq, u.seq, c2.seq]);
  // A message the user sent before a result with no time of its own counts as read.
  const steer = ev({ type: "steer", at: 10 });
  const later = Object.assign(ev({ type: "tool_end", at: 0 }), { ts: undefined });
  assert.strictEqual(M.steerState(steer, [steer, later], false), "read");
}

// The group line: calls that ran together show no sum.
{
  const T = sandbox.window.HubTimes;
  const call = (s, e, d) => ({ toolName: "terminal", duration: d, failed: false, batch: "", call: { startedAt: T0 + s * 1000, endedAt: T0 + e * 1000, duration: d } });
  // Crossing times: 100 s and 100 s inside 110 s of real time.
  const x = G.summary([call(0, 100, 100), call(10, 110, 100)]).text;
  assert.match(x, /^Ran 2 commands \(1 min 50 s\)/, x);
  // One after the other: the sum stands.
  const y = G.summary([call(0, 10, 10), call(10, 25, 15)]).text;
  assert.match(y, /^Ran 2 commands \(25 s\)/, y);
  // One batch with no times: nothing is summed.
  const z = G.summary([{ toolName: "terminal", duration: 5, batch: "w", call: {} }, { toolName: "terminal", duration: 5, batch: "w", call: {} }]).text;
  assert.strictEqual(z, "Ran 2 commands");
  // The deferred tools have words, not "used session_search".
  assert.strictEqual(G.summary([{ toolName: "session_search", call: {} }, { toolName: "browser_vault", call: {} }, { toolName: "mcp_device_call", call: {} }, { toolName: "tool_search", call: {} }, { toolName: "project_memory", call: {} }]).text,
    "Searched past chats, used a saved login, called a tool on your computer, looked up a tool, used the project notes");
}
console.log("ok");

// A message the user sent shows once. Hermes stores a steer as a user row in
// the steer marker; the bubble the page drew is its only copy.
{
  const open = "[OUT-OF-BAND USER MESSAGE \u2014 a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]";
  const wrap = (t) => open + "\n" + t + "\n[/OUT-OF-BAND USER MESSAGE]";
  const w = create();
  const b = w.log;
  const shown = (t) => b.textContent.split(t).length - 1;
  w.set({ model: "m" });
  w.add([ev({ type: "goal", text: "Do it", at: 0 }), ev({ type: "steer", text: "just a note, look at the status bar", at: 10 }), ev({ type: "steer", text: "it's showing over the game", at: 11 })]);
  w.add([ev({ type: "tool_start", call_id: "z1", name: "terminal", args: { command: "ls" }, at: 12 }), ev({ type: "tool_end", call_id: "z1", name: "terminal", result: "{}", at: 13 }),
    ev({ type: "user", text: wrap("just a note, look at the status bar\nit's showing over the game"), at: 13 })]);
  assert.strictEqual(shown("just a note"), 1, b.textContent);
  assert.strictEqual(shown("showing over the game"), 1, b.textContent);
  assert.strictEqual(b.querySelectorAll(".msg.user").length, 2);
  assert.match(b.querySelectorAll(".queued")[0].textContent, / · read by the subagent$/);
  // The row can come before the bubble in a batch: still once.
  const w2 = create();
  w2.add([ev({ type: "goal", text: "Do it", at: 0 }), ev({ type: "user", text: wrap("same words"), at: 5 }), ev({ type: "steer", text: "same words", at: 4 })]);
  assert.strictEqual(w2.log.textContent.split("same words").length - 1, 1);
  // A steer from elsewhere shows as the chat shows it: the user's words as
  // the user's bubble, another agent's message as its notice card.
  const w3 = create();
  w3.add([ev({ type: "goal", text: "Do it", at: 0 }), ev({ type: "user", text: wrap("Use the other branch"), at: 5 }),
    ev({ type: "user", text: wrap("[Agent message am_0123456789abcdef from build]\nHold the push."), at: 6 })]);
  const bubbles = w3.log.querySelectorAll(".msg.user");
  assert.strictEqual(bubbles.length, 1);
  assert.strictEqual(bubbles[0].textContent, "Use the other branch");
  assert.match(w3.log.querySelectorAll(".notice-title").map((n) => n.textContent).join("|"), /^Message from .*build/);
  // An ordinary later user row (a summary) shows once.
  w3.add([ev({ type: "user", text: "Summary of earlier steps", at: 7 })]);
  assert.strictEqual(w3.log.textContent.split("Summary of earlier steps").length - 1, 1);
}

// The brief: short ones show whole; a long one folds after six lines and opens
// with Show all / Show less, line breaks kept.
{
  const long = Array.from({ length: 10 }, (_, i) => "line " + (i + 1)).join("\n");
  const w = create();
  w.add([ev({ type: "goal", text: long, at: 0 })]);
  const t = w.log.querySelector(".mc-brief-text");
  const more = w.log.querySelector(".mc-brief-more");
  assert.strictEqual(t.textContent, long);
  assert.ok(t.classList.contains("clamped"));
  assert.strictEqual(more.textContent, "Show all");
  more.onclick();
  assert.ok(!t.classList.contains("clamped"));
  assert.strictEqual(more.textContent, "Show less");
  more.onclick();
  assert.ok(t.classList.contains("clamped"));
  assert.strictEqual(more.textContent, "Show all");
}

// The context comes under the task and before the start note, as plain text with
// its own head and its own fold; no context, or an empty one, draws nothing.
{
  const goal = "Fix the parser\nsecond line";
  const long = Array.from({ length: 12 }, (_, i) => "context " + (i + 1)).join("\n");
  const w = create();
  w.add([ev({ type: "goal", text: goal, at: 0 }), ev({ type: "context", text: long, at: 0 }), ev({ type: "message", text: "On it.", at: 1 })]);
  const box = w.log;
  const heads = box.children.filter((c) => c.classList.contains("mc-brief")).map((c) => c.querySelector(".mc-brief-head").textContent);
  assert.deepStrictEqual(heads, ["Task", "Context"]);
  assert.deepStrictEqual(kidsOf(box).slice(0, 3), ["mc-brief", "mc-brief", "note"]);
  const [task, ctx] = box.children.filter((c) => c.classList.contains("mc-brief"));
  assert.strictEqual(task.querySelector(".mc-brief-text").textContent, goal);
  assert.strictEqual(task.querySelector(".mc-brief-more"), null);
  const t = ctx.querySelector(".mc-brief-text");
  const more = ctx.querySelector(".mc-brief-more");
  assert.strictEqual(t.textContent, long);
  assert.ok(t.classList.contains("clamped"));
  assert.strictEqual(more.textContent, "Show all");
  assert.strictEqual(more.getAttribute("aria-expanded"), "false");
  assert.strictEqual(more.getAttribute("aria-label"), "Context: show all");
  more.onclick();
  assert.ok(!t.classList.contains("clamped"));
  assert.strictEqual(more.textContent, "Show less");
  assert.strictEqual(more.getAttribute("aria-expanded"), "true");
  more.onclick();
  assert.ok(t.classList.contains("clamped"));
  // The Task fold stays its own.
  const w2 = create();
  w2.add([ev({ type: "goal", text: "just a goal", at: 0 }), ev({ type: "context", text: "   ", at: 0 })]);
  assert.strictEqual(w2.log.children.filter((c) => c.classList.contains("mc-brief")).length, 1);
  // A reset draws the brief again, once.
  w.reset();
  w.add([ev({ type: "goal", text: goal, at: 0 }), ev({ type: "context", text: "short context", at: 0 })]);
  assert.deepStrictEqual(kidsOf(w.log).slice(0, 3), ["mc-brief", "mc-brief", "note"]);
}

// The ledger is the agent's notebook: a call that worked shows no card and is
// left out of the group line; one that failed shows as any other.
{
  const card = (toolName, duration, failed) => ({ toolName, duration, failed, call: {} });
  assert.strictEqual(G.summary([card("execute_code", 1), card("ledger", 1), card("clarify", 1), card("ledger", 1)]).text, "Ran code, asked a question (2.0 s)");
  assert.strictEqual(G.summary([card("ledger"), card("ledger")]).text, "", "only ledger calls: no line");
  const bad = G.summary([card("ledger", 1, true), card("clarify", 1)]);
  assert.strictEqual(bad.text, "Used ledger, asked a question (2.0 s)");
  assert.strictEqual(bad.failed, 1);
  const lv = create();
  const t = (id, name, at, result) => [ev({ type: "tool_start", call_id: id, name, args: {}, at }), ev({ type: "tool_end", call_id: id, name, result, at: at + 1 })];
  lv.add([...t("l1", "ledger", 1, '{"ok": true}'), ...t("l2", "ledger", 3, '{"ok": true}'), ev({ type: "message", text: "Noted.", at: 5 }),
    ...t("l3", "ledger", 6, '{"ok": true}'), ...t("t1", "read_file", 8, "x"), ...t("l4", "ledger", 10, '{"ok": true}'), ...t("t2", "read_file", 12, "y"),
    ev({ type: "message", text: "Done.", at: 14 }), ...t("l5", "ledger", 15, '{"error": "blocked: the approval was denied"}'), ev({ type: "message", text: "End.", at: 17 })]);
  const shown = lv.log.querySelectorAll(".tool").filter((n) => !n.classList.contains("quiet"));
  assert.deepStrictEqual(shown.map((n) => n.toolName), ["read_file", "read_file", "ledger"], "ledger cards that worked are hidden, the failed one is shown");
  assert.ok(lv.log.querySelectorAll(".tool.quiet").length >= 4);
  const lines = lv.log.querySelectorAll("details.toolgroup").map((g) => g.children[0].textContent);
  assert.deepStrictEqual(lines.map((l) => l.replace(/ · .*?M/, "")), ["Read 2 files (2.0 s)", "Used ledger (1.0 s) 1 step failed"], "no group of ledger calls only, none counted: " + JSON.stringify(lines));
}
