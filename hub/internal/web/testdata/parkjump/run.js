"use strict";
// Drives the real hub page at desktop size in headless Chrome (DevTools
// protocol) or Firefox (WebDriver BiDi). The sequence of the jumps seen in
// the field: open chat A (long, older rows to come), switch to B (A is
// parked), switch back to A (A is shown again from the park, at its
// newest message), and a fresh snapshot of A comes DELAY ms later and draws
// it again. The reader, who touched nothing, must still see the newest
// message once the snapshot is drawn, a second later, and after its older
// rows came; the page must throw nothing and report no jump.
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR DELAY_MS (env
// PARKJUMP_THROW: one step of drawing the fresh snapshot throws)
// The Go test makes the gateway answer A's resume in DELAY_MS once the page
// is back on A, with a reply stored while A was away, so the snapshot
// differs from what the parked log shows.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const [bin, url, dir, delayArg] = process.argv.slice(2);
const delay = +delayArg;
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1504;
const H = 1002;

const preload = `() => {
  const E = window.EventSource;
  window.__kinds = [];
  window.EventSource = function (u, o) {
    const s = new E(u, o);
    s.addEventListener("message", (m) => { try { const e = JSON.parse(m.data); window.__kinds.push({ t: performance.now(), k: e.kind + (e.provisional ? "*" : ""), u: String(u).split("/").slice(-2, -1)[0] }); } catch (_) { /* not ours */ } });
    return s;
  };
  window.EventSource.prototype = E.prototype;
  window.__errors = [];
  addEventListener("error", (e) => window.__errors.push(String(e.message) + " " + String(e.error && e.error.stack).slice(0, 400)));
  addEventListener("unhandledrejection", (e) => window.__errors.push("rejection " + String(e.reason && e.reason.stack || e.reason).slice(0, 400)));
  window.__reports = [];
  const f0 = window.fetch;
  window.fetch = function (u, o) {
    if (String(u).includes("/api/view-report") && /"kind":"(left|jump)"/.test(String(o && o.body))) window.__reports.push(String(o.body).slice(0, 1500));
    return f0.apply(this, arguments);
  };
}`;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return { proc, connect: async () => {
      const c = await connect();
      await c.send("script.addPreloadScript", { functionDeclaration: preload });
      await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: W, height: H }, devicePixelRatio: 1.5 });
      return { ev: c.ev, nav: (u) => c.goto(u), close: c.close };
    } };
  }
  const { proc, connect } = require("../cdp.js").launch(bin, dir);
  return { proc, connect: async () => {
    const c = await connect();
    await c.send("Page.enable");
    await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + preload + ")()" });
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
    return { ev: c.ev, nav: (u) => c.send("Page.navigate", { url: u }), close: c.close };
  } };
}

const { proc, connect } = driver();
(async () => {
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(25);
    }
  };
  const gap = `(() => { const l = document.getElementById("log"); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`;
  const go = (id) => ev(`(() => { document.querySelector('#sessions a.go[href="#/s/pc/${id}"]').click(); return 1; })()`);
  const snaps = (id) => `window.__kinds.filter((k) => k.u === "${id}" && k.k === "snapshot").length`;
  await c.nav(url + "/auth/login?next=/#/s/pc/parka");
  await until(`location.hash === "#/s/pc/parka" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 5`, "A drawn");
  await until(`window.__kinds.some((k) => k.u === "parka" && k.k === "snapshot.older")`, "A's older rows");
  await sleep(1500);
  assert.ok((await ev(gap)) <= 24, "A does not open at its newest message");
  await until(`document.querySelector('#sessions a.go[href="#/s/pc/parkb"]')`, "B in the list");
  await go("parkb");
  await until(`location.hash === "#/s/pc/parkb" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 5`, "B drawn");
  // A is away long enough for the hub to let go of it; then a reply is
  // stored and the page goes back.
  fs.writeFileSync(path.join(dir, "away"), "");
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, "stored")); i++) await sleep(50);
  assert.ok(fs.existsSync(path.join(dir, "stored")), "the Go side stored no reply");
  const before = await ev(snaps("parka"));
  await go("parka");
  const back = Date.now();
  await until(`location.hash === "#/s/pc/parka" && document.querySelectorAll("#log .msg").length > 5`, "A shown again");
  assert.ok((await ev(gap)) <= 24, "A is not at its newest message when shown again: " + (await ev(gap)));
  if (process.env.PARKJUMP_THROW) {
    // A step of the drawing throws once, as one did in the field (the log
    // was emptied and never put back): the page must still keep the place.
    await ev(`(() => { const f = window.HubToolGroup.fold; let once = true; window.HubToolGroup.fold = function () { if (once) { once = false; throw new Error("drawing failed"); } return f.apply(this, arguments); }; return 1; })()`);
  }
  await until(`${snaps("parka")} > ${before}`, "A's fresh snapshot", delay + 30000);
  const took = Date.now() - back;
  for (const wait of [50, 1000, 3000]) {
    await sleep(wait);
    const g = await ev(gap);
    const st = await ev(`(() => { const l = document.getElementById("log"); return { top: Math.round(l.scrollTop), h: l.scrollHeight, errs: window.__errors, reports: window.__reports }; })()`);
    assert.ok(g <= 24, `A is ${g} px from its newest message ${wait} ms after its fresh snapshot (${took} ms after it was shown again): ${JSON.stringify(st).slice(0, 2500)}`);
  }
  const errs = (await ev(`window.__errors`)).filter((x) => !(process.env.PARKJUMP_THROW && x.includes("drawing failed")));
  assert.deepStrictEqual(errs, [], "the page threw");
  const reps = await ev(`window.__reports`);
  assert.deepStrictEqual(reps, [], "the page reported a jump");
  console.log("ok snapshot after", took, "ms");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
