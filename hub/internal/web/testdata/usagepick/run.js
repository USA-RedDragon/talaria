"use strict";
// The Usage page picks its backend among the ones the user may use and the
// ones they only manage the Claude accounts of.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const sandbox = { window: {}, document: { getElementById: () => ({}) } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const u = sandbox.window.HubUsage({ api() {}, el() {}, defaultBackend: () => "", hasClaude: () => true });
const own = [{ id: "pc", name: "Home PC" }];
const adm = [{ id: "kittykat", name: "Kittykat" }];
const ids = (r) => r.all.map((x) => x.id).join(",");

// The backend the link names, though the user has no chat access to it.
let r = u.pickBackend(own, adm, "kittykat", "", "");
assert.strictEqual(r.pick.id, "kittykat");
assert.strictEqual(r.pick.claudeOnly, true);
assert.strictEqual(ids(r), "pc,kittykat");
assert.strictEqual(r.all[0].claudeOnly, undefined, "own backends keep the whole page");

// A name nobody may see falls back, as before.
r = u.pickBackend(own, adm, "nope", "", "");
assert.strictEqual(r.pick.id, "pc");
r = u.pickBackend(own, adm, "", "kittykat", "pc");
assert.strictEqual(r.pick.id, "kittykat", "the backend shown before");
r = u.pickBackend(own, adm, "", "", "pc");
assert.strictEqual(r.pick.id, "pc", "the default");

// A backend the user uses and administers appears once, with the whole page.
r = u.pickBackend(own, [{ id: "pc", name: "Home PC" }], "pc", "", "");
assert.strictEqual(ids(r), "pc");
assert.strictEqual(r.pick.claudeOnly, undefined);

// No chat backend at all: the admin backend is the page.
r = u.pickBackend([], adm, "", "", "");
assert.strictEqual(r.pick.id, "kittykat");
assert.strictEqual(r.pick.claudeOnly, true);
r = u.pickBackend([], [], "", "", "");
assert.strictEqual(r.pick, undefined);
console.log("ok");
