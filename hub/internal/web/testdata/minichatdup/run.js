"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol).
// usage: node run.js CHROME_BIN HUB_URL PROFILE_DIR POKE_URL (MINICHAT_SHOTS=dir keeps screenshots)
// A subagent runs; the reader opens Activity, opens its row and sends it a
// message from the page. POKE_URL?text=... makes the subagent read it: a tool
// result, then the steer row Hermes stores. Asserts that the text shows once
// (the bubble, read by the subagent), that the chat opens with the task in
// full and folds a long one after six lines, at 412 and 1280 px, light and dark.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, poke] = process.argv.slice(2);
const shots = process.env.MINICHAT_SHOTS;
const { launch } = require("../cdp.js");

let chrome;
(async () => {
  const { connect, proc } = launch(bin, dir);
  chrome = proc;
  const c = await connect();
  const { ev, send, until } = c;
  await send("Page.enable");
  const view = async (w, h, dark) => {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  };
  const shot = async (name) => {
    if (!shots) return;
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(r.data, "base64"));
  };
  const count = (t) => ev(`(document.querySelector(".act .mc").textContent.split(${JSON.stringify(t)}).length - 1)`);

  await view(412, 915, false);
  await c.load(url + "/auth/login?next=/#/s/pc/s9", `document.querySelector("#actbtn")`, "the chat");
  await until(`!document.getElementById("actbtn").hidden`, "the Activity button");
  await ev(`document.getElementById("actbtn").click()`);
  await until(`document.querySelector(".act .row-head")`, "the subagent row");
  await ev(`document.querySelector(".act .row-head").click()`);
  await until(`document.querySelector(".act .mc .mc-brief")`, "the brief");

  // The brief: whole task, folded after six lines.
  await until(`document.querySelector(".act .mc-brief-text").textContent.includes("Then stop.")`, "the whole task");
  assert.strictEqual(await ev(`document.querySelector(".act .mc").firstElementChild.className`), "mc-brief");
  assert.strictEqual(await ev(`document.querySelector(".act .mc-brief-more").textContent`), "Show all");
  const folded = await ev(`document.querySelector(".act .mc-brief-text").getBoundingClientRect().height`);
  await ev(`document.querySelector(".act .mc-brief-more").click()`);
  const full = await ev(`document.querySelector(".act .mc-brief-text").getBoundingClientRect().height`);
  assert.ok(full > folded + 10, `folded ${folded} full ${full}`);
  assert.strictEqual(await ev(`document.querySelector(".act .mc-brief-more").textContent`), "Show less");
  await ev(`document.querySelector(".act .mc-brief-more").click()`);
  assert.strictEqual(await ev(`getComputedStyle(document.querySelector(".act .mc-brief-text")).userSelect`), "text");

  // Send two messages from the page; the subagent reads them.
  const text1 = "just a note, look at the status bar in the screenshots";
  const text2 = "it's showing over some of the game";
  for (const t of [text1, text2]) {
    await ev(`(() => { const f = document.querySelector(".act form.steer"); f.querySelector("input").value = ${JSON.stringify(t)}; f.requestSubmit(); return 1; })()`);
    await until(`document.querySelectorAll(".act .mc .msg.user").length >= ${t === text1 ? 1 : 2}`, "the bubble");
  }
  const r = await fetch(poke + "/?text=" + encodeURIComponent(text1 + "\n" + text2));
  assert.strictEqual(r.status, 204);
  await until(`/read by the subagent/.test(document.querySelector(".act .mc").textContent)`, "read by the subagent");
  // Wait for the row to have been fetched: the tool group shows the call.
  await until(`document.querySelector(".act .mc").querySelectorAll(".tool, .toolgroup").length > 0`, "the tool step");
  await new Promise((res) => setTimeout(res, 1500));
  assert.strictEqual(await count(text1), 1, await ev(`document.querySelector(".act .mc").innerText`));
  assert.strictEqual(await count(text2), 1);
  assert.strictEqual(await ev(`document.querySelectorAll(".act .mc .note:not([hidden])").length`), 1); // only "Started"
  await ev(`document.querySelector(".act .mc").scrollTop = 1e6`);

  for (const [w, h, dark, name] of [[412, 915, false, "412-light"], [412, 915, true, "412-dark"], [1280, 800, false, "1280-light"], [1280, 800, true, "1280-dark"]]) {
    await view(w, h, dark);
    await c.frames(3);
    await shot(name);
    await ev(`document.querySelector(".act .mc").scrollTop = 0`);
    await c.frames(2);
    await shot(name + "-top");
    await ev(`document.querySelector(".act .mc").scrollTop = 1e6`);
    assert.strictEqual(await count(text1), 1);
  }
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); if (chrome) chrome.kill(); process.exit(1); });
