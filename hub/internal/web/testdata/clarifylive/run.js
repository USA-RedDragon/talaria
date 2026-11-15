"use strict";
// Drives the real hub page on a phone: headless Chrome with mobile emulation
// and touch (DevTools protocol), or headless Firefox at phone size (WebDriver
// BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR QUESTION1 QUESTION2
// A chat waits on a question with three picks (several may be ticked) and a
// second question, of a subagent, comes after the first is answered. Asserts
// the question has an answerable card when the chat is opened fresh, when it
// is shown again after another chat, and after a reload; ticks two picks and
// sends; then types the answer to the second question, which shows live.
const assert = require("assert");
const [bin, url, dir, q1, q2] = process.argv.slice(2);
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
  // The open card of a question: the card with a form, not a closed one.
  const card = (q) => `[...document.querySelectorAll("#log .approval")].find((a) => a.textContent.includes(${JSON.stringify(q)}))`;
  const answerable = async (q, tag) => {
    await until(`(() => { const a = ${card(q)}; return a && /Question/.test(a.textContent) && a.querySelector("button:not([disabled])"); })()`, `${tag}: an answerable card for ${q}`);
    await frames(3);
  };
  const open = async (id, title) => {
    await ev(`location.hash = "#/s/pc/${id}"`);
    await until(`location.hash === "#/s/pc/${id}" && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, `${id} to be drawn`);
  };

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/ask"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");

  // 1. Opened fresh.
  await open("ask", "Asking");
  await answerable(q1, "opened fresh");
  // 2. Shown again after another chat.
  await open("elsewhere", "Other");
  await open("ask", "Asking");
  await answerable(q1, "shown again");
  assert.strictEqual(await ev(`document.querySelectorAll("#log .approval").length`), 1, kind + ": one card, not a copy after switching back");
  // 3. After a reload.
  await ev(`(window.__old = true)`);
  await c.reload();
  await until(`!window.__old && document.getElementById("title").textContent === "Asking" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, "the chat after a reload");
  await answerable(q1, "after a reload");
  assert.strictEqual(await ev(`document.querySelectorAll("#log .approval").length`), 1, kind + ": one card after a reload");

  // The card has the picks (several may be ticked), a box and Skip.
  const form = await ev(`(() => { const a = ${card(q1)}; return { boxes: a.querySelectorAll("input[type=checkbox]").length, text: !!a.querySelector("input.answer"), skip: [...a.querySelectorAll("button")].some((b) => b.textContent === "Skip") }; })()`);
  assert.deepStrictEqual(form, { boxes: 3, text: true, skip: true }, kind + ": the form of the question");
  await tapSel(`${card(q1)}.querySelectorAll("input[type=checkbox]")[0]`);
  await tapSel(`${card(q1)}.querySelectorAll("input[type=checkbox]")[2]`);
  await tapSel(`[...${card(q1)}.querySelectorAll("button")].find((b) => b.textContent === "Send")`);

  // 4. The next question comes live, with the subagent that asks.
  await answerable(q2, "next question");
  assert.ok(await ev(`${card(q2)}.textContent.includes("check the mapping")`), kind + ": the card names the subagent");
  await until(`!${card(q1)}.querySelector("button:not([disabled])")`, "the first card closed");
  await ev(`(() => { const i = ${card(q2)}.querySelector("input.answer"); i.focus(); i.value = "keep defaults"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await tapSel(`[...${card(q2)}.querySelectorAll("button")].find((b) => b.textContent === "Answer")`);
  await until(`document.getElementById("log").innerText.includes("answered: keep defaults")`, "the turn to go on after the last answer");
  await c.close();
})().then(() => process.exit(0), (e) => { console.error(e.stack || e); process.exit(1); }).finally(() => { try { proc.kill(); } catch (_) { /* gone */ } });
