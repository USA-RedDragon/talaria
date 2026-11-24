"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR
// A smart approval card for outside code offers "Allow code from <source> in
// this chat": it names the source, fits the screen at 412 and 1280 px in light
// and dark, and a tap sends the choice. SOURCECARD_SHOT=prefix also writes
// screenshots of the card.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

const LABEL = "Allow code from github.com/AppImage/appimagetool in this chat";
const ALWAYS = "Always allow code from github.com/AppImage/appimagetool";

async function open(c, w, touch, dark) {
  const { ev } = c;
  const tag = w + (dark ? "-dark" : "-light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 915 : 800, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 5 });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.send("Page.navigate", { url: url + "/auth/login?next=/" });
  await until(ev, `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Work"))`, tag + ": the Work session is listed");
  await ev(`(() => { const e = [...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith("Work")).pop(); e.click(); })()`);
  await until(ev, `document.querySelectorAll("#log .approval button").length >= 3`, tag + ": the card is drawn");
  return tag;
}

async function check(c, w, touch, dark) {
  const { ev } = c;
  const tag = await open(c, w, touch, dark);
  const r = await ev(`(() => {
    const a = document.querySelector("#log .approval");
    const vw = document.documentElement.clientWidth;
    const bs = [...a.querySelectorAll("button")];
    const out = bs.map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width) }; });
    const box = a.getBoundingClientRect();
    return { vw, buttons: out, boxRight: Math.round(box.right), scroll: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth, text: a.textContent };
  })()`);
  assert.deepStrictEqual(r.buttons.map((b) => b.t), ["Allow once", LABEL, ALWAYS, "Deny"], tag + ": the buttons " + JSON.stringify(r.buttons));
  assert.ok(r.buttons.every((b) => b.l >= 0 && b.r <= r.vw), tag + ": a button is outside the screen " + JSON.stringify(r));
  assert.ok(r.scroll <= r.client, tag + ": the page scrolls sideways " + JSON.stringify(r));
  assert.ok(r.text.includes("Code from External"), tag + ": the card says why it asks");
  if (process.env.SOURCECARD_SHOT) {
    await ev(`document.querySelector("#log .approval").scrollIntoView({ block: "center" })`);
    await c.frames(2);
    fs.writeFileSync(process.env.SOURCECARD_SHOT + tag + ".png", Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
}

(async () => {
  const c = await connect();
  await c.send("Page.enable");
  for (const dark of [false, true]) {
    await check(c, 412, true, dark);
    await check(c, 1280, false, dark);
  }
  // A tap on the source button sends the choice, and Hermes takes it.
  await open(c, 412, true, false);
  await c.ev(`[...document.querySelectorAll("#log .approval button")].find((b) => b.textContent === ${JSON.stringify(LABEL)}).click()`);
  await until(c.ev, `document.body.innerText.includes("approved: session")`, "Hermes got the chat choice");
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
