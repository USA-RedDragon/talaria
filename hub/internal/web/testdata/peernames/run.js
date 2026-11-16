"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR
// Asserts that agent_send cards and agent message cards say who the other end
// is in words (a subagent by its goal, a chat by its title, the parent), keep
// the raw id in the open card, never say "subagent subagent", and read the same
// after a reload and a chat switch. Phone and desktop, light and dark.
// PEERNAMES_SHOT=prefix writes screenshots.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

async function shot(c, name) {
  if (!process.env.PEERNAMES_SHOT) return;
  fs.writeFileSync(process.env.PEERNAMES_SHOT + name + ".png", Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
}

const sends = `[...document.querySelectorAll('.tool[data-tool="agent_send"]')]`;
const notes = `[...document.querySelectorAll('.notice[data-kind="agent"]')]`;
const GOAL = "relift lane android-apk: rebuild the APK and sign it with the release key, then…";

const openChat = (c, name) => c.ev(`[...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith(${JSON.stringify(name)})).pop().click()`);

async function titles(c, tag) {
  const { ev } = c;
  await until(ev, `${sends}.length === 4 && ${notes}.length === 2`, tag + ": four sends and two messages");
  // The names come with the Activity list; wait for the goal to show.
  await until(ev, `${sends}[0].querySelector(".notice-title").textContent.includes("relift lane")`, tag + ": the goal names the subagent");
  const got = await ev(`${sends}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(got, [
    'Sent a message to the subagent "' + GOAL + '"',
    "Sent a message to a subagent (sa-0-ffff0000)",
    "Sent a message to the parent",
    'Sent a message to the chat "Other chat"',
  ], tag + ": send titles " + JSON.stringify(got));
  assert.ok(!got.some((t) => /subagent subagent/.test(t)), tag + ": no doubled word");
  const heads = await ev(`${sends}.map((x) => x.querySelector(".notice-head").getBoundingClientRect().height)`);
  assert.ok(heads.every((h) => h < 110), tag + ": short title " + JSON.stringify(heads));
  await until(ev, `${notes}[0].querySelector(".notice-title").textContent.includes("relift lane")`, tag + ": the message card names the subagent");
  const from = await ev(`${notes}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(from, ['Message from the subagent "' + GOAL + '"', "Message from the parent"], tag + ": message titles " + JSON.stringify(from));
}

// ledger: calls that worked have no card and are not in a fold line; the one
// that failed is shown as any other.
async function ledger(c, tag) {
  const { ev } = c;
  await until(ev, `document.querySelectorAll('.tool[data-tool="clarify"], .notice[data-tool="clarify"]').length > 0 || document.body.innerText.includes("no such entry")`, tag + ": the later cards are drawn");
  const shown = await ev(`[...document.querySelectorAll('[data-tool="ledger"]')].filter((x) => x.offsetParent !== null).length`);
  assert.strictEqual(shown, 1, tag + ": only the failed ledger call is shown");
  const text = await ev(`[...document.querySelectorAll("#msgs details.toolgroup > summary, .toolgroup > summary")].map((x) => x.textContent).join(" | ")`);
  assert.ok(!/used ledger/i.test(text.replace(/Used ledger[^|]*step failed/i, "")), tag + ": the fold lines do not count the ledger: " + text);
  assert.ok(/clarify/i.test(text), tag + ": the fold line still counts the others: " + text);
}

async function run(c, w, h, touch, dark) {
  const { ev } = c;
  const tag = (w < 600 ? "412" : "1280") + "-" + (dark ? "dark" : "light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.load(url + "/auth/login?next=/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Names"))`, "the Names session is listed");
  await openChat(c, "Names");
  await titles(c, tag);
  await ledger(c, tag);

  await ev(`document.querySelectorAll("details.toolgroup").forEach((d) => { d.open = true; })`);
  // Open the first send: the id is in the details, not the title.
  await ev(`${sends}[0].scrollIntoView()`);
  await ev(`${sends}[0].querySelector(".notice-head").click()`);
  await until(ev, `!${sends}[0].querySelector(".notice-body-wrap").hidden`, tag + ": send opened");
  const det = await ev(`${sends}[0].querySelector(".notice-body-wrap").textContent`);
  assert.ok(det.includes("sa-0-edd20c0e"), tag + ": the id is in the details: " + det);
  await ev(`${sends}[3].querySelector(".notice-head").click()`);
  await ev(`${sends}[3].scrollIntoView({ block: "center" })`);
  await shot(c, tag + "-sends");
  await ev(`${notes}[0].scrollIntoView({ block: "center" })`);
  await ev(`${notes}[0].querySelector(".notice-head").click()`);
  await until(ev, `!${notes}[0].querySelector(".notice-body-wrap").hidden`, tag + ": message opened");
  assert.ok((await ev(`${notes}[0].querySelector(".notice-body-wrap").innerText`)).includes("sa-0-edd20c0e"), tag + ": the sender's id is in the details");
  await shot(c, tag + "-message");
  assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), tag + ": the page does not scroll sideways");

  // Switch to another chat and back: the names are the same.
  await openChat(c, "Other chat");
  await until(ev, `${sends}.length === 0`, tag + ": another chat open");
  await openChat(c, "Names");
  await titles(c, tag + " after a chat switch");

  // Reload: the same names.
  await c.load(url + "/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Names"))`, "the Names session is listed again");
  await openChat(c, "Names");
  await titles(c, tag + " after a reload");
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
