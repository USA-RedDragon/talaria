"use strict";
// Drives the real hub page on a phone: headless Chrome with mobile
// emulation and touch (DevTools protocol), or headless Firefox at phone
// size (WebDriver BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR POKE_URL
// POKE_URL/start/<chat> starts a turn in the chat as another app does,
// POKE_URL/finish/<chat> ends it (the turn stores the steers it read).
// Asserts that two steers sent to a running turn leave no bubble that
// reads as sending once the turn ended while the reader was in another
// chat: back in the chat (its kept copy), after a reload, and ten minutes
// on. A steer the transcript does not show is kept at most ten minutes
// from when it was sent, however often the chat is drawn again. A message
// that never reaches the hub shows as sending with its retry line, also
// after a switch, until it is sent.
const assert = require("assert");
const [bin, url, dir, poke] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 412;
const H = 915;

// The page records the kind of each chat event it gets and the chat it is for.
const preload = `() => {
  const E = window.EventSource;
  window.__kinds = [];
  window.EventSource = function (u, o) {
    const s = new E(u, o);
    s.addEventListener("message", (m) => { try { const e = JSON.parse(m.data); window.__kinds.push({ k: e.kind, u: String(u).split("/").slice(-2, -1)[0] }); } catch (_) { /* not ours */ } });
    return s;
  };
  window.EventSource.prototype = E.prototype;
}`;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return {
      proc,
      connect: async () => {
        const c = await connect();
        await c.send("script.addPreloadScript", { functionDeclaration: preload });
        await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: W, height: H }, devicePixelRatio: 2.625 });
        return { ev: c.ev, nav: (u) => c.goto(u), reload: () => c.send("browsingContext.reload", { context: c.context, wait: "complete" }), tap: c.click, close: c.close };
      },
    };
  }
  const { proc, connect } = require("../cdp.js").launch(bin, dir);
  return {
    proc,
    connect: async () => {
      const c = await connect();
      await c.send("Page.enable");
      await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + preload + ")()" });
      await c.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
      await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2.625, mobile: true });
      await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const tap = async (x, y) => {
        await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      return { ev: c.ev, nav: (u) => c.send("Page.navigate", { url: u }), reload: () => c.send("Page.reload", {}), tap, close: c.close };
    },
  };
}

const { proc, connect } = driver();
(async () => {
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 30000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`).catch(() => false);
      if (last) return last;
      if (Date.now() > end) throw new Error(`${kind}: timed out waiting for ${what}; last ${JSON.stringify(last)}; log tail: ${JSON.stringify(await ev(`document.getElementById("log").innerText.slice(-400)`).catch(() => ""))}`);
      await sleep(25);
    }
  };
  const frames = (n = 3) => ev(`new Promise((res) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  const hit = (path) => fetch(poke + path).then((r) => assert.strictEqual(r.status, 204, path));
  // The page's clock runs ahead by skew ms from here on, as ten minutes passing would.
  const skew = (ms) => ev(`(() => { const n = window.__now0 || (window.__now0 = Date.now.bind(Date)); window.__skew = ${ms}; Date.now = () => n() + window.__skew; return 1; })()`);
  // pending lists the bubbles that read as sending: dimmed, without a time.
  const pending = () => ev(`Array.from(document.querySelectorAll("#log .msg.user.pending")).map((b) => b.innerText.trim())`);
  const bubbles = (text) => ev(`Array.from(document.querySelectorAll("#log .msg.user")).filter((b) => b.innerText.includes(${JSON.stringify(text)})).length`);
  // A chat is drawn when its title shows and its rows are there, not a loading state.
  // The hub's word on the chat came: a snapshot, or snapshot.same for a
  // chat the page shows as it is.
  const heard = (id, from) => `window.__kinds.slice(${from}).some((k) => k.u === "${id}" && (k.k === "snapshot" || k.k === "snapshot.same"))`;
  const open = async (id, title, ready) => {
    const from = await ev(`(() => { const n = window.__kinds.length; location.hash = "#/s/pc/${id}"; return n; })()`);
    await until(`location.hash === "#/s/pc/${id}" && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0 && ${heard(id, from)}${ready ? " && (" + ready + ")" : ""}`, `${id} to be drawn`);
    await frames(4);
  };
  const send = async (text) => {
    await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await until(`!document.getElementById("send").disabled`, "the send button");
    const b = await ev(`(() => { const r = document.getElementById("send").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.tap(b.x, b.y);
    await until(`document.getElementById("input").value === ""`, "the message box to empty after " + JSON.stringify(text));
  };
  const steered = `document.querySelectorAll("#log .queued").length`;
  const sentToTurn = (n) => until(`Array.from(document.querySelectorAll("#log .queued")).filter((q) => q.textContent.includes("Sent to the running turn")).length === ${n}`, n + " steers marked sent to the running turn");

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/work"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");

  // 1. Two steers to a running turn; the turn ends while the reader is in
  // another chat, so this page never hears their end.
  await open("work", "Steering");
  await hit("/start/work");
  await until(`document.getElementById("subtitle").textContent !== ""`, "the turn to run");
  await send("first steer");
  await sentToTurn(1);
  await send("> quoted line\nsecond steer");
  await sentToTurn(2);
  await open("elsewhere", "Other");
  await hit("/finish/work");
  // Back: the kept copy shows at once, then the chat's snapshot, whose
  // transcript has the steers in one row of their own.
  await open("work", "Steering", `!(${steered}) && Array.from(document.querySelectorAll("#log .msg.user")).some((b) => b.innerText.includes("first steer") && b.innerText.includes("second steer"))`);
  assert.deepStrictEqual(await pending(), [], kind + ": back in the chat, a steer the turn read reads as sending");
  assert.strictEqual(await bubbles("first steer"), 1, kind + ": the first steer shows once");
  assert.strictEqual(await bubbles("second steer"), 1, kind + ": the second steer shows once");
  // Away and back again, and ten minutes on.
  await open("elsewhere", "Other");
  await open("work", "Steering");
  assert.deepStrictEqual(await pending(), [], kind + ": back again, a pending steer");
  await skew(11 * 60 * 1000);
  await open("elsewhere", "Other");
  await open("work", "Steering");
  assert.deepStrictEqual(await pending(), [], kind + ": ten minutes on, a pending steer");
  // A reload (no hard refresh: the service worker serves the page).
  await skew(0);
  await ev(`(window.__old = true)`);
  await c.reload();
  await until(`!window.__old && document.getElementById("title").textContent === "Steering" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0 && ${heard("work", 0)}`, "the chat after a reload");
  await frames(4);
  assert.deepStrictEqual(await pending(), [], kind + ": after a reload, a pending steer");
  assert.strictEqual(await bubbles("first steer"), 1, kind + ": after a reload, the first steer shows once");

  // 2. A steer the transcript does not show is carried as sent lately, but
  // only for ten minutes from when it was sent, however often it is drawn.
  await open("hidden", "Hidden");
  await hit("/start/hidden");
  await until(`document.getElementById("subtitle").textContent !== ""`, "the hidden chat's turn to run");
  await send("steer stored out of sight");
  await sentToTurn(1);
  await open("elsewhere", "Other");
  await hit("/finish/hidden");
  await open("hidden", "Hidden", `!(${steered})`);
  assert.deepStrictEqual(await pending(), ["steer stored out of sight"], kind + ": a steer sent a moment ago and not stored yet is kept");
  await skew(6 * 60 * 1000);
  await open("elsewhere", "Other");
  await open("hidden", "Hidden");
  assert.deepStrictEqual(await pending(), ["steer stored out of sight"], kind + ": six minutes on it is still kept");
  await skew(12 * 60 * 1000);
  await open("elsewhere", "Other");
  await open("hidden", "Hidden");
  assert.deepStrictEqual(await pending(), [], kind + ": twelve minutes after it was sent it is still drawn as sending");
  await skew(0);

  // 3. A message that never reaches the hub reads as sending, with its
  // retry line, also after the reader went to another chat and back.
  await open("elsewhere", "Other");
  await ev(`(() => { const f = window.fetch; window.__block = true; window.fetch = function (u, o) { if (window.__block && String(u).endsWith("/prompt") && o && o.method === "POST") return Promise.reject(new TypeError("Failed to fetch")); return f.apply(this, arguments); }; return 1; })()`);
  await send("never arrives yet");
  await until(`Array.from(document.querySelectorAll("#log .queued")).some((q) => q.textContent.includes("Not sent yet"))`, "the retry line");
  assert.deepStrictEqual(await pending(), ["never arrives yet"], kind + ": an unsent message reads as sending");
  await open("work", "Steering");
  await open("elsewhere", "Other");
  assert.deepStrictEqual(await pending(), ["never arrives yet"], kind + ": back in the chat, the unsent message is gone");
  await until(`Array.from(document.querySelectorAll("#log .queued")).some((q) => q.textContent.includes("Not sent yet"))`, "the retry line after the switch");
  await ev(`(window.__block = false, 1)`);
  await until(`document.querySelectorAll("#log .msg.user.pending").length === 0 && document.getElementById("log").innerText.includes("echo: never arrives yet")`, "the message to be sent and answered");
  assert.strictEqual(await bubbles("never arrives yet"), 1, kind + ": the message sent late shows once");

  console.log(kind + ": ok");
  c.close();
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  try { proc.kill(); } catch (_) { /* gone */ }
  process.exit(1);
});
