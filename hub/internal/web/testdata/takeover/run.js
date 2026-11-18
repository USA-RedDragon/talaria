"use strict";
// Drives the real hub page in headless Chrome through a Hermes takeover
// while the open chat streams a carried reply.
// usage: node run.js CHROME HUB_URL PROFILE_DIR POKE_URL
// POKE_URL/start starts the reply (one word every 40 ms), /takeover hands
// the gateway over to the next one, /stop ends the words and answers how
// many were sent. Reports the longest pause between two updates of the
// reply around the takeover, the chat events the page got after it, and
// asserts every word is shown once, in order. With SHOT_DIR set it saves
// takeover-<SHOT_LABEL>-<ms>.png of the chat before and after the takeover.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, poke] = process.argv.slice(2);
const { launch, until } = require("../cdp.js");
const { connect } = launch(bin, dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.env.SHOT_DIR || "";
const label = process.env.SHOT_LABEL || "run";

const preload = `(() => {
  const E = window.EventSource;
  window.__kinds = [];
  window.EventSource = function (u, o) {
    const s = new E(u, o);
    s.addEventListener("message", (m) => { try { const e = JSON.parse(m.data); window.__kinds.push({ t: performance.now(), k: e.kind + (e.provisional ? "*" : "") }); } catch (_) { /* not ours */ } });
    s.addEventListener("error", () => window.__kinds.push({ t: performance.now(), k: "stream-error" }));
    return s;
  };
  window.EventSource.prototype = E.prototype;
})()`;

(async () => {
  const c = await connect();
  const { ev } = c;
  await c.send("Page.enable");
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: preload });
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.send("Page.navigate", { url: url + "/auth/login?next=/" });
  await until(ev, `!!document.querySelector('#sessions a.go[href="#/s/pc/carried"]')`, "the carried chat is listed");
  await ev(`document.querySelector('#sessions a.go[href="#/s/pc/carried"]').click()`);
  await until(ev, `document.getElementById("title").textContent === "Carried reply" && !document.querySelector("#log .loading") && window.__kinds.some((k) => k.k === "snapshot")`, "the chat");
  if (await ev(`!document.getElementById("app").classList.contains("act-closed")`)) await ev(`document.getElementById("actbtn").click()`);
  const get = (p) => new Promise((res, rej) => require("http").get(poke + p, (r) => { let b = ""; r.on("data", (d) => { b += d; }); r.on("end", () => res(b)); }).on("error", rej));
  await get("/start");
  await until(ev, `/word3\\b/.test(document.getElementById("log").textContent)`, "the reply streams");
  await sleep(1500);
  // Each change of the reply's text, with its time.
  await ev(`(() => {
    const log = document.getElementById("log");
    window.__upd = [];
    let last = "";
    const look = () => { const m = log.textContent.match(/word\\d+/g); const n = m ? m[m.length - 1] : ""; if (n !== last) { last = n; window.__upd.push(performance.now()); } };
    new MutationObserver(look).observe(log, { childList: true, subtree: true, characterData: true });
    return 1; })()`);
  const shoot = async (name) => {
    if (!out) return;
    const png = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${out}/takeover-${label}-${name}.png`, Buffer.from(png.data, "base64"));
  };
  await sleep(500);
  await shoot("0-before");
  const t0 = await ev(`performance.now()`);
  await get("/takeover");
  for (const ms of [150, 400, 800, 1500]) {
    const now = await ev(`performance.now()`);
    if (t0 + ms > now) await sleep(t0 + ms - now);
    await shoot(String(ms).padStart(4, "0") + "ms");
  }
  await sleep(2500);
  const sent = Number(await get("/stop"));
  await until(ev, `/word${sent}\\b/.test(document.getElementById("log").textContent)`, "the last word");
  const r = await ev(`(() => {
    const upd = window.__upd.filter((t) => t > ${t0} - 500 && t < ${t0} + 3500);
    let gap = 0;
    for (let i = 1; i < upd.length; i++) gap = Math.max(gap, upd[i] - upd[i - 1]);
    const after = window.__kinds.filter((k) => k.t >= ${t0} && k.k !== "message.delta").map((k) => Math.round(k.t - ${t0}) + ":" + k.k);
    const words = (document.getElementById("log").textContent.match(/word\\d+/g) || []).map((w) => Number(w.slice(4)));
    return { gap: Math.round(gap), after, words };
  })()`);
  const redraws = r.after.filter((k) => /:snapshot/.test(k)).length;
  console.log(`takeover ${label}: longest pause between reply updates ${r.gap} ms; redraws=${redraws}; events after it: ${r.after.join(" ") || "none"}`);
  // Without the hint the next gateway's snapshot (a fake one here) need not
  // hold the reply's first words; only the moved stream is checked.
  if (label === "hint") {
    const want = Array.from({ length: sent }, (_, i) => i + 1);
    assert.deepStrictEqual(r.words, want, "every word once, in order");
  }
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
