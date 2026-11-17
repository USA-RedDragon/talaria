// Unit tests for update.js. Run: node --test extension/firefox/update_test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdater, compareVersions } = require("./update.js");

function rig(over = {}) {
  const calls = { reload: 0, check: 0, reports: [] };
  const timers = [];
  const env = {
    ownVersion: "0.28.1",
    busy: () => false,
    report: (s, v) => calls.reports.push([s, v]),
    runtime: {
      requestUpdateCheck: async () => { calls.check++; return { status: "no_update" }; },
      reload: () => { calls.reload++; },
    },
    setTimeout: (fn, ms) => { const t = { fn, ms, off: false }; timers.push(t); return t; },
    clearTimeout: (t) => { t.off = true; },
    ...over,
  };
  if (over.check) {
    env.runtime.requestUpdateCheck = async () => { calls.check++; return over.check(calls.check); };
  }
  const u = createUpdater(env);
  const fire = () => { const t = timers.filter((x) => !x.off).pop(); if (t) { t.off = true; t.fn(); } return t; };
  return { u, calls, timers, env, fire };
}
const settle = () => new Promise((r) => setImmediate(r));

test("compareVersions", () => {
  assert.equal(compareVersions("0.31.1", "0.28.1"), 1);
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(Number.isNaN(compareVersions("dev", "0.1.0")));
  assert.ok(Number.isNaN(compareVersions("", "0.1.0")));
});

test("a newer daemon triggers one check; the same or older does not", async () => {
  const { u, calls } = rig();
  assert.equal(u.noteVersions("0.28.1", "dev", ""), false);
  assert.equal(u.noteVersions("0.27.0"), false);
  assert.equal(calls.check, 0);
  assert.equal(u.noteVersions("0.31.1"), true);
  await settle();
  assert.equal(calls.check, 1);
  // The config message repeats; the same version asks no more.
  assert.equal(u.noteVersions("0.31.1"), false);
  assert.equal(calls.check, 1);
  // A newer plugin asks again.
  assert.equal(u.noteVersions("0.31.1", "0.32.0"), true);
  await settle();
  assert.equal(calls.check, 2);
  assert.deepEqual(calls.reports.slice(0, 2), [["checking", ""], ["current", ""]]);
});

test("an available update reloads at once when idle", async () => {
  const { u, calls } = rig();
  u.onUpdateAvailable({ version: "0.31.1" });
  assert.equal(calls.reload, 1);
  assert.deepEqual(calls.reports, [["pending", "0.31.1"]]);
});

test("reload waits for an action in flight and never cuts it", async () => {
  let busy = true;
  const { u, calls, fire, timers } = rig({ busy: () => busy });
  u.onUpdateAvailable({ version: "0.31.1" });
  assert.equal(calls.reload, 0);
  assert.equal(u.state(), "pending");
  fire(); // still busy: looks again
  assert.equal(calls.reload, 0);
  assert.equal(timers.filter((t) => !t.off).length, 1);
  busy = false;
  fire();
  assert.equal(calls.reload, 1);
});

test("an action that ends triggers the reload without waiting for the poll", () => {
  let busy = true;
  const { u, calls } = rig({ busy: () => busy });
  u.onUpdateAvailable({ version: "0.31.1" });
  busy = false;
  u.tryReload();
  assert.equal(calls.reload, 1);
});

test("an update that is not newer is ignored, so reload cannot loop", () => {
  const { u, calls } = rig();
  u.onUpdateAvailable({ version: "0.28.1" });
  u.onUpdateAvailable({ version: "0.1.0" });
  u.onUpdateAvailable({});
  u.onUpdateAvailable(undefined);
  assert.equal(calls.reload, 0);
  assert.equal(u.state(), "");
});

test("throttled is reported and retried later", async () => {
  const { u, calls, fire, timers } = rig({ check: (n) => (n === 1 ? { status: "throttled" } : { status: "update_available", version: "0.31.1" }) });
  await u.check();
  assert.deepEqual(calls.reports.map((r) => r[0]), ["checking", "throttled"]);
  assert.equal(timers.length, 1);
  assert.equal(calls.reload, 0);
  fire();
  await settle();
  assert.equal(calls.check, 2);
  assert.equal(calls.reload, 1);
});

test("a failed check is reported and retried, and does not throw", async () => {
  const { u, calls, timers } = rig({ runtime: { requestUpdateCheck: async () => { throw new Error("boom"); }, reload() {} } });
  await u.check();
  assert.deepEqual(calls.reports.at(-1), ["error", ""]);
  assert.equal(timers.length, 1);
});

test("no second check runs while one is in flight or an update waits", async () => {
  let release;
  const { u, calls } = rig({ runtime: { requestUpdateCheck: () => { calls.check++; return new Promise((r) => { release = r; }); }, reload() {} } });
  const p = u.check();
  u.check();
  assert.equal(calls.check, 1);
  release({ status: "no_update" });
  await p;
});

test("update_available in the answer alone also reloads", async () => {
  const { u, calls } = rig({ check: () => ({ status: "update_available", version: "0.31.1" }) });
  await u.check();
  assert.equal(calls.reload, 1);
});
