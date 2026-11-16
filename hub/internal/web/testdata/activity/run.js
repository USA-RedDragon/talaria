"use strict";
// The Activity sidebar's subagent rows: the status line under a running
// subagent (a sentence, the raw text one tap away), the token line of the
// header, and when a row counts as running or finished (only on what Hermes
// says, never on one missing list answer).
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const { el, document, El } = require("../fakedom.js");

let now = 1_800_000_000_000;
class D extends Date {
  static now() { return now; }
}
const timers = new Map();
const ticks = [];
const tickClock = () => { for (const f of ticks) f(); };
let tid = 0;
const ids = {};
for (const id of ["actbody", "actbtn", "actclose", "actcount", "actsum", "app", "todostrip", "tok", "toksub", "tokturn"]) ids[id] = new El("div");
const doc = Object.assign({}, document, { createElementNS: (_ns, t) => new El(t), getElementById: (id) => ids[id], hidden: false, activeElement: null, addEventListener: () => {}, querySelector: () => null, body: new El("body") });
const copied = [];
const sandbox = {
  window: {}, document: doc, Date: D, Math, JSON, Intl, Promise, Array, Set, Map,
  setTimeout: (fn, ms) => { const id = ++tid; timers.set(id, fn); return id; },
  clearTimeout: (id) => { timers.delete(id); },
  setInterval: (fn) => { ticks.push(fn); return 1; }, clearInterval: () => {},
  matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: () => {} },
  requestAnimationFrame: (fn) => fn(), CSS: { escape: (s) => s },
  location: { hash: "" }, navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
};
sandbox.window = sandbox;
const toasts = [];
sandbox.window.HubToast = { show: (text, opts) => { toasts.push([text, opts]); } };
sandbox.window.HubBackoff = () => ({ next: () => 3000, reset: () => {} });
sandbox.window.HubIcons = { icon: (name) => el("svg", "ico i-" + name), button: (name, label, cls) => { const b = el("button", cls); b.title = label; return b; } };
// The names of the page's subagents, as app.js sets them: the Activity list's goals.
sandbox.window.HubPeer = { names: { sub: () => "" }, who(ref, names) { return { name: names.sub(ref) }; } };
vm.createContext(sandbox);
const dir = process.argv[2];
const cardFiles = ["toolcard.js", ...fs.readdirSync(dir + "/cards").filter((f) => f.endsWith(".js")).sort().map((f) => "cards/" + f)];
for (const f of ["times.js", ...cardFiles, "toolgroup.js", "minichat.js", "todo.js", "activity.js"]) vm.runInContext(fs.readFileSync(dir + "/" + f, "utf8"), sandbox);

// What the hub answers to the sidebar's reads.
let list = [];
let verdict = { live: true, running: true };
let verdictFails = false;
const reads = [];
// What the hub answers to .../todos: the chat's list (supported false: a Hermes without stored lists) and each subagent's.
let plan = { supported: true, todos: [], revision: 0 };
const subPlans = {};
const todoReads = [];
async function api(method, path) {
  reads.push(path);
  if (/\/todos(\?|$)/.test(path)) {
    todoReads.push(path);
    const m = /subagent=([^&]+)/.exec(path);
    return m ? subPlans[decodeURIComponent(m[1])] || { supported: true, todos: [], revision: 0 } : plan;
  }
  if (path.endsWith("/activity")) return { subagents: list, processes: [] };
  if (/\/subagents\/[^/]+\/events/.test(path)) {
    if (verdictFails) throw new Error("no answer");
    return Object.assign({ events: [], epoch: 1, more: false }, verdict);
  }
  return {};
}
const act = sandbox.window.HubActivity({ api, el, banner: () => {}, showText: () => {} });

(async () => {
const chat = { base: "/api/sessions/b/s", backend: "b" };
act.show(chat);
// Runs what the page would run after its timers, until nothing is left.
async function settle() {
  for (let i = 0; i < 5 && timers.size; i++) {
    const fns = [...timers.values()];
    timers.clear();
    for (const fn of fns) await fn();
  }
}
async function round() {
  const fns = [...timers.values()];
  timers.clear();
  for (const fn of fns) await fn();
}
const body = () => ids.actbody;
const text = () => body().textContent;
const sumText = () => ids.actsum.textContent;

// A subagent starts and runs a tool: the line is a sentence, not the raw text.
act.event("subagent.start", { subagent_id: "sa-1", goal: "Check the cluster alerts", model: "m" });
act.event("subagent.tool", { subagent_id: "sa-1", tool_name: "process_manage", tool_preview: "wait proc_283637f9d51 180s" });
let line = body().querySelector("button.now2");
assert.ok(line, "the status line is a button");
assert.match(line.textContent, /^Waiting on a background command/);
assert.ok(!text().includes("process_manage"), "the raw text is not shown closed: " + text());
assert.ok(!text().includes("proc_283637f9d51"));
assert.strictEqual(line.getAttribute("aria-expanded"), "false");
assert.ok(line.querySelector("svg.i-clock"), "the icon fits the sentence");
// An elapsed time follows the sentence.
now += 185000;
act.event("subagent.progress", { subagent_id: "sa-1", text: "" });
now += 0;
act.event("subagent.tool", { subagent_id: "sa-1", tool_name: "process_manage", tool_preview: "wait proc_283637f9d51 180s" });
now += 185000;
act.event("subagent.progress", { subagent_id: "sa-1", text: "" });
// Tapping the line opens the raw text with a copy button, and not the row.
const stops = [];
let tap = { stopPropagation: () => stops.push(1) };
body().querySelector("button.now2").onclick(tap);
assert.ok(stops.length, "the tap stays on the line");
assert.ok(!body().querySelector(".row.open"), "the row did not open");
line = body().querySelector("button.now2");
assert.strictEqual(line.getAttribute("aria-expanded"), "true");
const raw = body().querySelector(".rawbox");
assert.ok(raw && raw.textContent === "wait proc_283637f9d51 180s", raw && raw.textContent);
raw.querySelector("button").onclick(tap);
assert.deepStrictEqual(copied, ["wait proc_283637f9d51 180s"]);
// It stays open through the redraw every second, and a tap closes it.
act.event("subagent.progress", { subagent_id: "sa-1", text: "" });
assert.ok(body().querySelector(".rawbox"));
body().querySelector("button.now2").onclick(tap);
assert.ok(!body().querySelector(".rawbox"));
// The rest of the row still opens the small chat.
body().querySelector(".row-head").onclick();
assert.ok(body().querySelector(".row.open"));
body().querySelector(".row-head").onclick();
// A subagent's own words stay plain text, and a tool it does not know is "Using ...".
act.event("subagent.thinking", { subagent_id: "sa-1", text: "Looking at the flux drift" });
assert.ok(!body().querySelector("button.now2"));
assert.ok(text().includes("Looking at the flux drift"));
act.event("subagent.tool", { subagent_id: "sa-1", tool_name: "some_new_tool", tool_preview: "{...}" });
assert.match(body().querySelector("button.now2").textContent, /^Using some new tool/);
// A batched call arrives as progress text with Hermes's emoji: a sentence with a
// line icon, no emoji, and not the monospace text.
const pict = /\p{Extended_Pictographic}|\uFE0F/u;
act.event("subagent.progress", { subagent_id: "sa-1", text: "\u{1F500} [set 5] terminal, terminal, process_manage" });
line = body().querySelector("button.now2");
assert.ok(line, "a batch is a status line");
assert.match(line.textContent, /^Running 5 tools: terminal, process_manage/);
assert.ok(line.querySelector("svg.i-tool"));
assert.ok(!body().querySelector(".now"), "no raw monospace line: " + text());
// Hermes events with emoji everywhere: nothing rendered carries one, closed or open.
const fixtures = [
  ["subagent.tool", { tool_name: "\u{1F9E0}memory", tool_preview: "\u{1F4BE} save" }],
  ["subagent.tool", { tool_name: "\u{1F5A5}\uFE0F brand_new_tool", tool_preview: "\u2705 {...}" }],
  ["subagent.tool", { tool_name: "tool_call", tool_preview: "\u{1F500} [set 3] web_search, web_search, read_file" }],
  ["subagent.progress", { text: "\u26A1 Working on it" }],
  ["subagent.tool", { tool_name: "delegate_task", tool_preview: "\u{1F500} go" }],
];
for (const [kind, p] of fixtures) {
  act.event(kind, Object.assign({ subagent_id: "sa-1" }, p));
  assert.ok(!pict.test(text()), kind + " leaked an emoji: " + text());
  const l = body().querySelector("button.now2");
  if (l && l.getAttribute("aria-expanded") !== "true") l.onclick({ stopPropagation() {} });
  assert.ok(!pict.test(text()), kind + " leaked an emoji when open: " + text());
  const l2 = body().querySelector("button.now2");
  if (l2 && l2.getAttribute("aria-expanded") === "true") l2.onclick({ stopPropagation() {} });
}
assert.match(body().querySelector("button.now2").textContent, /^Starting a subagent/);
assert.ok(!text().includes("{...}"));

// The header does not claim 0 tokens when none are counted yet.
assert.match(sumText(), /^tokens appear when each finishes · 1 running, 0 finished/, sumText());
act.event("subagent.complete", { subagent_id: "sa-1", status: "completed", summary: "Fixed it.", input_tokens: 3100, output_tokens: 920, duration_seconds: 400 });
assert.match(sumText(), /^3\.1k in · 920 out$/, sumText());
assert.ok(!sumText().includes("0 in"));

// Running or finished comes from Hermes. One list without the subagent says nothing.
const chat2 = { base: "/api/sessions/b/s2", backend: "b" };
act.show(chat2);
act.event("subagent.start", { subagent_id: "sa-2", goal: "Second", model: "m" });
act.event("subagent.start", { subagent_id: "sa-3", goal: "Third", model: "m" });
const rowState = (id) => { const r = body().querySelectorAll(".row").find((x) => x.dataset.act === id); return r ? r.querySelector(".meta").children[0].textContent : "none"; };
now += 60000;
list = [{ id: "sa-2", goal: "Second", status: "running" }, { id: "sa-3", goal: "Third", status: "running" }];
await round();
assert.strictEqual(rowState("sa-2"), "Running");
// sa-2 leaves the list for a long while (a slow or failed read, a restart): still running.
list = [{ id: "sa-3", goal: "Third", status: "running" }];
for (let i = 0; i < 4; i++) { now += 9000; await round(); }
assert.strictEqual(rowState("sa-2"), "Running", "Hermes said it still runs");
assert.ok(reads.some((p) => /subagents\/sa-2\/events/.test(p)), "it asked before it decided");
// No answer from Hermes: it stays as it is.
verdictFails = true;
for (let i = 0; i < 4; i++) { now += 9000; await round(); }
assert.strictEqual(rowState("sa-2"), "Running");
// Only Hermes saying it does not run ends the row.
verdictFails = false;
verdict = { live: true, running: false };
for (let i = 0; i < 4; i++) { now += 9000; await round(); }
assert.strictEqual(rowState("sa-2"), "Done");
assert.strictEqual(rowState("sa-3"), "Running");
// A stored copy without a live Hermes answer is no proof either.
act.event("subagent.start", { subagent_id: "sa-4", goal: "Fourth", model: "m" });
verdict = { live: false, running: false };
for (let i = 0; i < 4; i++) { now += 9000; await round(); }
assert.strictEqual(rowState("sa-4"), "Running");
// The list says what became of a subagent: a status it gives wins.
list = [{ id: "sa-3", goal: "Third", status: "completed" }, { id: "sa-4", goal: "Fourth", status: "running" }];
await round();
assert.strictEqual(rowState("sa-3"), "Done");
assert.strictEqual(rowState("sa-4"), "Running");
list = [{ id: "sa-4", goal: "Fourth", status: "failed" }];
await round();
assert.strictEqual(rowState("sa-4"), "Failed");
// A row the complete event ended stays ended even when a stale list shows it running.
act.event("subagent.start", { subagent_id: "sa-5", goal: "Fifth", model: "m" });
act.event("subagent.complete", { subagent_id: "sa-5", status: "interrupted" });
list = [{ id: "sa-5", goal: "Fifth", status: "running" }];
await round();
assert.strictEqual(rowState("sa-5"), "Stopped");
// A restart hands a running subagent to a new Hermes that lists its own start and a fresh tool count: the row
// keeps its earliest start and its highest count, and its timer keeps counting from the real start.
const rowTime = (id) => { const r = body().querySelectorAll(".row").find((x) => x.dataset.act === id); return r.querySelector(".time").textContent; };
const rowTools = (id) => { const r = body().querySelectorAll(".row").find((x) => x.dataset.act === id); return r.querySelector(".meta").textContent; };
const realStart = now - 17 * 60 * 1000;
act.event("subagent.start", { subagent_id: "sa-6", goal: "Sixth", model: "m" });
list = [{ id: "sa-6", goal: "Sixth", status: "running", started_at: realStart / 1000, tool_count: 41 }];
await round();
assert.strictEqual(rowTime("sa-6"), "17:00");
assert.ok(rowTools("sa-6").includes("41 tools"), rowTools("sa-6"));
now += 60 * 1000;
list = [{ id: "sa-6", goal: "Sixth", status: "running", started_at: (now - 5000) / 1000, tool_count: 0 }];
await round();
assert.strictEqual(rowTime("sa-6"), "18:00");
assert.ok(rowTools("sa-6").includes("41 tools"), rowTools("sa-6"));
// A draw that changes one row builds that row only: the nodes of the others stay the same ones, and a
// draw that changes nothing keeps all of them. The clock of a running row moves without a build.
const rowNode = (id) => body().querySelectorAll(".row").find((x) => x.dataset.act === id);
const sa6 = rowNode("sa-6");
const sa5 = rowNode("sa-5");
act.event("subagent.start", { subagent_id: "sa-9", goal: "Ninth", model: "m" });
assert.strictEqual(rowNode("sa-6"), sa6, "an unchanged running row kept its node after another row came");
assert.strictEqual(rowNode("sa-5"), sa5, "an unchanged finished row kept its node");
assert.ok(rowNode("sa-9"), "the new row is there");
act.event("subagent.complete", { subagent_id: "sa-9", status: "completed" });
assert.strictEqual(rowNode("sa-6"), sa6);
assert.strictEqual(rowNode("sa-5"), sa5);
assert.strictEqual(rowState("sa-9"), "Done");
const before = rowTime("sa-6");
now += 5000;
tickClock();
assert.strictEqual(rowNode("sa-6"), sa6, "the clock tick did not build the row");
assert.notStrictEqual(rowTime("sa-6"), before, "the clock moved");
// A page that missed the tool's event has only the list: it names the tool and what it was given.
// With the command, the line opens to it; with the name alone there is no box and no raw tool name.
const rowOf = (id) => body().querySelectorAll(".row").find((x) => x.dataset.act === id);
const nowText = (id) => body().querySelectorAll(".row").find((x) => x.dataset.act === id).textContent;
list = [{ id: "sa-7", goal: "Seventh", status: "running", started_at: now / 1000, tool_count: 15, last_tool: "terminal", last_preview: "make test ARGS=-race" }];
await round();
let l7 = rowOf("sa-7").querySelector("button.now2");
assert.ok(l7, "the line opens when the command is known");
assert.match(l7.textContent, /^Running make test/);
l7.onclick({ stopPropagation() {} });
assert.strictEqual(rowOf("sa-7").querySelector(".rawbox").textContent, "make test ARGS=-race");
list = [{ id: "sa-8", goal: "Eighth", status: "running", started_at: now / 1000, tool_count: 15, last_tool: "terminal" }];
await round();
assert.ok(!rowOf("sa-8").querySelector("button.now2"), "no button without a command");
assert.ok(!rowOf("sa-8").querySelector(".rawbox"), "no empty box");
assert.ok(nowText("sa-8").includes("Running a command") && !nowText("sa-8").includes("terminal"), nowText("sa-8"));
// The command arrives in a later list: the same row gets it.
list = [{ id: "sa-8", goal: "Eighth", status: "running", started_at: now / 1000, tool_count: 15, last_tool: "terminal", last_preview: "ls -la" }];
await round();
assert.match(rowOf("sa-8").querySelector("button.now2").textContent, /^Running ls -la/);
// The whole card header, title included, opens and closes the card: a click on the title toggles
// the row, Enter and Space on the header do too, and a click that ends a text selection does not.
{
  const bigGoal = "Fix the parser\n" + "check this case too\n".repeat(30);
  list = [{ id: "sa-g", goal: bigGoal, status: "running", started_at: now / 1000, tool_count: 1 }];
  await round();
  const title = () => rowOf("sa-g").querySelector(".goal");
  const head = () => rowOf("sa-g").querySelector(".row-head");
  const isOpen = () => rowOf("sa-g").classList.contains("open");
  assert.strictEqual(title().textContent, "Fix the parser");
  assert.strictEqual(title().getAttribute("role"), null, "the title is plain text, not its own button");
  assert.ok(!isOpen());
  head().onclick({ target: title() });
  assert.ok(isOpen(), "a click on the title opens the card");
  assert.strictEqual(head().getAttribute("aria-expanded"), "true");
  head().onclick({ target: title() });
  assert.ok(!isOpen(), "a second click on the title closes it");
  const key = (k) => { let prevented = false; head().onkeydown({ key: k, preventDefault() { prevented = true; } }); return prevented; };
  assert.ok(key("Enter") && isOpen());
  assert.ok(key(" ") && !isOpen());
  assert.ok(!key("a") && !isOpen(), "another key is not taken");
  sandbox.window.getSelection = () => ({ isCollapsed: false, toString: () => "check" });
  head().onclick({ target: title() });
  assert.ok(!isOpen(), "a click that ends a selection does not toggle");
  delete sandbox.window.getSelection;
  head().onclick({ target: title() });
  assert.ok(isOpen());
  head().onclick({ target: title() });
}
// A subagent that ended its turn waiting on a background job (Hermes status "waiting") is not
// failed and not finished: it shows what it waits on, counts as running, and shows its elapsed time.
const liveCount = () => Number(ids.actcount.textContent || 0);
const runningBefore = liveCount();
const longCmd = "bash /home/alice/Projects/demo/wait.sh " + "--flag ".repeat(40) + "done";
list = [{ id: "sa-w", goal: "Build the thing", status: "waiting", waiting_on: [longCmd, "sleep 99"], started_at: now / 1000 - 3 * 3600 - 13 * 60 }];
await round();
const wrow = rowOf("sa-w");
assert.ok(wrow, "the waiting subagent has a row");
assert.ok(!/Failed/.test(wrow.textContent), "a waiting subagent is not failed: " + wrow.textContent);
assert.ok(!/Done/.test(wrow.textContent), "a waiting subagent is not done: " + wrow.textContent);
assert.ok(wrow.querySelector(".state.hold"), "its own state color");
assert.ok(!wrow.querySelector(".state.bad") && !wrow.querySelector(".state.ok"));
assert.match(wrow.textContent, /Waiting on bash \/home\/alice\/Projects\/demo\/wait\.sh/);
assert.ok(wrow.textContent.includes("Waiting on ") && !wrow.textContent.includes("done"), "the command is clamped: " + wrow.textContent);
assert.ok(wrow.textContent.includes("+1 more") || wrow.textContent.includes("1 more"), "a second command is counted: " + wrow.textContent);
assert.match(wrow.querySelector(".time").textContent, /3\s*h|3:13|193/, "elapsed since start: " + wrow.querySelector(".time").textContent);
assert.strictEqual(liveCount(), runningBefore + 1, "a waiting subagent counts as running");
assert.ok(/\d+ running/.test(sumText()), sumText());
// Many polls later, and with the list missing it once, nothing marks it failed or finished.
for (let i = 0; i < 4; i++) { now += 60000; await round(); }
assert.ok(!/Failed|Done/.test(rowOf("sa-w").textContent), "still waiting: " + rowOf("sa-w").textContent);
// A stray complete event that says waiting does not end it either.
act.event("subagent.complete", { subagent_id: "sa-w", status: "waiting" });
assert.ok(!/Failed|Done/.test(rowOf("sa-w").textContent) && rowOf("sa-w").querySelector(".state.hold"));
// It resumes: the list says running and the row runs again.
list = [{ id: "sa-w", goal: "Build the thing", status: "running", started_at: now / 1000 - 3 * 3600 - 20 * 60 }];
await round();
assert.ok(rowOf("sa-w").querySelector(".state.run"), "running again");
assert.ok(!/Waiting on/.test(rowOf("sa-w").textContent));
assert.strictEqual(liveCount(), runningBefore + 1);
// And it waits again, then finishes once.
list = [{ id: "sa-w", goal: "Build the thing", status: "waiting", waiting_on: ["make all"], started_at: now / 1000 - 3 * 3600 - 20 * 60 }];
await round();
assert.match(rowOf("sa-w").textContent, /Waiting on make all/);
list = [{ id: "sa-w", goal: "Build the thing", status: "completed", started_at: now / 1000 - 3 * 3600 - 20 * 60 }];
await round();
assert.ok(rowOf("sa-w").querySelector(".state.ok"), "done");
assert.strictEqual(liveCount(), runningBefore);
assert.strictEqual(rowState("sa-w"), "Done");

// The plan: the chat's own to-do list as a section above the subagents, a line above the message box, and
// a subagent's own list in its row.
{
  const todo = (id, content, status, extra) => Object.assign({ id, content, status }, extra || {});
  const planEl = () => body().querySelector("section.plan");
  const strip = ids.todostrip;
  // A chat with no list shows nothing of it.
  assert.ok(!planEl(), "no plan without a list");
  assert.strictEqual(strip.hidden, true, "no strip without a list");
  // The list is read with the activity poll, and shows when it comes.
  plan = { supported: true, revision: 3, todos: [
    todo("1", "Android build installs", "completed"),
    todo("2", "Title screen on the Thor", "in_progress"),
    todo("3", "Thor touch: confirm touch reaches the guest", "in_progress", { parent: "2", owner: "sa-pl", notes: "Checking with the libnx touch test" }),
    todo("4", "Launcher icon", "pending", { parent: "2" }),
    todo("5", "APK size", "blocked", { parent: "2" }),
  ] };
  list = [{ id: "sa-pl", goal: "android-rezero", status: "running", started_at: now / 1000 - 60 }];
  sandbox.window.HubPeer.names.sub = (id) => (act.goalOf(id));
  await round();
  assert.ok(planEl(), "the plan shows");
  assert.strictEqual(body().children[0], planEl(), "the plan is above the subagents");
  assert.match(planEl().querySelector(".plan-count").textContent, /^1 of 5 done$/);
  assert.strictEqual(planEl().querySelector(".plan-sum").textContent, "2 in progress · 1 blocked · 1 to do");
  assert.ok(planEl().querySelectorAll("li.ti").length === 5, "five items");
  assert.ok(planEl().querySelector("li.ti.done"), "a done item");
  const chip = planEl().querySelector(".own");
  assert.strictEqual(chip.textContent, "android-rezero", "the owner is named by its goal");
  assert.ok(!/sa-pl/.test(planEl().textContent + chip.title), "no raw subagent id");
  assert.strictEqual(planEl().querySelector(".tn").textContent, "Checking with the libnx touch test");
  assert.strictEqual(planEl().querySelector(".tn").getAttribute("aria-expanded"), "false");
  planEl().querySelector(".tn").onclick();
  assert.strictEqual(planEl().querySelector(".tn").getAttribute("aria-expanded"), "true", "a tap opens the note");
  // The strip: the item in progress, how far, and a tap that opens the panel on the plan.
  assert.strictEqual(strip.hidden, false);
  assert.strictEqual(strip.querySelector(".cur").textContent, "Thor touch: confirm touch reaches the guest", "the most specific item in progress");
  assert.strictEqual(strip.querySelector(".cnt").textContent, "1 of 5");
  assert.strictEqual(strip.querySelector(".pbar i").style.width, "20%");
  // An unknown owner is "a subagent", not an id.
  act.event("todo.updated", { revision: 4, todos: [todo("1", "Only item", "in_progress", { owner: "sa-gone" })] });
  assert.strictEqual(planEl().querySelector(".own").textContent, "a subagent");
  // A todo.updated event replaces the list at once, with no read.
  const reads0 = todoReads.length;
  act.event("todo.updated", { revision: 5, todos: [todo("1", "Done one", "completed"), todo("2", "Next", "in_progress"), todo("3", "After", "pending")] });
  assert.strictEqual(todoReads.length, reads0, "the event is the list");
  assert.match(planEl().querySelector(".plan-count").textContent, /^1 of 3 done$/);
  assert.strictEqual(strip.querySelector(".cur").textContent, "Next");
  // The chat's own todo tool without the list in its result reads it again.
  plan = { supported: true, revision: 6, todos: [todo("1", "Done one", "completed"), todo("2", "Next", "completed"), todo("3", "After", "in_progress")] };
  act.event("tool.complete", { name: "todo_list", tool_id: "t1", result: "{}" });
  await round();
  assert.strictEqual(strip.querySelector(".cur").textContent, "After", "the tool result refreshed the list: " + strip.textContent);
  // Done and cancelled folded after the first few; a tap shows them.
  act.event("todo.updated", { revision: 7, todos: [1, 2, 3, 4, 5].map((n) => todo("d" + n, "Finished " + n, "completed")).concat([todo("x", "Open", "pending")]) });
  assert.strictEqual(planEl().querySelectorAll("li.ti").length, 4);
  assert.strictEqual(planEl().querySelector(".plan-fold").textContent, "Show 2 done");
  planEl().querySelector(".plan-fold").onclick();
  assert.strictEqual(planEl().querySelectorAll("li.ti").length, 6);
  assert.strictEqual(planEl().querySelector(".plan-fold").textContent, "Hide done");
  // Every item done or cancelled: the strip goes, the plan stays.
  act.event("todo.updated", { revision: 8, todos: [todo("1", "a", "completed"), todo("2", "b", "cancelled")] });
  assert.strictEqual(strip.hidden, true, "no strip when nothing is left");
  assert.ok(planEl(), "the plan stays with its history");
  // An empty list shows nothing.
  act.event("todo.updated", { revision: 9, todos: [] });
  assert.ok(!planEl() && strip.hidden);

  // A subagent's own list: counts and its current item in its row, the whole tree after a tap.
  list = [{ id: "sa-pl", goal: "android-rezero", status: "running", started_at: now / 1000 - 60,
    todo: { current: [{ id: "b", content: "Read the touch test" }], counts: { total: 4, completed: 1, in_progress: 1, pending: 2 }, revision: 2 } }];
  subPlans["sa-pl"] = { supported: true, revision: 2, todos: [todo("a", "Find the test", "completed"), todo("b", "Read the touch test", "in_progress", { notes: "line 40" }), todo("c", "Report", "pending"), todo("d", "Cleanup", "pending")] };
  await round();
  const card = rowOf("sa-pl");
  assert.match(card.querySelector(".sp-cur").textContent, /Read the touch test/);
  assert.strictEqual(card.querySelector(".sp-cnt").textContent, "1 of 4");
  assert.ok(!card.querySelector(".tl"), "collapsed: counts and the current item only");
  const readsBefore = todoReads.length;
  card.querySelector(".sp-line").onclick({ stopPropagation() {} });
  await round();
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  await round();
  assert.ok(todoReads.some((q) => q.includes("?subagent=sa-pl")), "the subagent's list is read when opened: " + todoReads.slice(readsBefore));
  const open = rowOf("sa-pl");
  assert.strictEqual(open.querySelectorAll("li.ti").length, 4, "the whole list shows: " + open.textContent);
  assert.ok(!open.querySelector(".own"), "no owner chips in a subagent's own list");
  // A subagent that keeps no list shows no list line.
  list = [{ id: "sa-pl", goal: "android-rezero", status: "running", started_at: now / 1000 - 60 }];
  await round();
  assert.ok(!rowOf("sa-pl").querySelector(".subplan"), "no list, no line");
}
// A Hermes without stored lists: nothing shows, no error, and it is not asked again.
{
  const old = sandbox.window.HubActivity({ api: async (m, p) => { if (/\/todos/.test(p)) { todoReads.push("old"); return { todos: [], revision: 0, supported: false }; } return { subagents: [], processes: [] }; }, el, banner: () => {}, showText: () => {} });
  old.show({ base: "/api/sessions/b/old", backend: "b" });
  const before = todoReads.filter((q) => q === "old").length;
  for (let i = 0; i < 3; i++) { await round(); await new Promise((r) => setImmediate(r)); }
  assert.ok(!body().querySelector("section.plan") && ids.todostrip.hidden, "an older Hermes shows no plan");
  assert.ok(!/Could not load/.test(ids.actsum.textContent), "and no error");
  assert.strictEqual(todoReads.filter((q) => q === "old").length - before <= 1, true, "asked once");
}
// Subagents and background commands share one list: running first, then finished, each by start
// time, with the counts of the header and the sections right, no tab bar and no id in any row.
{
  const t0 = now / 1000;
  list = [
    { id: "sa-late", goal: "Late subagent", status: "running", started_at: t0 - 60 },
    { id: "sa-old", goal: "Old subagent", status: "completed", started_at: t0 - 500 },
  ];
  const procs = [
    { id: "proc_mid", command: "sleep 600", running: true, started_at: t0 - 300 },
    { id: "proc_gone", command: "make all", running: false, exit_code: 2, started_at: t0 - 400, exited_at: t0 - 100 },
    { id: "proc_fine", command: "go test ./...", running: false, exit_code: 0, started_at: t0 - 450, exited_at: t0 - 200 },
  ];
  const two = sandbox.window.HubActivity({ api: async (m, path) => (path.endsWith("/activity") ? { subagents: list, processes: procs } : /\/todos/.test(path) ? { supported: true, todos: [], revision: 0 } : { events: [], epoch: 1, more: false, live: true, running: true }), el, banner: () => {}, showText: () => {} });
  ids.actbody.children.length = 0;
  two.show({ base: "/api/sessions/b/mix", backend: "b" });
  for (let i = 0; i < 4; i++) { await round(); await new Promise((r) => setImmediate(r)); }
  const rows = body().querySelectorAll(".row").map((r) => r.dataset.act);
  const heads = body().querySelectorAll(".sec").map((h) => h.textContent);
  assert.deepStrictEqual(heads, ["Running2", "Finished3"], "one Running section with its count, then Finished");
  assert.strictEqual(ids.actcount.textContent, "2", "the header counts a command and a subagent");
  assert.match(sumText(), /2 running, 3 finished/, sumText());
  const head = (id) => rows.indexOf(id);
  assert.ok(head("proc_mid") < head("sa-late"), "running ones by start time: " + rows);
  assert.ok(head("sa-late") < head("sa-old"), "running before finished: " + rows);
  assert.ok(head("sa-old") < head("proc_fine") && head("proc_fine") < head("proc_gone"), "finished ones by start time: " + rows);
  const mid = rowOf("proc_mid");
  assert.ok(mid.textContent.includes("sleep 600") && !mid.textContent.includes("proc_mid"), "the command, not its id: " + mid.textContent);
  assert.match(rowOf("proc_gone").textContent, /Exit 2/);
  two.show(null);
}


console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
