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
  await until(ev, `${sends}.length === 4 && ${notes}.length === 4`, tag + ": four sends and four messages");
  // The names come with the Activity list; wait for the goal to show.
  await until(ev, `${sends}[0].querySelector(".notice-title").textContent.includes("relift lane")`, tag + ": the goal names the subagent");
  const got = await ev(`${sends}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(got, [
    'Sent a message to the subagent "' + GOAL + '"',
    "Sent a message to a subagent",
    "Sent a message to the parent",
    'Sent a message to the chat "Other chat"',
  ], tag + ": send titles " + JSON.stringify(got));
  assert.ok(!got.some((t) => /subagent subagent|sa-\d/.test(t)), tag + ": no doubled word or id");
  const heads = await ev(`${sends}.map((x) => x.querySelector(".notice-head").getBoundingClientRect().height)`);
  assert.ok(heads.every((h) => h < 110), tag + ": short title " + JSON.stringify(heads));
  await until(ev, `${notes}[0].querySelector(".notice-title").textContent.includes("relift lane")`, tag + ": the message card names the subagent");
  const from = await ev(`${notes}.map((x) => x.querySelector(".notice-title").textContent)`);
  assert.deepStrictEqual(from, [
    'Message from the subagent "' + GOAL + '"',
    'Message from the subagent "' + GOAL + '"',
    'Message from the subagent "measure the antenna"',
    "Message from the parent",
  ], tag + ": message titles " + JSON.stringify(from));
}


// The command or code in a title is monospace, the leading word is not, and
// the title stays on one line.
async function commands(c, tag) {
  const { ev } = c;
  await until(ev, `document.querySelectorAll('.tool[data-tool="execute_code"]').length === 1 && document.querySelectorAll('.tool[data-tool="process_manage"]').length === 1`, tag + ": command cards drawn");
  const got = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.tool[data-tool="terminal"], .tool[data-tool="execute_code"], .tool[data-tool="process_manage"]')].filter((x) => x.offsetParent !== null).map((x) => {
    const t = x.querySelector(".notice-title");
    const code = t.querySelector("code.tcode");
    const ts = getComputedStyle(t);
    const cs = code && getComputedStyle(code);
    const box = getComputedStyle(document.querySelector(".tool-box, .notice-text.pre") || t);
    return { tool: x.dataset.tool, text: t.textContent, code: code ? code.textContent : null, mono: !!cs && /mono|Menlo|Consolas|Courier/i.test(cs.fontFamily), same: !!cs && !!document.querySelector(".tool-box") && cs.fontFamily === box.fontFamily,
      lead: code ? t.firstChild.textContent : null, leadMono: /mono|Menlo/i.test(ts.fontFamily), ratio: cs ? parseFloat(cs.fontSize) / parseFloat(ts.fontSize) : 0, h: t.getBoundingClientRect().height, lh: parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.5, ellipsis: ts.textOverflow, ws: ts.whiteSpace };
  }))`));
  assert.strictEqual(got.length, 4, tag + ": four command cards " + JSON.stringify(got));
  const lead = { terminal: /^(Ran |Started in the background: )$/, execute_code: /^Ran (Python |JavaScript |code )?$/, process_manage: /^Waited for background command $/ };
  for (const g of got) {
    assert.ok(g.code, tag + ": " + g.tool + " has a code element: " + JSON.stringify(g));
    assert.ok(g.mono, tag + ": the code is monospace: " + JSON.stringify(g));
    assert.ok(!g.leadMono, tag + ": the leading word is the UI font: " + JSON.stringify(g));
    assert.ok(lead[g.tool].test(g.lead), tag + ": lead " + JSON.stringify(g.lead));
    assert.ok(g.ratio > 0.8 && g.ratio <= 1, tag + ": code size lines up with the title " + g.ratio);
    assert.ok(g.h < g.lh * 1.6, tag + ": one line " + JSON.stringify(g));
    assert.ok(g.ellipsis === "ellipsis" && g.ws === "nowrap", tag + ": ellipsizes");
  }
  assert.ok(got.some((g) => g.code.startsWith("ls -la /usr/bin/zig")), tag + ": the terminal command");
  assert.ok(got.some((g) => g.tool === "process_manage" && g.code === "make -j8"), tag + ": the background command");
  await ev(`document.querySelector('.tool[data-tool="terminal"]').scrollIntoView({ block: "center" })`);
  await shot(c, tag + "-commands");
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
  assert.ok(/clarify|asked a question/i.test(text), tag + ": the fold line still counts the others: " + text);
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
  await commands(c, tag);
  // Open the first send: the details hold the message, never the raw id.
  await ev(`${sends}[0].scrollIntoView()`);
  await ev(`${sends}[0].querySelector(".notice-head").click()`);
  await until(ev, `!${sends}[0].querySelector(".notice-body-wrap").hidden`, tag + ": send opened");
  const det = await ev(`${sends}[0].querySelector(".notice-body-wrap").textContent`);
  assert.ok(det.includes("Message") && !det.includes("sa-0-edd20c0e"), tag + ": the details hold the message and no id: " + det);
  await ev(`${sends}[3].querySelector(".notice-head").click()`);
  await ev(`${sends}[3].scrollIntoView({ block: "center" })`);
  await shot(c, tag + "-sends");
  await ev(`${notes}[0].scrollIntoView({ block: "center" })`);
  await ev(`${notes}[0].querySelector(".notice-head").click()`);
  await until(ev, `!${notes}[0].querySelector(".notice-body-wrap").hidden`, tag + ": message opened");
  const sender = await ev(`${notes}[0].querySelector(".notice-body-wrap").innerText`);
  assert.ok(!sender.includes("sa-0-edd20c0e") && !sender.includes("(goal: "), tag + ": the details hold the message, not the raw sender label: " + sender);
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
