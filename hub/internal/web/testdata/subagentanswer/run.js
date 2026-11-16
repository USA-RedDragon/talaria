"use strict";
// Drives the real hub page on a phone: headless Chrome with mobile emulation
// and touch (DevTools protocol), or headless Firefox at phone size (WebDriver
// BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR SUBAGENT_QUESTION CHAT_QUESTION
// A chat waits on a subagent's question (an older execution generation) and
// on its own. Both have answerable cards; answering the subagent's closes
// only that card, the chat's question stays answerable, also after a reload,
// and answering it lets the turn go on.
const assert = require("assert");
const [bin, url, dir, qSub, qMain] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 412;
const H = 915;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return {
      proc,
      connect: async () => {
        const c = await connect();
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
      if (Date.now() > end) throw new Error(`${kind}: timed out waiting for ${what}; last ${JSON.stringify(last)}; log tail: ${JSON.stringify(await ev(`document.getElementById("log").innerText.slice(-500)`).catch(() => ""))}`);
      await sleep(25);
    }
  };
  const frames = (n = 3) => ev(`new Promise((res) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  const tapSel = async (sel) => {
    const b = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.tap(b.x, b.y);
  };
  const card = (q) => `[...document.querySelectorAll("#log .approval, #log .settled")].find((a) => a.textContent.includes(${JSON.stringify(q)}))`;
  const answerable = async (q, tag) => {
    await until(`(() => { const a = ${card(q)}; return a && /Question/.test(a.textContent) && a.querySelector("button:not([disabled]):not(.notice-head)"); })()`, `${tag}: an answerable card for ${q}`);
    await frames(3);
  };
  const choice = (q, text) => `[...${card(q)}.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)})`;

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/ask"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");
  await ev(`location.hash = "#/s/pc/ask"`);
  await until(`document.getElementById("title").textContent === "Asking" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, "the chat to be drawn");

  // Both questions wait: each has its own answerable card.
  await answerable(qSub, "subagent question");
  await answerable(qMain, "chat question");
  assert.ok(await ev(`${card(qSub)}.textContent.includes("run the lanes")`), kind + ": the subagent's card names the subagent");

  // Answer the subagent: only its card closes.
  await tapSel(choice(qSub, "lane-a"));
  await until(`!${card(qSub)}.querySelector("button:not([disabled]):not(.notice-head)") && /Answered/.test(${card(qSub)}.textContent)`, "the subagent's card to close");
  await frames(5);
  await answerable(qMain, "chat question after the subagent's answer");

  // Still there after a reload.
  await ev(`(window.__old = true)`);
  await c.reload();
  await until(`!window.__old && document.getElementById("title").textContent === "Asking" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, "the chat after a reload");
  await answerable(qMain, "chat question after a reload");
  assert.strictEqual(await ev(`[...document.querySelectorAll("#log .approval")].filter((a) => a.querySelector("button:not([disabled]):not(.notice-head)")).length`), 1, kind + ": one open card after a reload");

  await tapSel(choice(qMain, "ship"));
  await until(`document.getElementById("log").innerText.includes("answered: ship")`, "the turn to go on after the chat's answer");
  await c.close();
})().then(() => process.exit(0), (e) => { console.error(e.stack || e); process.exit(1); }).finally(() => { try { proc.kill(); } catch (_) { /* gone */ } });
