"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol).
// usage: node run.js CHROME HUB_URL PROFILE_DIR POKE_URL
// Opens chats that hold an approval (plain, bare, smart, a subagent's, a
// source grant) and two sign-in grant cards, and a chat whose turn fails
// live. Asserts each card is drawn with its buttons (the failed turn as one
// plain line, details folded, no codes in view). With SHOT_DIR set it saves
// <name>-<w>-<light|dark>.png of each card (and -open for the failed turn
// with its details open) at 412 and 1280 px.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, pokeURL] = process.argv.slice(2);
const { launch, until } = require("../cdp.js");
const { connect } = launch(bin, dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.env.SHOT_DIR || "";

(async () => {
  const c = await connect();
  const { ev } = c;
  await c.send("Page.enable");
  await c.send("Page.navigate", { url: url + "/auth/login?next=/" });
  const open = async (id, title) => {
    await until(ev, `!!document.querySelector('#sessions a.go[href="#/s/pc/${id}"]')`, "the chat " + id + " is listed");
    await ev(`document.querySelector('#sessions a.go[href="#/s/pc/${id}"]').click()`);
    await until(ev, `document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading")`, "the chat " + title);
  };
  const shoot = async (name, sel) => {
    if (!out) return;
    for (const [w, h, mobile] of [[412, 915, true], [1280, 900, false]]) {
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await sleep(300);
        await ev(`${sel}.scrollIntoView({ block: "center" })`);
        await sleep(150);
        const r = await ev(`(() => { const b = ${sel}.getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(b.width + 16, ${w}), height: Math.min(b.height + 16, ${h}) }; })()`);
        const png = await c.send("Page.captureScreenshot", { format: "png", clip: Object.assign(r, { scale: 1 }) });
        fs.writeFileSync(`${out}/${name}-${w}-${scheme}.png`, Buffer.from(png.data, "base64"));
      }
    }
  };
  const approval = `document.querySelector("#log .approval")`;
  const cards = [
    ["c1", "Shot plain approval", "approval-plain", 4],
    ["c2", "Shot bare approval", "approval-bare", 2],
    ["c3", "Shot smart approval", "approval-smart", 2],
    ["c4", "Shot subagent approval", "approval-subagent", 2],
    ["c5", "Shot source approval", "approval-source", 3],
    ["c6", "Shot sign-in grant", "signin-grant", 3],
    ["c7", "Shot sign-in unknown", "signin-unknown-computer", 3],
  ];
  for (const [id, title, name, nbuttons] of cards) {
    await open(id, title);
    await until(ev, `${approval} && ${approval}.querySelectorAll("button").length >= ${nbuttons}`, name + " card is drawn");
    const text = await ev(`${approval}.innerText`);
    assert.ok(!/^\s*[{[]/.test(text) && !/\bundefined\b|\[object/.test(text), name + ": raw text in the card: " + text);
    await shoot(name, approval);
  }
  // The signed-in unknown computer card has its allow buttons locked.
  assert.ok(await ev(`[...${approval}.querySelectorAll("button")].filter((b) => /^Allow/.test(b.textContent)).every((b) => b.disabled)`), "unknown computer: Allow buttons are locked");

  await open("f1", "Shot failed turn");
  await new Promise((res, rej) => require("http").get(pokeURL, (r) => { r.resume(); r.on("end", res); }).on("error", rej));
  await until(ev, `!!document.querySelector("#log .failline")`, "the failed turn's line");
  const line = await ev(`(() => { const n = document.querySelector("#log .failline"); const d = n.querySelector("details"); return { text: [...n.childNodes].filter((x) => x.nodeType === 3).map((x) => x.data).join(""), open: d.open, count: document.querySelectorAll("#log .failline").length, visible: n.innerText }; })()`);
  assert.strictEqual(line.count, 1, "one failed-turn line");
  assert.strictEqual(line.text, "The model request failed: Claude rejected this request as malformed.");
  assert.ok(!line.open, "details are folded");
  assert.ok(!/HERMES_|req_|HTTP 400|encrypted_content/.test(line.visible), "no codes in view: " + line.visible);
  const fail = `document.querySelector("#log .failline")`;
  await shoot("failed-turn-folded", fail);
  await ev(`${fail}.querySelector("details").open = true`);
  await shoot("failed-turn-details-open", fail);
  await c.close();
})().catch((e) => { console.error(e); process.exit(1); });
