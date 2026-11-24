"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR
// A smart approval card shows its parts: who asks (a subagent once, as a chip
// and its goal on one line), Rule, Why and Source as a list, then the command
// and the buttons. It fits the screen at 412 and 1280 px in light and dark.
// A prompt that carries only the description keeps the one-sentence card.
// PARTSCARD_SHOT=prefix also writes screenshots of each card.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

const SRC = "Allow code from github.com/AppImage/appimagetool in this chat";
const SRC_ALWAYS = "Always allow code from github.com/AppImage/appimagetool";
const FOUR = ["Allow once", "Allow in this chat", "Always allow", "Deny"];
// title: the session; kind: what the card must look like.
const CARDS = [
  { title: "Parts subagent", name: "subagent", who: true, rows: ["Rule", "Why"], rule: "Interfere With Workloads", buttons: FOUR },
  { title: "Parts chat", name: "chat", who: false, rows: ["Rule", "Why"], rule: "Auto-Mode Bypass", buttons: FOUR },
  { title: "Parts source", name: "source", who: true, rows: ["Rule", "Why", "Source"], rule: "Code from External", buttons: ["Allow once", SRC, SRC_ALWAYS, "Deny"] },
  { title: "Parts older", name: "older", old: true, buttons: FOUR },
];

async function open(c, w, touch, dark, title, nbuttons) {
  const { ev } = c;
  const tag = w + (dark ? "-dark" : "-light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: w < 600 ? 915 : 800, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 5 });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.send("Page.navigate", { url: url + "/auth/login?next=/" });
  await until(ev, `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith(${JSON.stringify(title)}))`, tag + ": " + title + " is listed");
  await ev(`(() => { const e = [...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith(${JSON.stringify(title)})).pop(); e.click(); })()`);
  await until(ev, `document.querySelectorAll("#log .approval button").length >= ${nbuttons}`, tag + ": the card is drawn");
  return tag;
}

async function check(c, card, w, touch, dark) {
  const { ev } = c;
  const tag = (await open(c, w, touch, dark, card.title, card.buttons.length)) + " " + card.name;
  const r = await ev(`(() => {
    const a = document.querySelector("#log .approval");
    const vw = document.documentElement.clientWidth;
    const rect = (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), top: Math.round(b.top), bot: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
    const goal = a.querySelector(".by .goal");
    return {
      vw, scroll: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth,
      box: rect(a), text: a.innerText, title: a.querySelector("b").textContent,
      buttons: [...a.querySelectorAll("button")].map((b) => ({ t: b.textContent, ...rect(b) })),
      chip: a.querySelector(".by .chip") ? a.querySelector(".by .chip").textContent : null,
      goal: goal ? { ...rect(goal), clipped: goal.scrollWidth > goal.clientWidth, full: goal.textContent, ws: getComputedStyle(goal).whiteSpace, to: getComputedStyle(goal).textOverflow } : null,
      dts: [...a.querySelectorAll("dl.parts dt")].map((n) => n.textContent),
      rule: a.querySelector("dl.parts dd.rulename") ? a.querySelector("dl.parts dd.rulename").textContent : null,
      whyBlocks: [...a.querySelectorAll("dl.parts dd.why div")].length,
      dl: a.querySelector("dl.parts") ? rect(a.querySelector("dl.parts")) : null,
      pre: a.querySelector("pre, .toolcall") ? rect(a.querySelector("pre, .toolcall")) : null,
      kids: [...a.children].map((n) => n.tagName.toLowerCase() + (n.className ? "." + n.className.split(" ")[0] : "")),
      asked: a.innerText.includes("Asked by a subagent"),
    };
  })()`);
  assert.deepStrictEqual(r.buttons.map((b) => b.t), card.buttons, tag + ": the buttons " + JSON.stringify(r.buttons));
  assert.ok(r.buttons.every((b) => b.l >= 0 && b.r <= r.vw), tag + ": a button is outside the screen " + JSON.stringify(r.buttons));
  assert.ok(r.scroll <= r.client, tag + ": the page scrolls sideways");
  assert.ok(r.box.l >= 0 && r.box.r <= r.vw, tag + ": the card is outside the screen");
  assert.strictEqual(r.title, "Approval needed: run this command");
  if (card.old) {
    assert.ok(r.asked && r.text.includes("asks: Smart approval rule"), tag + ": an old-format card keeps its sentence " + r.text);
    assert.strictEqual(r.dl, null, tag + ": no parts list");
  } else {
    assert.ok(!r.asked, tag + ": the subagent is named twice");
    assert.deepStrictEqual(r.dts, card.rows, tag + ": rows");
    assert.strictEqual(r.rule, card.rule);
    assert.ok(!/\bc\d+\b/.test(r.text) && !r.text.includes("old text") && !r.text.includes("asks:"), tag + ": " + r.text);
    // A process_manage call is said in words (div.toolcall), a command is shown as it is (pre).
    assert.deepStrictEqual(r.kids.slice(0, 1).concat(r.kids.slice(-2)), ["b", card.name === "subagent" ? "div.toolcall" : "pre", "div.actions"], tag + ": order " + r.kids);
    assert.strictEqual(r.kids.includes("div.by"), card.who, tag + ": who line " + r.kids);
    if (card.who) {
      assert.strictEqual(r.chip, "Subagent");
      assert.ok(r.goal.h < 30, tag + ": the goal wraps (" + r.goal.h + "px)");
      assert.strictEqual(r.goal.ws, "nowrap");
      assert.strictEqual(r.goal.to, "ellipsis");
      if (card.name === "subagent") assert.ok(r.goal.clipped, tag + ": a long goal is cut with an ellipsis");
      assert.ok(r.goal.r <= r.box.r, tag + ": the goal leaves the card");
    }
    // who, then the list, then the command, top to bottom
    assert.ok(r.dl.bot <= r.pre.top + 1 && r.pre.bot <= r.buttons[0].top, tag + ": order on the page " + JSON.stringify({ dl: r.dl, pre: r.pre }));
  }
  if (process.env.PARTSCARD_SHOT) {
    await ev(`document.querySelector("#log .approval").scrollIntoView({ block: "center" })`);
    await c.frames(2);
    fs.writeFileSync(process.env.PARTSCARD_SHOT + tag.replace(/ /g, "-") + ".png", Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
}

(async () => {
  const c = await connect();
  await c.send("Page.enable");
  for (const dark of [false, true]) {
    for (const card of CARDS) {
      await check(c, card, 412, true, dark);
      await check(c, card, 1280, false, dark);
    }
  }
  // A tap on Allow of the chat's own card sends the choice.
  await open(c, 412, true, false, "Parts chat", 4);
  await c.ev(`[...document.querySelectorAll("#log .approval button")].find((b) => b.textContent === "Allow once").click()`);
  await until(c.ev, `document.body.innerText.includes("approved: once")`, "Hermes got the choice");
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
