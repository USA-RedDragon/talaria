"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR
// Asserts that a browser_batch call is one card with a plain-words title, a
// numbered list of its steps with outcomes and the page read at the end, that
// a stopped batch says where it stopped, and that single browser cards name the
// element by its label ("Typed into Search", "Pressed Enter"), never by a ref.
// Phone and desktop, light and dark. BROWSERCARDS_SHOT=prefix writes screenshots.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

async function shot(c, name) {
  if (!process.env.BROWSERCARDS_SHOT) return;
  fs.writeFileSync(process.env.BROWSERCARDS_SHOT + name + ".png", Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
}

const cards = `[...document.querySelectorAll('.tool[data-tool^="browser_"]')]`;

// seen scrolls card n to the top of the chat and waits until it stays there.
async function seen(c, n, tag) {
  await c.poll(async () => {
    await c.ev(`${cards}[${n}].scrollIntoView({ block: "start" })`);
    await c.frames(3);
    return c.ev(`(() => { const b = ${cards}[${n}].getBoundingClientRect(); return b.top > 40 && b.top < 200; })()`);
  }, tag + ": card " + n + " in view");
}

// whole scrolls card n so that all of it is on screen (the last cards of the
// chat cannot reach the top) and waits until it stays there.
async function whole(c, n, tag) {
  await c.poll(async () => {
    await c.ev(`${cards}[${n}].scrollIntoView({ block: "end" })`);
    await c.frames(3);
    return c.ev(`(() => { const b = ${cards}[${n}].getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; })()`);
  }, tag + ": card " + n + " fully in view");
}

async function run(c, w, h, touch, dark) {
  const { ev } = c;
  const tag = (w < 600 ? "412" : "1280") + "-" + (dark ? "dark" : "light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.load(url + "/auth/login?next=/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Browser"))`, "the Browser session is listed");
  await ev(`[...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith("Browser")).pop().click()`);
  await until(ev, `${cards}.length === 8`, tag + ": eight browser cards");
  await ev(`document.querySelectorAll("details.toolgroup").forEach((d) => { d.open = true; })`);
  const titles = await ev(`${cards}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(titles, [
    "Filled the form on support.example.com: 4 steps",
    "Filled the form on support.example.com: 2 of 4 steps",
    "Typed into Search", "Pressed Enter in Search", "Clicked Save", "Hovered over Account menu",
    "Browser steps not run: 3", "Ran 1 of 3 steps"], tag + ": titles " + JSON.stringify(titles));
  assert.ok(!/\be\d+\b/.test(titles.join(" ")), tag + ": no ref in a title");
  const metas = await ev(`${cards}.map((x) => x.querySelector(".notice-meta").textContent)`);
  assert.ok(/^Done/.test(metas[0]) && /^Stopped at step 3/.test(metas[1]), tag + ": meta " + JSON.stringify(metas));
  assert.strictEqual(await ev(`${cards}[1].dataset.state`), "bad", tag + ": the stopped batch is marked");
  assert.strictEqual(await ev(`${cards}[0].dataset.state`), "ok");

  // The first batch, open: the steps, then the page.
  await ev(`${cards}[0].scrollIntoView()`);
  await ev(`${cards}[0].querySelector(".notice-head").click()`);
  await until(ev, `!${cards}[0].querySelector(".notice-body-wrap").hidden && ${cards}[0].querySelectorAll("ol.steps li").length === 4`, tag + ": four steps");
  const steps = await ev(`[...${cards}[0].querySelectorAll("ol.steps li")].map((l) => l.innerText.replace(/\\s+/g, " ").trim())`);
  assert.strictEqual(steps[0], 'Typed into "Subject" Done', tag + ": " + JSON.stringify(steps));
  assert.strictEqual(steps[3], 'Pressed Enter on "Description" (submitted) Done · approved once for the batch');
  assert.ok(/Ticket created - Acme Support/.test(await ev(`${cards}[0].querySelector(".pagemeta").textContent`)), tag + ": page meta");
  assert.ok(/View ticket/.test(await ev(`${cards}[0].querySelector(".tool-page-read pre").textContent`)), tag + ": page text");
  await ev(`${cards}[0].scrollIntoView()`);
  await seen(c, 0, tag);
  await shot(c, tag + "-batch-open");

  // The stopped batch.
  await ev(`${cards}[1].scrollIntoView()`);
  await ev(`${cards}[1].querySelector(".notice-head").click()`);
  await until(ev, `${cards}[1].querySelectorAll("ol.steps li").length === 4`, tag + ": steps of the stopped batch");
  const bad = await ev(`[...${cards}[1].querySelectorAll("ol.steps li")].map((l) => l.innerText.replace(/\\s+/g, " ").trim())`);
  assert.ok(/^Selected "Urgent" in "Priority" Failed: no option "Urgent"/.test(bad[2]), tag + ": " + JSON.stringify(bad));
  assert.strictEqual(bad[3], "Pressed Enter Not run");
  assert.ok(await ev(`getComputedStyle(${cards}[1].querySelector("ol.steps li:nth-child(3) .notice-bad")).color !== getComputedStyle(${cards}[1].querySelector("ol.steps li .notice-ok")).color`), tag + ": a failed step is colored apart");
  await seen(c, 1, tag);
  await shot(c, tag + "-batch-stopped");

  // A batch the plugin refused before any step: never an empty body. The
  // whole error, then the steps asked for, the invalid one marked.
  await ev(`${cards}[6].scrollIntoView()`);
  await ev(`${cards}[6].querySelector(".notice-head").click()`);
  await until(ev, `${cards}[6].querySelectorAll("ol.steps li").length === 3`, tag + ": steps of the refused batch");
  const refused = await ev(`[...${cards}[6].querySelectorAll("ol.steps li")].map((l) => l.innerText.replace(/\\s+/g, " ").trim())`);
  assert.deepStrictEqual(refused, ["Open support.example.com Not run", "Click the button Not valid", 'Type into "Subject" Not run'], tag + ": " + JSON.stringify(refused));
  assert.ok(await ev(`${cards}[6].querySelector(".tool-q").textContent.includes("the element's label on the page)")`), tag + ": the whole error is shown");
  assert.ok(!(await ev(`${cards}[6].innerText.includes("hello")`)), tag + ": typed text is not shown");
  assert.strictEqual(await ev(`${cards}[6].dataset.state`), "bad");
  await whole(c, 6, tag);
  await shot(c, tag + "-batch-refused");

  // A batch that ran out of time: the step it never reached is listed as not run.
  await ev(`${cards}[7].scrollIntoView()`);
  await ev(`${cards}[7].querySelector(".notice-head").click()`);
  await until(ev, `${cards}[7].querySelectorAll("ol.steps li").length === 3`, tag + ": steps of the partial batch");
  const part = await ev(`[...${cards}[7].querySelectorAll("ol.steps li")].map((l) => l.innerText.replace(/\\s+/g, " ").trim())`);
  assert.ok(/Failed: the batch ran out of time/.test(part[1]) && part[2] === "Wait for Ticket created Not run", tag + ": " + JSON.stringify(part));
  await whole(c, 7, tag);
  await shot(c, tag + "-batch-partial");
  await ev(`${cards}[6].querySelector(".notice-head").click(); ${cards}[7].querySelector(".notice-head").click()`);

  // Single cards, closed together.
  await ev(`${cards}[0].querySelector(".notice-head").click(); ${cards}[1].querySelector(".notice-head").click()`);
  await ev(`${cards}[2].scrollIntoView({ block: "center" })`);
  await shot(c, tag + "-single");
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
