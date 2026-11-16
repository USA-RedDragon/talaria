"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, touch) or
// headless Firefox (WebDriver BiDi, a desktop window) on the Activity panel.
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// Chat s1 has a list, two subagents and two background commands. Asserts the Plan
// is the first thing in the panel, there is no tab bar and no Background tab, a
// command and a subagent share one Running list (and a Finished one), Stop on a
// command works, and the strip above the message box opens the panel at the Plan.
// With MERGE_SHOTS set to a folder (Chrome only) it saves screenshots there.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.MERGE_SHOTS || "";

const open = firefox ? require("../bidi.js").launch(bin, dir) : require("../cdp.js").launch(bin, dir);
const { connect } = open;

(async () => {
  const c = await connect();
  const { ev } = c;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; strip ${await ev(`(document.getElementById("todostrip") || {}).innerText`)}; plan ${await ev(`(document.getElementById("plan") || {}).innerText`)}`);
      await sleep(40);
    }
  };
  let phone = false;
  if (firefox) {
    await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
  } else {
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    phone = true;
  }
  const goto = async (u, ready) => {
    if (firefox) { await c.goto(u); await until(ready, "the page"); } else await c.load(u, ready, "the page");
  };
  const tap = async (sel) => {
    await until(`document.querySelector(${JSON.stringify(sel)})`, "to see " + sel);
    await sleep(120);
    const p = await ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2, w: r.width }; })()`);
    assert.ok(p && p.w, "no box for " + sel);
    if (firefox) await c.click(p.x, p.y);
    else {
      await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
      await sleep(40);
      await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  };
  const strip = () => ev(`(() => { const s = document.getElementById("todostrip"); if (!s || s.hidden) return null; return { cur: s.querySelector(".cur").textContent, cnt: s.querySelector(".cnt").textContent, bar: s.querySelector(".pbar i").style.width, fill: Math.round(s.querySelector(".pbar i").getBoundingClientRect().width), track: Math.round(s.querySelector(".pbar").getBoundingClientRect().width), h: s.getBoundingClientRect().height }; })()`);
  const plan = () => ev(`(() => { const p = document.getElementById("plan"); if (!p) return null; return { count: p.querySelector(".plan-count").textContent, sum: p.querySelector(".plan-sum").textContent,
    items: Array.from(p.querySelectorAll("li.ti")).map((l) => ({ text: l.querySelector(".tt").textContent, cls: l.className, label: l.querySelector(".tl-line .tic").getAttribute("aria-label"), owner: (l.querySelector(":scope > .tl-line .own") || {}).textContent || "", depth: l.parentElement.closest("li.ti") ? 1 : 0 })),
    fold: (p.querySelector(".plan-fold") || {}).textContent || "" }; })()`);
  const isOpen = () => ev(`!document.getElementById("app").classList.contains("act-closed")`);
  const ready = `document.getElementById("todostrip") && !document.getElementById("composer").hidden && document.querySelector("#log") && !document.getElementById("log").hidden`;
  const chatReady = (id) => `location.hash === "#/s/pc/${id}" && ${ready}`;
  const shot = async (name) => {
    if (!shots || firefox) return;
    for (const [w, h] of [[412, 915], [1280, 900]]) {
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        phone = w < 500;
        await until(`innerWidth === ${w}`, "the width");
        for (const panel of ["closed", "open"]) {
          if (panel === "open") { if (!(await isOpen())) await tap("#actbtn"); await until(`document.getElementById("plan") && document.querySelector(".row")`, "the plan"); await ev(`document.getElementById("actbody").scrollTop = 0`); }
          else if (await isOpen()) await tap("#actclose");
          await sleep(500);
          const r = await c.send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(`${shots}/${name}-${panel}-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
        }
      }
    }
    await c.send("Emulation.setEmulatedMedia", { features: [] });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    phone = true;
  };

  await goto(url + "/auth/login?next=/", `document.getElementById("sessions") && document.getElementById("sessions").children.length > 0`);
  await ev(`(location.hash = "#/s/pc/s1", 1)`);
  await until(chatReady("s1"), "chat s1");
  await until(`document.getElementById("todostrip") && !document.getElementById("todostrip").hidden`, "the strip");

  // The strip opens the panel, scrolled to the Plan.
  await tap("#todostrip");
  await until(`!document.getElementById("app").classList.contains("act-closed") && document.getElementById("plan")`, "the panel on the plan");
  assert.strictEqual(await ev(`document.getElementById("actbody").firstElementChild.id`), "plan", "the plan is the first thing in the panel");
  assert.strictEqual(await ev(`document.getElementById("actbody").scrollTop`), 0);
  // No tabs: nothing with role tab, no Background button, no tab bar.
  assert.strictEqual(await ev(`document.querySelectorAll("#act .act-head [role=tab], #act .tabs, #tab-sub, #tab-bg").length`), 0, "no tab bar");
  assert.ok(!/Background/.test(await ev(`document.getElementById("act").innerText`)), "no Background tab");

  // One list: a command and a subagent side by side.
  await until(`document.querySelectorAll("#actbody .row").length === 4`, "the four rows");
  const rows = await ev(`Array.from(document.querySelectorAll("#actbody .row")).map((r) => r.dataset.act)`);
  assert.deepStrictEqual(rows, ["proc_mid", "sa-new", "sa-old", "proc_bad"], "a command and a subagent in one list: running first, then finished, each by start time");
  const sections = await ev(`Array.from(document.querySelectorAll("#actbody > .sec")).map((n) => n.textContent)`);
  assert.deepStrictEqual(sections, ["Running2", "Finished2"], "one Running list with its count, then Finished");
  assert.strictEqual(await ev(`document.getElementById("actcount").textContent`), "2", "the header counts both kinds");
  const order = await ev(`Array.from(document.getElementById("actbody").children).map((n) => n.id === "plan" ? "plan" : n.className.split(" ")[0])`);
  assert.deepStrictEqual(order, ["plan", "sec", "row", "row", "sec", "row", "row"]);
  const cmd = await ev(`(() => { const r = document.querySelector('.row[data-act="proc_mid"]'); return { text: r.innerText, mono: Array.from(r.querySelectorAll("*")).some((n) => /mono/i.test(getComputedStyle(n).fontFamily) && n.textContent.includes("sleep 900")) }; })()`);
  assert.ok(cmd.text.includes("sleep 900") && !/proc_/.test(cmd.text), "the command, no id: " + cmd.text);
  assert.match(await ev(`document.querySelector('.row[data-act="proc_bad"]').innerText`), /Exit 2/);
  assert.ok(!/proc_|sa-/.test(await ev(`document.getElementById("actbody").innerText`)), "no id in the panel");
  await shot("m");

  // Stop on the running command still works.
  await tap('.row[data-act="proc_mid"] .row-head');
  await until(`document.querySelector('.row[data-act="proc_mid"] .danger-text')`, "Stop on the command");
  await tap('.row[data-act="proc_mid"] .danger-text');
  await until(`(() => { const r = document.querySelector('.row[data-act="proc_mid"]'); const s = Array.from(document.querySelectorAll("#actbody > .sec")).map((n) => n.textContent); return r && /Stopped/.test(r.innerText) && s.join() === "Running1,Finished3"; })()`, "the command to move to Finished as stopped", 30000);
  assert.strictEqual(await ev(`document.getElementById("actcount").textContent`), "1");
  console.log("ok");
  c.close();
})().catch((e) => { console.error(e); process.exit(1); });
