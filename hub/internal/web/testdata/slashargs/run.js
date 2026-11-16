"use strict";
// usage: node run.js slashmatch.js usage.txt
// HubSlash.parse and HubSlash.options read a command's usage hint (the
// strings of Hermes's own command registry, in usage.txt) into the words
// and placeholders that may come next.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const H = sandbox.window.HubSlash;
const usages = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean);
const next = (u, words = [], partial = "") => {
  const o = H.options(H.parse(u), words, partial);
  return JSON.parse(JSON.stringify({ words: o.choices.map((c) => c.text), hints: o.hints.map((h) => h.text), end: o.end, lost: o.lost }));
};

const compress = "[here [N] | focus topic | --preview|--dry-run]";
assert.ok(usages.includes(compress), "the real /compress usage is in usage.txt");
assert.deepStrictEqual(next(compress).words, ["here", "focus", "--preview", "--dry-run"]);
assert.deepStrictEqual(next(compress).hints, []);
assert.strictEqual(next(compress).end, true);
assert.deepStrictEqual(next(compress, ["here"]), { words: [], hints: ["N"], end: true, lost: false });
assert.deepStrictEqual(next(compress, ["here", "3"]), { words: [], hints: [], end: true, lost: false });
assert.deepStrictEqual(next(compress, ["focus"]), { words: [], hints: ["topic"], end: false, lost: false });
assert.deepStrictEqual(next(compress, ["focus", "the", "api"], "x").hints, ["topic"]);
assert.deepStrictEqual(next(compress, [], "pre").words, ["--preview"]);
assert.deepStrictEqual(next(compress, [], "-").words, ["--preview", "--dry-run"]);
assert.strictEqual(next(compress, ["nope"]).lost, true);
// A hint tells what goes in a placeholder.
assert.ok(H.options(H.parse(compress), ["here"], "").hints[0].desc.length > 0);
assert.ok(H.options(H.parse(compress), [], "").choices.every((c) => c.desc), "every word of /compress has a description");

const model = "[model|reset] [--provider name] [--reasoning level] [--global|--session] [--refresh]";
assert.deepStrictEqual(next(model).words, ["reset", "--provider", "--reasoning", "--global", "--session", "--refresh"]);
assert.ok(next(model, ["--provider"]).hints.includes("name"));
assert.deepStrictEqual(next(model, ["--provider", "x"]).words.includes("--global"), true);
assert.deepStrictEqual(next(model, ["--global"]).words.includes("--session"), true);
assert.deepStrictEqual(next("<json|md|html> [filename] [redact]").words, ["json", "md", "html"]);
assert.deepStrictEqual(next("<json|md|html> [filename] [redact]", ["md"]), { words: ["redact"], hints: ["filename"], end: true, lost: false });
assert.deepStrictEqual(next("[level|show|hide|full|clamp] [--global]", ["show"]).words, ["--global"]);
assert.deepStrictEqual(next("[focus instructions]").hints, ["focus instructions"]);
assert.deepStrictEqual(next("<prompt>").hints, ["prompt"]);
assert.deepStrictEqual(next("<prompt>").end, false);
assert.deepStrictEqual(next("<prompt>", ["hello"]).end, true);
assert.deepStrictEqual(next("[all]").words, ["all"]);
assert.deepStrictEqual(next("[--here] [name]").words, ["--here"]);
assert.deepStrictEqual(next("[--here] [name]", ["--here"]).hints, ["name"]);
assert.deepStrictEqual(next("[staged|all|session] [--stat] [path...]", ["all", "--stat"]).hints, ["path"]);
assert.deepStrictEqual(next("[every <interval> <prompt> | status | pause | resume | clear]", ["every"]).hints, ["interval", "prompt"].slice(0, 1));
assert.deepStrictEqual(next("[every <interval> <prompt> | status | pause | resume | clear]", ["every", "30m"]).hints, ["prompt"]);
assert.deepStrictEqual(next(""), { words: [], hints: [], end: true, lost: false });

// Every real usage string parses, offers something or ends, and none
// throws or loops on its own words.
for (const u of usages) {
  const t = H.parse(u);
  assert.ok(Array.isArray(t), u);
  const o = H.options(t, [], "");
  assert.ok(o.choices.length || o.hints.length || o.end, `${u} offers a way on`);
  for (const w of o.choices) {
    const n = H.options(t, [w.text], "");
    assert.strictEqual(n.lost, false, `${u}: ${w.text} is accepted`);
  }
  // Choices never include a placeholder: no capital N, <angle> or ...
  for (const w of o.choices) assert.ok(!/[<>\[\]]|^\.\.\.|^[A-Z]$/.test(w.text), `${u}: ${w.text} is a word`);
}
const c = [{ name: "/compress", aliases: ["/compact"] }, { name: "/title" }];
assert.strictEqual(H.find(c, "compact").name, "/compress");
assert.strictEqual(H.find(c, "/TITLE").name, "/title");
assert.strictEqual(H.find(c, "zzz"), null);
console.log("ok");
