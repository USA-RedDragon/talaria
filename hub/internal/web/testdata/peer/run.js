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
assert.strictEqual(say("subagent sa-0-ffff0000"), "a subagent (sa-0-ffff0000)");
assert.strictEqual(say("sa-0-ffff0000", {}), "a subagent (sa-0-ffff0000)");
assert.strictEqual(say("sa-0-ffff0000", null), "a subagent (sa-0-ffff0000)");
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
assert.strictEqual(titleOf(msg("sa-0-ffff0000")).title, "Message from a subagent (sa-0-ffff0000)");
assert.strictEqual(titleOf(msg("parent")).title, "Message from the parent");
assert.strictEqual(titleOf(msg("talaria-platform")).title, 'Message from the chat "talaria-platform"');
