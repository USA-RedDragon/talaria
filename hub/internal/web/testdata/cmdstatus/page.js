"use strict";
// Drives the real hub page in headless Chrome: /compress shows as a received
// command, a progress line while Hermes summarizes, then a result line; on a
// chat that runs it says it waits for the turn.
// usage: node page.js CHROME HUB_URL PROFILE_DIR (env SHOT_PREFIX writes screenshots)
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const [bin, url, dir] = process.argv.slice(2);
const shot = process.env.SHOT_PREFIX;
const { proc, connect } = require("../cdp.js").launch(bin, dir);

(async () => {
  const c = await connect();
  const { ev, send } = c;
  await send("Page.enable");
  await c.load(url + "/auth/login?next=/", `document.getElementById("sessions").children.length > 0`, "the chat list");

  const shots = async (stage) => {
    if (!shot) return;
    for (const [name, w, h, mobile] of [["412", 412, 915, true], ["1280", 1280, 800, false]]) {
      for (const scheme of ["light", "dark"]) {
        await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2.625 : 1, mobile });
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await c.until(`innerWidth === ${w} && matchMedia("(prefers-color-scheme: dark)").matches === ${scheme === "dark"}`, "the size and scheme");
        // A running chat opens the activity drawer on a phone; close it to show the chat.
        await ev(`(() => { const b = document.getElementById("actclose"); if (b && document.getElementById("act").offsetWidth) b.click(); return 1; })()`);
        await new Promise((r) => setTimeout(r, 700));
        const r = await send("Page.captureScreenshot", {});
        fs.writeFileSync(`${shot}-${stage}-${name}-${scheme}.png`, Buffer.from(r.data, "base64"));
      }
    }
  };
  const typeAndSend = async (text) => {
    await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await c.until(`!document.getElementById("send").disabled`, "the send button");
    await ev(`document.getElementById("send").click()`);
    await c.until(`document.getElementById("input").value === ""`, "the message box to empty");
  };
  const lines = `Array.from(document.querySelectorAll("#log .cmdline")).map((n) => n.textContent)`;

  // An idle chat: the command is received at once, progress shows, then the result.
  await ev(`location.hash = "#/s/pc/s9"; 1`);
  await c.until(`document.querySelectorAll("#log .msg.user").length >= 1 && !document.getElementById("composer").hidden`, "the chat");
  await typeAndSend("/compress");
  await c.until(`document.querySelector("#log .cmdline")`, "the progress line");
  assert.ok((await ev(lines))[0].startsWith("Compressing the chat..."), "progress line: " + (await ev(lines)));
  const bubble = await ev(`(() => { const b = Array.from(document.querySelectorAll("#log .msg.user")).pop(); return { text: b.innerText.trim(), pending: b.classList.contains("pending"), opacity: getComputedStyle(b).opacity }; })()`);
  assert.deepStrictEqual(bubble, { text: "/compress", pending: false, opacity: "1" }, "the command bubble is received, not queued");
  assert.strictEqual(await ev(`document.querySelectorAll("#log .queued").length`), 0, "no queued label");
  await shots("running");
  fs.writeFileSync(path.join(dir, "release"), "1");
  await c.until(`document.querySelector("#log .msg.result")`, "the result");
  const res = await ev(`document.querySelector("#log .msg.result").textContent`);
  assert.match(res, /^Compressed: \d+ tokens to \d+$/);
  assert.strictEqual(await ev(`document.querySelectorAll("#log .cmdline").length`), 0, "the progress line is gone");
  await shots("done");

  // A chat that runs: it says the compression waits for the turn, then runs it.
  await ev(`location.hash = "#/s/pc/s8"; 1`);
  await c.until(`document.querySelectorAll("#log .msg.user").length >= 1 && !document.getElementById("composer").hidden`, "the busy chat");
  await typeAndSend("/compress");
  await c.until(`document.querySelector("#log .cmdline")`, "the waiting line");
  assert.strictEqual((await ev(lines))[0], "The chat is working. It will compress when this turn ends.");
  assert.strictEqual(await ev(`Array.from(document.querySelectorAll("#log .msg.user")).pop().classList.contains("pending")`), false);
  await shots("waiting");
  fs.writeFileSync(path.join(dir, "finish"), "1");
  await c.until(`document.querySelector("#log .msg.result")`, "the result after the turn");
  assert.match(await ev(`document.querySelector("#log .msg.result").textContent`), /^Compressed: \d+ tokens to \d+$/);
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
