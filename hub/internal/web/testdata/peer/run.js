"use strict";
// HubPeer names the other end of an agent message; a message card and a
// peer card use it for their titles.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const [peer, times, icons, notice] = process.argv.slice(2);
const sandbox = { window: {}, setInterval: () => 1, clearInterval: () => {} };
vm.createContext(sandbox);
for (const f of [peer, times, notice]) vm.runInContext(fs.readFileSync(f, "utf8"), sandbox);
const { HubPeer, HubNotice } = sandbox.window;

const goals = { "sa-0-edd20c0e": "relift lane android-apk: rebuild the APK\nand sign it with the release key, then upload the result to the share and report the link back here" };
const titles = { "20261112_103549_47fb42": "talaria-platform", build: "build" };
const names = { sub: (id) => goals[id] || "", chat: (r) => titles[r] || "" };
const say = (ref, n) => HubPeer.who(ref, n === undefined ? names : n).label;

// A subagent, with or without the word the hub puts in front of its id.
const want = 'the subagent "relift lane android-apk: rebuild the APK and sign it with the release key, then…"';
assert.strictEqual(say("subagent sa-0-edd20c0e"), want);
assert.strictEqual(say("sa-0-edd20c0e"), want);
assert.strictEqual(say("chat sa-0-edd20c0e"), want);
assert.ok(!/subagent subagent/.test(say("subagent sa-0-edd20c0e")));
// One that nobody knows: the short id, never the doubled word.
assert.strictEqual(say("subagent sa-0-ffff0000"), "a subagent");
assert.strictEqual(say("sa-0-ffff0000", {}), "a subagent");
assert.strictEqual(say("sa-0-ffff0000", null), "a subagent");
// The parent.
assert.strictEqual(say("parent"), "the parent");
// Chats: the title the hub put in the answer, the name asked for, or the
// session id looked up in the chat list.
assert.strictEqual(say("chat 'talaria-platform' (session 20261112_103549_47fb42)", {}), 'the chat "talaria-platform"');
assert.strictEqual(say("build", {}), 'the chat "build"');
assert.strictEqual(say("chat build", {}), 'the chat "build"');
assert.strictEqual(say("20261112_103549_47fb42"), 'the chat "talaria-platform"');
assert.strictEqual(say("20261112_999999_ffff", {}), "another chat");
assert.strictEqual(say(""), "another agent");
assert.strictEqual(HubPeer.who("subagent sa-0-edd20c0e", names).id, "sa-0-edd20c0e");
assert.strictEqual(HubPeer.who("parent", names).id, "");

// The page's own names are what a card uses.
HubPeer.names = names;
const el = (tag, cls, text) => {
  const n = { tag, cls: cls || "", kids: [], dataset: {}, title: "", textContent: text || "", hidden: false, classList: { add() {}, remove() {} } };
  n.append = (...k) => n.kids.push(...k);
  n.replaceChildren = (...k) => { n.kids = k; };
  n.setAttribute = () => {};
  n.removeAttribute = () => {};
  n.addEventListener = () => {};
  return n;
};
sandbox.window.HubIcons = { icon: () => el("i"), button: () => el("button") };
sandbox.window.hubMarkdown = { render: (n, t) => { n.textContent = t; } };
const text = (n) => (typeof n === "string" ? n : n.kids.length ? n.kids.map(text).join("") : n.textContent);
const titleOf = (raw) => {
  const n = HubNotice.parse(raw);
  const box = HubNotice.card(n, raw, { el, toast: () => {}, at: 0 });
  const head = box.kids[0];
  return { title: head.kids.find((k) => k.cls === "notice-title").textContent, text: text(box), n };
};
const msg = (from) => "[Agent message am_0123456789abcdef from " + from + "]\n\nhello there\n";
let got = titleOf(msg("chat sa-0-edd20c0e"));
assert.strictEqual(got.title, "Message from " + want);
assert.ok(got.text.includes("sa-0-edd20c0e"), "the id stays in the details");
assert.strictEqual(got.n.title, "Message from chat sa-0-edd20c0e", "the parsed notice is as it was");
assert.strictEqual(titleOf(msg("sa-0-ffff0000")).title, "Message from a subagent");
assert.strictEqual(titleOf(msg("parent")).title, "Message from the parent");
assert.strictEqual(titleOf(msg("talaria-platform")).title, 'Message from the chat "talaria-platform"');

// Every sender label Hermes puts in the header (hub/internal/agents sender()).
const owner = "chat 'Relift' (session 20261112_103549_47fb42)";
const full = "subagent sa-0-edd20c0e (goal: relift lane fpcr-const: build the FPC...) of " + owner;
const cases = [
  // [label, title after "Message from ", must the title hide]
  [full, want],
  ["subagent sa-0-edd20c0e of " + owner, want],
  ["subagent sa-0-edd20c0e (goal: relift lane fpcr-const: build the FPCR table) of chat build", want],
  // Not in the chat's list: the goal in the label.
  ["subagent sa-0-ffff0000 (goal: measure the antenna) of " + owner, 'the subagent "measure the antenna"'],
  ["subagent sa-0-ffff0000 (goal: fix the build (again) now) of " + owner, 'the subagent "fix the build (again) now"'],
  ["subagent sa-0-ffff0000 (goal: lone goal)", 'the subagent "lone goal"'],
  ["subagent sa-0-ffff0000 of " + owner, "a subagent"],
  ["subagent sa-0-ffff0000 of cron job 'nightly' (id abc123)", "a subagent"],
  ["subagent sa-0-ffff0000", "a subagent"],
  ["subagent sa-3-ffff0000 (goal: ) of " + owner, "a subagent"],
  // Parent, chats, cron jobs.
  ["parent", "the parent"],
  ["your parent agent sa-0-edd20c0e", want],
  ["your parent chat 'Relift' (session 20261112_103549_47fb42)", "the parent"],
  [owner, 'the chat "Relift"'],
  ["chat build", 'the chat "build"'],
  ["build", 'the chat "build"'],
  ["20261112_103549_47fb42", 'the chat "talaria-platform"'],
  ["cron job 'nightly backup' (id abc123)", 'the scheduled job "nightly backup"'],
  ["cron job abc123", "a scheduled job"],
];
for (const [from, title] of cases) {
  const g = titleOf(msg(from));
  assert.strictEqual(g.title, "Message from " + title, from);
  assert.ok(!/sa-\d|\(goal:|subagent subagent/.test(g.title), "no id or wrapper in the title: " + g.title);
  assert.ok(g.text.includes(from), "the raw label stays in the details: " + from);
}
// The real header from the report.
got = titleOf(msg(full));
assert.ok(got.text.includes("sa-0-edd20c0e"));
assert.strictEqual(HubPeer.who(full, names).id, "sa-0-edd20c0e");
assert.strictEqual(HubPeer.who(full, {}).name, "relift lane fpcr-const: build the FPC...");
assert.strictEqual(HubPeer.who(full, names).kind, "sub");
// An agent_send answer names a subagent's parent or a job the same way.
assert.strictEqual(say("your parent agent sa-0-edd20c0e"), want);
assert.strictEqual(say("cron job 'nightly' (id abc)", {}), 'the scheduled job "nightly"');
// A chat whose title mentions a subagent id is still a chat.
assert.strictEqual(say("chat 'about sa-0-edd20c0e' (session 20261112_103549_47fb42)", {}), 'the chat "about sa-0-edd20c0e"');
