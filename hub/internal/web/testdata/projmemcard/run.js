"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR
// Asserts that a project_memory card names the project (relift), never the raw
// key (root:<sha>), that a remove which matched nothing is a red failure card
// with the error and the closest entries, and that the raw key shows only in
// the opened details. Phone and desktop, light and dark. PROJMEM_SHOT=prefix
// writes screenshots.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

async function shot(c, name) {
  if (!process.env.PROJMEM_SHOT) return;
  fs.writeFileSync(process.env.PROJMEM_SHOT + name + ".png", Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
}

const cards = `[...document.querySelectorAll('.tool[data-tool="project_memory"]')]`;
const KEY = "root:fbf7b093b915dfa01651a528d629ab4cbbb217fb";

async function run(c, w, h, touch, dark) {
  const { ev } = c;
  const tag = (w < 600 ? "412" : "1280") + "-" + (dark ? "dark" : "light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.load(url + "/auth/login?next=/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Notes"))`, "the Notes session is listed");
  await ev(`[...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith("Notes")).pop().click()`);
  await until(ev, `${cards}.length === 2`, tag + ": two project note cards");
  await ev(`document.querySelectorAll("details.toolgroup").forEach((d) => { d.open = true; })`);
  const titles = await ev(`${cards}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(titles, ["Added a project note to relift", "Could not remove a project note from relift"], tag + ": " + JSON.stringify(titles));
  assert.ok(!titles.join(" ").includes("root:"), tag + ": no raw key in a title");
  const metas = await ev(`${cards}.map((x) => x.querySelector(".notice-meta").textContent)`);
  assert.strictEqual(metas[0], "Saved", tag + ": " + JSON.stringify(metas));
  assert.ok(/^Failed: no note matched “Honcho/.test(metas[1]), tag + ": " + JSON.stringify(metas));
  assert.strictEqual(await ev(`${cards}[0].dataset.state`), "ok");
  assert.strictEqual(await ev(`${cards}[1].dataset.state`), "bad", tag + ": the failed write is marked");
  const color = (n, sel) => ev(`getComputedStyle(${cards}[${n}].querySelector("${sel}")).color`);
  assert.notStrictEqual(await color(0, ".notice-meta"), await color(1, ".notice-meta"), tag + ": a failure is colored apart");

  await ev(`${cards}[1].querySelector(".notice-head").click()`);
  await until(ev, `!${cards}[1].querySelector(".notice-body-wrap").hidden`, tag + ": the failed card opens");
  const body = await ev(`${cards}[1].innerText`);
  assert.ok(body.includes("Memory is kept in project notes"), tag + ": the closest entries are in the details");
  assert.ok(!body.includes(KEY), tag + ": no raw project key on the card");
  await ev(`${cards}[1].scrollIntoView({ block: "center" })`);
  await c.frames(3);
  await shot(c, tag + "-failed");
  await ev(`${cards}[1].querySelector(".notice-head").click(); ${cards}[0].scrollIntoView({ block: "center" })`);
  await c.frames(3);
  await shot(c, tag + "-saved");
  assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), tag + ": the page does not scroll sideways");
}

(async () => {
  const c = await connect();
  await c.send("Page.enable");
  await run(c, 412, 915, true, false);
  await run(c, 412, 915, true, true);
  await run(c, 1280, 800, false, false);
  await run(c, 1280, 800, false, true);
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
