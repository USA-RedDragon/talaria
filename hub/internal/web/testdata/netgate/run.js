"use strict";
// Node test of netgate.js (HubNetGate): the page's shared view of a network
// drop. usage: node run.js eventstream.js netgate.js
const assert = require("assert");
const path = require("path");
const { load } = require("../stream/harness.js");

const fresh = (opt) => {
  const w = load(process.argv.slice(2));
  const log = [];
  const g = w.win.HubNetGate(Object.assign({
    now: w.now, rand: () => 1,
    timer: (fn, ms) => { const t = { fn, at: w.now() + ms }; pending.push(t); return t; },
    clear: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
  }, opt));
  const pending = [];
  g.on((what) => log.push(what));
  // advance moves the harness clock and runs the gate's own timers due by then.
  const advance = (ms) => {
    const to = w.now() + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      if (!pending.length || pending[0].at > to) break;
      const t = pending.shift();
      w.advance(Math.max(0, t.at - w.now()));
      t.fn();
    }
    w.advance(to - w.now());
  };
  return { g, log, advance, w };
};

// Classification: no answer is a network failure; an HTTP error is not.
{
  const { g } = fresh();
  assert.ok(g.isNetwork({ name: "TypeError", message: "NetworkError when attempting to fetch resource." }));
  assert.ok(g.isNetwork(Object.assign(new Error("x"), { network: true })));
  assert.ok(g.isNetwork({ name: "AbortError" }));
  assert.ok(!g.isNetwork(Object.assign(new Error("boom"), { status: 500 })));
  assert.ok(!g.isNetwork(Object.assign(new Error("gone"), { status: 404 })));
  assert.ok(!g.isNetwork(new Error("login required")));
  assert.ok(!g.isNetwork(null));
}

// Up: every read goes out and nothing is said.
{
  const { g, log, advance } = fresh();
  for (let i = 0; i < 50; i++) assert.ok(g.allow());
  advance(60000);
  assert.deepStrictEqual(log, []);
  assert.strictEqual(g.quiet(), false);
}

// A short drop (5 s): no quiet state at all, one silent recovery.
{
  const { g, log, advance } = fresh();
  assert.ok(g.allow());
  g.failed();
  advance(5000);
  assert.strictEqual(g.quiet(), false, "no note inside the grace");
  assert.deepStrictEqual(log, []);
  advance(4000);
  g.answered();
  assert.deepStrictEqual(log, ["recovered"], "a drop under 10 s ends without a note");
  assert.strictEqual(g.down(), false);
}

// A long drop: quiet after 10 s, once; back once when it ends.
{
  const { g, log, advance } = fresh();
  g.failed();
  advance(9999);
  assert.deepStrictEqual(log, []);
  advance(2);
  assert.deepStrictEqual(log, ["quiet"]);
  advance(20000);
  assert.deepStrictEqual(log, ["quiet"], "said once");
  assert.ok(g.quiet());
  g.answered();
  assert.deepStrictEqual(log, ["quiet", "back"]);
  assert.strictEqual(g.quiet(), false);
  g.answered();
  assert.deepStrictEqual(log, ["quiet", "back"], "an answer while up says nothing");
}

// Shared backoff: many callers asking every 100 ms for 30 s cost a handful
// of requests; the waits double from 1 s to 30 s.
{
  const { g, advance } = fresh();
  g.failed(); // the first request failed: down
  let sent = 0;
  const times = [];
  for (let t = 0; t < 30000; t += 100) {
    for (let caller = 0; caller < 10; caller++) {
      if (g.allow()) { sent++; times.push(t); g.failed(); }
    }
    advance(100);
  }
  assert.ok(sent >= 4 && sent <= 7, "probes in 30 s: " + sent + " at " + times);
  // With rand=1 the waits are 1000, 2000, 4000, 8000, 16000.
  assert.deepStrictEqual(times.slice(0, 4), [1000, 3000, 7000, 15000]);
}
{
  const { g, advance } = fresh();
  g.failed();
  const gaps = [];
  let last = 0;
  let t = 0;
  while (t < 400000 && gaps.length < 9) {
    if (g.allow()) { gaps.push(t - last); last = t; g.failed(); }
    advance(100);
    t += 100;
  }
  assert.deepStrictEqual(gaps.slice(0, 7), [1000, 2000, 4000, 8000, 16000, 30000, 30000], "doubles to 30 s and stays");
  const lo = fresh({ rand: () => 0 });
  lo.g.failed();
  let first = 0;
  while (!lo.g.allow()) { lo.advance(50); first += 50; }
  assert.ok(first >= 450 && first <= 550, "jitter reaches the lower half: " + first);
}

// One probe at a time: a probe in flight holds the others back; one that
// never answers is let go after the probe limit.
{
  const { g, advance } = fresh();
  g.failed();
  advance(1000);
  assert.ok(g.allow());
  for (let i = 0; i < 20; i++) assert.ok(!g.allow(), "one probe in flight");
  advance(15000);
  assert.ok(g.allow(), "a lost probe is replaced");
}

// Online: the next read is the probe, at once, and the waits start over.
{
  const { g, advance } = fresh();
  g.failed();
  for (let i = 0; i < 5; i++) { advance(40000); g.allow(); g.failed(); }
  assert.ok(!g.allow());
  g.online();
  assert.ok(g.allow(), "probe at once");
  g.failed();
  advance(1000);
  assert.ok(g.allow(), "waits start over at 1 s");
}

// whenBack runs once, on the end of the drop, not on the quiet note.
{
  const { g, advance } = fresh();
  let n = 0;
  g.failed();
  g.whenBack(() => n++);
  advance(11000);
  assert.strictEqual(n, 0);
  g.answered();
  assert.strictEqual(n, 1);
  g.failed();
  g.answered();
  assert.strictEqual(n, 1);
}
// The gate rings the hub by itself on the shared backoff: a drop that ends
// is found within one step, with no caller asking.
{
  let pings = 0;
  let up = false;
  const { g, log, advance } = fresh({ ping: () => { pings++; return Promise.resolve(up); } });
  g.failed();
  (async () => {
    for (let i = 0; i < 6; i++) { advance(1000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
    assert.ok(pings >= 1 && pings <= 3, "few pings in 6 s: " + pings);
    up = true;
    const before = pings;
    for (let i = 0; i < 20 && !log.includes("back"); i++) { advance(1000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
    assert.ok(log.includes("back"), "found the network by itself: " + log);
    assert.ok(pings - before <= 2);
    // online rings at once.
    const h = fresh({ ping: () => { pings++; return Promise.resolve(true); } });
    h.g.failed();
    for (let i = 0; i < 5; i++) { h.advance(30000); await Promise.resolve(); }
    h.g.failed();
    h.g.online();
    h.advance(0);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    assert.ok(h.log.includes("back"), "online rings at once: " + h.log);
    console.log("ok");
  })().catch((e) => { console.error(e); process.exit(1); });
}
