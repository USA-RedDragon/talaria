"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, touch) or
// headless Firefox (WebDriver BiDi; picked when the path has "firefox" in it,
// a desktop window) on the agent's to-do list.
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// The fake agent's chat s1 has a list of 15 items with a blocked item, a
// cancelled one and two items owned by subagents, and three subagents, one with a
// list of its own; chat s2 has no list and s3 is on an agent server without lists.
// Asserts the Plan section above the subagents, the strip above the message box
// (its words, its count, a tap that opens the panel on the plan), the owner chips
// named by goal, notes that open on a tap, folded done items, a live update with no
// reload, a subagent's own list in its card, and that all of it comes back after a
// reload and a switch to another chat; a chat with no list, or on an older agent
// server, shows none of it.
// The page cannot call Go: it asks through files in the profile (update, child).
// With TODOUI_SHOTS set to a folder (Chrome only) it saves screenshots there.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.TODOUI_SHOTS || "";

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
          if (panel === "open") { if (!(await isOpen())) await tap("#actbtn"); await until(`document.getElementById("plan")`, "the plan"); await ev(`document.getElementById("actbody").scrollTop = 0`); }
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

  // The strip above the message box: the first item in progress, how far, and no panel yet on a phone.
  await until(`document.getElementById("todostrip") && !document.getElementById("todostrip").hidden`, "the strip");
  let s = await strip();
  assert.strictEqual(s.cur, "Thor touch: confirm touch reaches the guest");
  assert.strictEqual(s.cnt, "6 of 15");
  assert.strictEqual(s.bar, "40%");
  assert.ok(s.fill > 0 && Math.abs(s.fill - s.track * 0.4) <= 2, "the bar fills 40% of its track: " + s.fill + " of " + s.track);
  assert.ok(s.h > 30 && s.h < 80, "the strip is one line: " + s.h);
  const order = await ev(`(() => { const f = document.getElementById("composer"); const st = document.getElementById("todostrip"); return st.nextElementSibling === f; })()`);
  assert.ok(order, "the strip sits right above the message box");
  if (phone) assert.strictEqual(await isOpen(), false, "the panel is closed on a phone");

  // A tap on the strip opens the panel on the plan.
  await tap("#todostrip");
  await until(`!document.getElementById("app").classList.contains("act-closed") && document.getElementById("plan")`, "the panel on the plan");
  const first = await ev(`document.getElementById("actbody").firstElementChild.id`);
  assert.strictEqual(first, "plan", "the plan is the first thing in the panel");
  assert.strictEqual(await ev(`document.getElementById("actbody").scrollTop`), 0);
  let p = await plan();
  assert.strictEqual(p.count, "6 of 15 done");
  assert.strictEqual(p.sum, "2 in progress · 1 blocked · 5 to do · 1 cancelled");
  const byText = (t) => p.items.find((i) => i.text.startsWith(t));
  assert.ok(/done/.test(byText("Android build").cls) && byText("Android build").label === "Done");
  assert.ok(/prog/.test(byText("Re:Zero").cls) && byText("Re:Zero").label === "In progress");
  assert.strictEqual(byText("APK size").label, "Blocked");
  assert.strictEqual(byText("Launcher icon").label, "To do");
  assert.strictEqual(byText("Try Turnip").label, "Cancelled");
  assert.strictEqual(byText("Thor touch").depth, 1, "a subtask nests under its parent");
  assert.strictEqual(byText("Thor touch").owner, "android-rezero", "the owner is named by its goal");
  assert.strictEqual(byText("APK size").owner, "apk-size");
  assert.ok(!/sa-/.test(JSON.stringify(p.items.map((i) => i.owner))), "no raw subagent id");
  assert.strictEqual(p.fold, "Show 4 done", "finished items fold after the first few");
  assert.strictEqual(p.items.length, 11);
  // The Plan is above Subagents.
  const heads = await ev(`Array.from(document.querySelectorAll("#actbody > .sec, #actbody > .plan")).map((n) => n.className.split(" ")[0] + ":" + (n.querySelector(".plan-head") ? "Plan" : n.textContent))`);
  assert.deepStrictEqual(heads.slice(0, 2), ["plan:Plan", "sec:Subagents"]);
  // Done items show on a tap.
  await tap("#plan .plan-fold");
  await until(`document.querySelectorAll("#plan li.ti").length === 15`, "the done items");
  assert.strictEqual((await plan()).fold, "Hide done");
  await tap("#plan .plan-fold");
  await until(`document.querySelectorAll("#plan li.ti").length === 11`, "the done items folded");
  // A note shows one line and opens on a tap.
  const note = `#plan li[data-todo="touch"] .tn`;
  assert.strictEqual(await ev(`getComputedStyle(document.querySelector(${JSON.stringify(note)})).whiteSpace`), "nowrap");
  await tap(note);
  await until(`document.querySelector(${JSON.stringify(note)}).getAttribute("aria-expanded") === "true" && getComputedStyle(document.querySelector(${JSON.stringify(note)})).whiteSpace !== "nowrap"`, "the note to open");

  // A subagent's own list in its card: counts and the current item, the whole tree after a tap.
  await until(`document.querySelector('.row[data-act="sa-rz"] .sp-line')`, "the subagent's list line");
  assert.strictEqual(await ev(`document.querySelector('.row[data-act="sa-rz"] .sp-cur').textContent`), "Read the libnx touch test");
  assert.strictEqual(await ev(`document.querySelector('.row[data-act="sa-rz"] .sp-cnt').textContent`), "1 of 4");
  assert.strictEqual(await ev(`document.querySelectorAll('.row[data-act="sa-rz"] .tl').length`), 0, "collapsed");
  assert.strictEqual(await ev(`document.querySelector('.row[data-act="sa-apk"] .subplan')`), null, "a subagent with no list has no line");
  await tap('.row[data-act="sa-rz"] .sp-line');
  await until(`document.querySelectorAll('.row[data-act="sa-rz"] li.ti').length === 4`, "the subagent's whole list");
  assert.strictEqual(await ev(`document.querySelector('.row[data-act="sa-rz"]').classList.contains("open")`), false, "opening the list does not open the row");
  assert.strictEqual(await ev(`document.querySelectorAll('.row[data-act="sa-rz"] .own').length`), 0);
  await shot("a");

  // A live update with no reload: the agent moves on, and the strip and plan follow.
  fs.writeFileSync(path.join(dir, "update"), "1");
  await until(`document.getElementById("todostrip").querySelector(".cur").textContent === "Launcher icon and name"`, "the strip to follow the agent");
  s = await strip();
  assert.strictEqual(s.cnt, "7 of 15");
  await until(`document.querySelector("#plan .plan-count").textContent === "7 of 15 done"`, "the plan to follow");
  // A subagent's list changes: its card follows (the activity poll carries its brief).
  fs.writeFileSync(path.join(dir, "child"), "1");
  await until(`document.querySelector('.row[data-act="sa-rz"] .sp-cnt').textContent === "2 of 4"`, "the subagent's count", 30000);
  await until(`document.querySelectorAll('.row[data-act="sa-rz"] li.ti.done').length === 2`, "the subagent's open list to follow");

  // After a reload everything is back.
  await goto(url + "/?r=1#/s/pc/s1", chatReady("s1"));
  await until(`document.getElementById("todostrip") && !document.getElementById("todostrip").hidden`, "the strip after a reload");
  s = await strip();
  assert.deepStrictEqual([s.cur, s.cnt], ["Launcher icon and name", "7 of 15"]);
  await tap("#todostrip");
  await until(`document.getElementById("plan")`, "the plan after a reload");
  assert.strictEqual((await plan()).count, "7 of 15 done");

  // A chat with no list shows none of it, and the list is back on return.
  await ev(`(location.hash = "#/s/pc/s2", 1)`);
  await until(chatReady("s2"), "chat s2");
  await sleep(800);
  assert.strictEqual(await strip(), null, "no strip in a chat with no list");
  assert.strictEqual(await plan(), null, "no plan in a chat with no list");
  // An older agent server: nothing and no error.
  await ev(`(location.hash = "#/s/pc/s3", 1)`);
  await until(chatReady("s3"), "chat s3");
  await sleep(800);
  assert.strictEqual(await strip(), null);
  assert.strictEqual(await plan(), null);
  assert.ok(!/Could not load activity/.test(await ev(`document.getElementById("actsum").textContent`)), "no error on an older server");
  await ev(`(location.hash = "#/s/pc/s1", 1)`);
  await until(chatReady("s1"), "chat s1 again");
  await until(`document.getElementById("todostrip") && !document.getElementById("todostrip").hidden`, "the strip on return");
  assert.strictEqual((await strip()).cnt, "7 of 15");

  // Everything done: the strip goes, the plan stays.
  fs.writeFileSync(path.join(dir, "finish"), "1");
  await until(`document.getElementById("todostrip").hidden`, "the strip to go when all is done");
  await tap("#actbtn").catch(() => {});
  await until(`document.getElementById("plan")`, "the plan to stay");
  await shot("b");
  console.log("ok");
  c.close();
})().catch((e) => { console.error(e); process.exit(1); });
