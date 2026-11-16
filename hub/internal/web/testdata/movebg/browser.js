"use strict";
// Drives the real hub page in headless Chrome: a terminal command that the
// fake agent never reports as ended, and Run in background pressed on its
// card. The hub takes the request (202) and no tool.complete comes: the card
// must not show "Moving to the background" for ever, it gets its button back.
// usage: node browser.js CHROME HUB_URL PROFILE_DIR
const assert = require("assert");
const [bin, url, dir] = process.argv.slice(2);
const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

(async () => {
  const c = await connect();
  const { ev } = c;
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await c.load(url + "/auth/login?next=/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Slow"))`, "the Slow session is listed");
  await ev(`[...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith("Slow")).pop().click()`);
  await until(ev, `!document.getElementById("composer").hidden && document.getElementById("log")`, "the chat");
  await until(ev, `!document.getElementById("input").disabled`, "the box");
  await ev(`window.HubMoveBg.wait = 400`);
  await ev(`(() => { const i = document.getElementById("input"); i.value = "run slow"; i.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("send").click(); })()`);
  const card = `[...document.querySelectorAll(".tool.running")].find((x) => /du -sh/.test(x.innerText))`;
  const btn = `(${card} || document.body).querySelector(".acts button")`;
  await until(ev, `${btn} && ${btn}.textContent === "Run in background"`, "the Run in background button");
  await ev(`${btn}.click()`);
  await until(ev, `${btn} && ${btn}.textContent === "Moving to the background"`, "the pill");
  // No event comes: the card reads the state and gives the button back.
  await until(ev, `${btn} && ${btn}.textContent === "Run in background" && !${btn}.disabled`, "the button back after the wait");
  assert.ok(await ev(`!!(${card})`), "the card still runs: the command did not end");
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
