"use strict";
// Checks the grouping of jobrows.js: the run chats of one scheduled job
// become one entry at the place of the newest, with the count of runs not
// opened; a failed run, a chat that waits on the user, a pinned chat and
// chats of no job stay as they are.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: () => {} } };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const group = (...a) => sandbox.window.HubJobRows.group(...a);

const chat = (id, o = {}) => ({ id, backend_id: "pc", title: id, unread: false, running: false, needs: "", pinned: false, updated_at: "2026-11-12T10:00:00Z", ...o });
const run = (id, o = {}) => ({ session_id: id, started_at: "2026-11-12T10:00:00Z", result: "Finished", failed: false, running: false, ...o });
const jobs = {
  jobs: [
    { backend_id: "pc", id: "j1", name: "Chapter watch", schedule: "every 3 hours", runs_in: "Sandbox", runs: [run("r5"), run("r4"), run("r3"), run("r2"), run("r1")] },
    { backend_id: "pc", id: "j2", name: "Digest", schedule: "every day at 9:00 AM", runs_in: "Sandbox", runs: [run("d2", { failed: true, result: "Failed: boom" }), run("d1")] },
    { backend_id: "home", id: "j3", name: "Other backend", schedule: "hourly", runs_in: "Server", runs: [run("h1")] },
  ],
};
const shape = (out) => JSON.parse(JSON.stringify(out.map((e) => (e.group ? "G:" + e.group.job.id + ":" + e.group.chats.map((c) => c.id).join("+") + ":" + e.group.unread : e.chat.id))));

// Several runs of one job are one row at the newest run; others keep their place.
let list = [chat("a"), chat("r5", { unread: true }), chat("b"), chat("r4", { unread: true }), chat("r3"), chat("c"), chat("r2", { unread: true })];
let out = group(list, jobs);
assert.deepStrictEqual(shape(out), ["a", "G:j1:r5+r4+r3+r2:3", "b", "c"]);
assert.strictEqual(out[1].group.newest.id, "r5");
// The row lists the job's runs that the list has, newest first.
assert.deepStrictEqual(JSON.parse(JSON.stringify(out[1].group.recent.map((x) => x.chat.id))), ["r5", "r4", "r3", "r2"]);

// A job's runs on another backend are not this backend's (ids are per backend).
out = group([chat("h1")], jobs);
assert.deepStrictEqual(shape(out), ["h1"]);
out = group([chat("h1", { backend_id: "home" })], jobs);
assert.deepStrictEqual(shape(out), ["G:j3:h1:0"]);

// A failed run stays its own row; the job's other runs are grouped.
out = group([chat("d2", { unread: true }), chat("d1", { unread: true })], jobs);
assert.deepStrictEqual(shape(out), ["d2", "G:j2:d1:1"]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(out[1].group.recent.map((x) => x.chat.id))), ["d2", "d1"]);

// A run that waits on an approval or a question stays its own row.
out = group([chat("r5", { needs: "approval" }), chat("r4", { needs: "question", unread: true }), chat("r3", { unread: true })], jobs);
assert.deepStrictEqual(shape(out), ["r5", "r4", "G:j1:r3:1"]);

// A pinned chat is left alone (the caller says which).
out = group([chat("r5", { pinned: true }), chat("r4")], jobs, { skip: (c) => c.pinned });
assert.deepStrictEqual(shape(out), ["r5", "G:j1:r4:0"]);

// A running run is not unread, and marks the row.
out = group([chat("r5", { running: true, unread: true }), chat("r4", { unread: true })], jobs);
assert.strictEqual(out[0].group.unread, 1);
assert.strictEqual(out[0].group.running, true);

// All opened: no unread.
out = group([chat("r5"), chat("r4")], jobs);
assert.strictEqual(out[0].group.unread, 0);

// Chats of no job, and no job data at all, are untouched.
out = group([chat("x"), chat("y")], jobs);
assert.deepStrictEqual(shape(out), ["x", "y"]);
out = group([chat("r5"), chat("x")], null);
assert.deepStrictEqual(shape(out), ["r5", "x"]);
out = group([chat("r5")], { jobs: [] });
assert.deepStrictEqual(shape(out), ["r5"]);

// No more than five runs are listed.
const many = { jobs: [{ backend_id: "pc", id: "m", name: "M", schedule: "s", runs_in: "Sandbox", runs: Array.from({ length: 9 }, (_, i) => run("m" + i)) }] };
out = group(Array.from({ length: 9 }, (_, i) => chat("m" + i)), many);
assert.strictEqual(out.length, 1);
assert.strictEqual(out[0].group.chats.length, 9);
assert.strictEqual(out[0].group.recent.length, 5);
console.log("ok");
