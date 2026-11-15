"use strict";
// Drives the real hub page on a phone: headless Chrome with mobile emulation
// and touch (DevTools protocol), or headless Firefox at phone size (WebDriver
// BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// A chat asks five questions one after the other: a pick from three choices,
// a multi-select question answered with two picks and a typed answer, an
// open question (no choices) answered in its Other row, a subagent's
// question, and one that times out. Asserts that every open question has an
// Other row with a text box, that each question's card keeps every choice
// with the answer checked, when and where it was answered, and that the same
// cards stand after a reload and after a switch to another chat and back.
// With SHOT_DIR set, Chrome also saves screenshots at 412 and 1280 px wide,
// light and dark.
const assert = require("assert");
const [bin, url, dir] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 412;
const H = 915;
const OTHER = "Other (type your own)";

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
      const shot = async (file, width, height, mobile, scheme) => {
        await c.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2.625 : 1, mobile });
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await sleep(300);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        require("fs").writeFileSync(file, Buffer.from(r.data, "base64"));
        await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2.625, mobile: true });
      };
      return { ev: c.ev, nav: (u) => c.send("Page.navigate", { url: u }), reload: () => c.send("Page.reload", {}), tap, shot, close: c.close };
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
      if (Date.now() > end) throw new Error(`${kind}: timed out waiting for ${what}; last ${JSON.stringify(last)}; log tail: ${JSON.stringify(await ev(`document.getElementById("log").innerText.slice(-700)`).catch(() => ""))}`);
      await sleep(25);
    }
  };
  const frames = (n = 3) => ev(`new Promise((res) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  const tapSel = async (sel) => {
    const b = await ev(`(() => { const e = ${sel}; e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.tap(b.x, b.y);
  };
  const typeIn = (sel, text) => ev(`(() => { const i = ${sel}; i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  const cards = `[...document.querySelectorAll("#log .approval")]`;
  const card = (q) => `${cards}.find((a) => a.textContent.includes(${JSON.stringify(q)}))`;
  const open = async (id, title) => {
    await ev(`location.hash = "#/s/pc/${id}"`);
    await until(`location.hash === "#/s/pc/${id}" && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, `${id} to be drawn`);
  };
  // What a closed card shows: its rows (class and text) and its last line.
  const shape = (q) => ev(`(() => { const a = ${card(q)}; if (!a) return null; return { head: a.querySelector("b") && a.querySelector("b").textContent, rows: [...a.querySelectorAll("ul.qchoices li")].map((li) => [li.className, [...li.children].map((x) => x.textContent).join(" ").trim()]), res: a.querySelector(".res") && a.querySelector(".res").textContent, chip: a.querySelector(".by .chip") && a.querySelector(".by .chip").textContent, goal: a.querySelector(".by .goal") && a.querySelector(".by .goal").textContent, buttons: a.querySelectorAll("button:not([disabled]), input:not([disabled])").length }; })()`);
  const waitClosed = (q, tag) => until(`(() => { const a = ${card(q)}; return a && a.classList.contains("qdone"); })()`, `${tag}: the closed card of ${q}`);
  const live = async (q, tag) => {
    await until(`(() => { const a = ${card(q)}; return a && !a.classList.contains("qdone") && a.querySelector("input.answer") && a.querySelector("button:not([disabled])"); })()`, `${tag}: an answerable card for ${q}`);
    await frames(3);
    // Every open question has the Other row with a text box, whatever was offered.
    const other = await ev(`(() => { const a = ${card(q)}; return { label: a.querySelector(".otherlabel") && a.querySelector(".otherlabel").textContent, box: a.querySelectorAll("input.answer").length }; })()`);
    assert.deepStrictEqual(other, { label: OTHER, box: 1 }, `${kind}: the Other row of ${q}`);
    if (process.env.SHOT_DIR && c.shot && /^(Which layouts|What should the release)/.test(q)) {
      await c.shot(`${process.env.SHOT_DIR}/live-${q.slice(0, 5).trim().replace(/\W/g, "")}-412-dark.png`, 412, H, true, "dark");
    }
  };
  const clock = /^Answered at \d{1,2}:\d\d [AP]M \(in the hub\)$/;

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/ask"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");
  await open("ask", "Asking");

  // 1. A pick from three choices.
  const q1 = "What should cpus/a64 be renamed to?";
  await live(q1, "q1");
  await tapSel(`[...${card(q1)}.querySelectorAll("button")].find((b) => b.textContent === "cpus/aarch64")`);
  await waitClosed(q1, "q1");
  let s1 = await shape(q1);
  assert.deepStrictEqual(s1.rows, [["pick", "\u2713 cpus/aarch64"], ["", "cpus/arm64"], ["", "Keep cpus/a64"], ["other", OTHER]], kind + ": a pick keeps every choice");
  assert.ok(clock.test(s1.res), kind + ": when and where: " + s1.res);
  assert.strictEqual(s1.buttons, 0);

  // 2. Several picks and a typed answer in the Other row.
  const q2 = "Which layouts should ship?";
  await live(q2, "q2");
  const boxes = `${card(q2)}.querySelectorAll("input[type=checkbox]")`;
  await tapSel(`${boxes}[0]`);
  await tapSel(`${boxes}[2]`);
  await typeIn(`${card(q2)}.querySelector("input.answer")`, "SNES");
  await tapSel(`[...${card(q2)}.querySelectorAll("button")].find((b) => b.textContent === "Send")`);
  await waitClosed(q2, "q2");
  const s2 = await shape(q2);
  assert.deepStrictEqual(s2.rows, [["pick", "\u2713 Switch"], ["", "Game Boy"], ["pick", "\u2713 NDS"], ["pick other", "\u2713 Other: SNES"]], kind + ": picks and Other together");
  assert.ok(clock.test(s2.res), s2.res);

  // 3. An open question: the Other row is the only input.
  const q3 = "What should the release notes call this feature?";
  await live(q3, "q3");
  assert.strictEqual(await ev(`${card(q3)}.querySelectorAll("input[type=checkbox]").length + ${card(q3)}.querySelectorAll(".choices button").length`), 0, kind + ": an open question has no choices");
  await typeIn(`${card(q3)}.querySelector("input.answer")`, "Pocket mode");
  await tapSel(`[...${card(q3)}.querySelectorAll("button")].find((b) => b.textContent === "Answer")`);
  await waitClosed(q3, "q3");
  const s3 = await shape(q3);
  assert.deepStrictEqual(s3.rows, [["pick other", "\u2713 Other: Pocket mode"]], kind + ": an open answer is the Other row, checked");

  // 4. A subagent's question: the chip with its goal.
  const q4 = "Switch stick clicks (L3 and R3), which some games use?";
  await live(q4, "q4");
  assert.strictEqual(await ev(`${card(q4)}.querySelector(".by .chip").textContent`), "Subagent");
  await tapSel(`[...${card(q4)}.querySelectorAll("button")].find((b) => b.textContent === "Double-tap the stick")`);
  await waitClosed(q4, "q4");
  const s4 = await shape(q4);
  assert.deepStrictEqual([s4.chip, s4.goal], ["Subagent", "relift lane android-apk: on-screen controller"]);
  assert.deepStrictEqual(s4.rows[0], ["pick", "\u2713 Double-tap the stick"]);

  // 5. Nobody answers: the test times it out in the gateway.
  const q5 = "Ship it?";
  await live(q5, "q5");
  await fetch(url + "/__timeout");
  await waitClosed(q5, "q5");
  const s5 = await shape(q5);
  assert.deepStrictEqual(s5.rows.map((r) => r[0]), ["", "", "", "other"], kind + ": nothing is checked");
  assert.strictEqual(s5.res, "No answer: timed out after 30 minutes");

  // The same cards after a reload, and after a switch to another chat and back.
  const all = [q1, q2, q3, q4, q5];
  const before = {};
  for (const q of all) before[q] = await shape(q);
  const count = () => ev(`${cards}.length`);
  assert.strictEqual(await count(), 5, kind + ": one card for each question");
  const same = async (tag) => {
    for (const q of all) {
      await until(`(() => { const a = ${card(q)}; return a && a.classList.contains("qdone"); })()`, `${tag}: the card of ${q}`);
      assert.deepStrictEqual(await shape(q), before[q], `${kind}: the card of ${q} ${tag}`);
    }
    assert.strictEqual(await count(), 5, `${kind}: five cards ${tag}`);
  };
  if (process.env.SHOT_DIR) {
    // The stored cards, as the reader sees them after a reload.
  }
  await open("away", "Other");
  await open("ask", "Asking");
  await same("after a chat switch");
  await ev(`(window.__old = true)`);
  await c.reload();
  await until(`!window.__old && document.getElementById("title").textContent === "Asking" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, "the chat after a reload");
  await same("after a reload");
  await open("away", "Other");
  await open("ask", "Asking");
  await same("after a reload and a switch");

  if (process.env.SHOT_DIR && c.shot) {
    const out = process.env.SHOT_DIR;
    for (const [name, w, h, mobile] of [["412", 412, 2400, true], ["1280", 1280, 1100, false]]) {
      for (const scheme of ["light", "dark"]) {
        await c.shot(`${out}/cards-${name}-${scheme}.png`, w, h, mobile, scheme);
      }
    }
  }
  await c.close();
})().then(() => process.exit(0), (e) => { console.error(e.stack || e); process.exit(1); }).finally(() => { try { proc.kill(); } catch (_) { /* gone */ } });
