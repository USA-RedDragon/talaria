"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol).
// usage: node run.js CHROME_BIN HUB_URL PROFILE_DIR (BRIEF_SHOTS=dir keeps screenshots)
// A subagent runs with a goal of eight lines and a context of eleven. Asserts:
// the row's title is one line; a tap on it opens the whole goal (line breaks
// kept, the row stays closed) and a second tap closes it; Enter and Space do
// the same from the keyboard; the small chat opens with Task and then Context,
// each folded after six lines with Show all / Show less and selectable text;
// at 412 and 1280 px, light and dark.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const shots = process.env.BRIEF_SHOTS;
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
  const key = async (k, code, vk, text) => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code, windowsVirtualKeyCode: vk, text: type === "keyDown" ? text : undefined });
  };
  const title = `document.querySelector(".act .row-head .goal")`;
  const h = (sel) => ev(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().height`);

  await view(412, 915, false);
  await c.load(url + "/auth/login?next=/#/s/pc/s9", `document.querySelector("#actbtn")`, "the chat");
  await until(`!document.getElementById("actbtn").hidden`, "the Activity button");
  await ev(`document.getElementById("actbtn").click()`);
  await until(`document.querySelector(".act .row-head .goal")`, "the subagent row");

  // The title is the goal's first line, on one line.
  assert.strictEqual(await ev(`${title}.textContent`), "Audit the status bar in the game UI.");
  assert.strictEqual(await ev(`${title}.getAttribute("role")`), "button");
  assert.strictEqual(await ev(`${title}.getAttribute("aria-expanded")`), "false");
  const one = await h(".act .row-head .goal");
  assert.ok(one < 30, `one line is ${one}px`);

  // A tap opens the whole goal under the same title; the row does not open.
  await ev(`${title}.click()`);
  const lines = await ev(`${title}.textContent`);
  assert.ok(lines.startsWith("Audit the status bar") && lines.endsWith("Then stop.") && lines.split("\n").length === 8, lines);
  assert.strictEqual(await ev(`${title}.getAttribute("aria-expanded")`), "true");
  assert.ok((await h(".act .row-head .goal")) > one * 4, "the goal shows all its lines");
  assert.strictEqual(await ev(`document.querySelectorAll(".act .row.open").length`), 0);
  assert.strictEqual(await ev(`getComputedStyle(${title}).userSelect`), "text");
  assert.strictEqual(await ev(`getComputedStyle(${title}).whiteSpace`), "pre-wrap");
  // A second tap closes it.
  await ev(`${title}.click()`);
  assert.strictEqual(await ev(`${title}.textContent`), "Audit the status bar in the game UI.");
  assert.ok((await h(".act .row-head .goal")) < 30);
  // The keyboard: the title is a tab stop; Enter opens, Space closes.
  await ev(`${title}.focus()`);
  assert.strictEqual(await ev(`document.activeElement === ${title}`), true);
  await key("Enter", "Enter", 13, "\r");
  assert.strictEqual(await ev(`${title}.getAttribute("aria-expanded")`), "true");
  assert.strictEqual(await ev(`document.querySelectorAll(".act .row.open").length`), 0);
  await ev(`${title}.focus()`);
  await key(" ", "Space", 32, " ");
  assert.strictEqual(await ev(`${title}.getAttribute("aria-expanded")`), "false");

  // Open the row from its header: the chat opens with the task, then the context.
  await ev(`document.querySelector(".act .row-head .meta").click()`);
  await until(`document.querySelectorAll(".act .mc .mc-brief").length === 2`, "the task and the context");
  const heads = await ev(`[...document.querySelectorAll(".act .mc .mc-brief-head")].map((x) => x.textContent)`);
  assert.deepStrictEqual(heads, ["Task", "Context"]);
  assert.strictEqual(await ev(`document.querySelector(".act .mc").firstElementChild.className`), "mc-brief");
  const order = await ev(`[...document.querySelector(".act .mc").children].slice(0, 3).map((x) => x.className.split(" ")[0])`);
  assert.deepStrictEqual(order, ["mc-brief", "mc-brief", "note"]);
  const ctx = await ev(`document.querySelectorAll(".act .mc-brief-text")[1].textContent`);
  assert.ok(ctx.startsWith("Background:\n- The status bar") && ctx.endsWith("End of the context.") && ctx.includes("\n\n"), ctx);
  // Each folds after six lines on its own, and opens with Show all.
  const text = (i) => `document.querySelectorAll(".act .mc-brief-text")[${i}]`;
  const more = (i) => `document.querySelectorAll(".act .mc-brief-more")[${i}]`;
  assert.strictEqual(await ev(`document.querySelectorAll(".act .mc-brief-more").length`), 2);
  for (const i of [0, 1]) {
    assert.strictEqual(await ev(`${more(i)}.textContent`), "Show all");
    const folded = await ev(`${text(i)}.getBoundingClientRect().height`);
    await ev(`${more(i)}.click()`);
    const full = await ev(`${text(i)}.getBoundingClientRect().height`);
    assert.ok(full > folded + 10, `brief ${i}: folded ${folded} full ${full}`);
    assert.strictEqual(await ev(`${more(i)}.textContent`), "Show less");
    assert.strictEqual(await ev(`${more(i)}.getAttribute("aria-expanded")`), "true");
    await ev(`${more(i)}.click()`);
    assert.strictEqual(await ev(`${more(i)}.textContent`), "Show all");
    assert.strictEqual(await ev(`getComputedStyle(${text(i)}).userSelect`), "text");
  }
  // The keyboard reaches Show all too.
  await ev(`${more(1)}.focus()`);
  await key("Enter", "Enter", 13, "\r");
  assert.strictEqual(await ev(`${more(1)}.textContent`), "Show less");
  await ev(`${more(1)}.click()`);

  for (const [w, h2, dark, name] of [[412, 915, false, "412-light"], [412, 915, true, "412-dark"], [1280, 800, false, "1280-light"], [1280, 800, true, "1280-dark"]]) {
    await view(w, h2, dark);
    await c.frames(3);
    // Title open, both folds open on the desktop, closed on the phone's second shot.
    await ev(`document.querySelector(".act .mc").scrollTop = 0`);
    await ev(`(() => { const t = ${title}; if (t.getAttribute("aria-expanded") !== "true") t.click(); return 1; })()`);
    await c.frames(2);
    assert.strictEqual(await ev(`getComputedStyle(${title}).whiteSpace`), "pre-wrap", "the open title keeps its line breaks while the row is open");
    await shot(name + "-title-open");
    await ev(`${title}.click()`);
    await c.frames(2);
    await shot(name);
    await ev(`${more(0)}.click(); ${more(1)}.click();`);
    await c.frames(2);
    await shot(name + "-unfolded");
    await ev(`${more(0)}.click(); ${more(1)}.click();`);
    await ev(`document.querySelector(".act .mc").scrollTop = 0`);
    assert.strictEqual(await ev(`${more(0)}.textContent + ${more(1)}.textContent`), "Show allShow all");
  }
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); if (chrome) chrome.kill(); process.exit(1); });
