"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, then
// 1280 px) or headless Firefox (WebDriver BiDi; picked when the path has
// "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// The chat "Joined rows" holds user rows as Hermes stores them when it joins
// an agent message to the user's own message. Asserts that the user's bubble
// holds only the typed words, each agent message is its own card with the
// sender named, a row with nothing typed has no bubble, and nothing is lost.
// With AGENTMSG_SHOTS set (Chrome only) it saves screenshots there.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.AGENTMSG_SHOTS || "";
const open = firefox ? require("../bidi.js").launch(bin, dir) : require("../cdp.js").launch(bin, dir);
const { connect } = open;

(async () => {
  const c = await connect();
  const { ev } = c;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; log ${await ev(`document.getElementById("log").innerText.slice(0, 800)`)}`);
      await sleep(25);
    }
  };
  const nav = async (u) => {
    if (firefox) await c.goto(u);
    else await c.load(u, "true", "the page");
  };
  if (firefox) {
    await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
  } else {
    await c.send("Page.enable");
  }
  const size = async (w, h) => {
    if (firefox) await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: w, height: h } });
    else await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
    await sleep(300);
  };

  const check = async (tag) => {
    await nav(url + "/auth/login?next=/");
    await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/joined"]').length === 1`, "the chat list");
    await ev(`location.hash = "#/s/pc/joined"`);
    await until(`document.querySelectorAll("#log .msg.user").length >= 2 && document.querySelectorAll("#log .notice").length >= 4`, tag + ": the rows drawn");
    const got = await ev(`(() => ({
      bubbles: Array.from(document.querySelectorAll("#log .msg.user")).map((n) => n.innerText.trim()),
      cards: Array.from(document.querySelectorAll("#log .notice")).map((n) => n.innerText.replace(/\\s+/g, " ").trim()),
      order: Array.from(document.querySelectorAll("#log .msg.user, #log .notice")).map((n) => n.classList.contains("user") ? "bubble" : "card"),
    }))()`);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(got.bubbles)), ["added nds-dev and 3ds-dev", "and the wii one too"], tag + ": the bubbles hold only what was typed: " + JSON.stringify(got.bubbles));
    // user, card, user, card, card, card, card: the typed bubble first, then its cards.
    assert.strictEqual(got.order.join(","), "bubble,card,bubble,card,card,card,card", tag + ": order " + got.order);
    assert.strictEqual(got.cards.length, 5, tag + ": five cards " + JSON.stringify(got.cards));
    for (const t of got.cards) {
      assert.ok(/docgen/.test(t), tag + ": the card names its sender: " + t);
      assert.ok(!/Another AI agent of this user wrote/.test(t) && !/\[Agent message/.test(t), tag + ": no header or preamble in the card: " + t);
    }
    assert.ok(/Both targets are in the docs table now/.test(got.cards[0]), tag + ": the body is in the card " + got.cards[0]);
    assert.ok(/A second message/.test(got.cards[2]) && /Another one/.test(got.cards[4]), tag + ": every message has a card");
    assert.ok(await ev(`!/Agent message|Another AI agent/.test(Array.from(document.querySelectorAll("#log .msg.user")).map((n) => n.innerText).join(" "))`), tag + ": nothing of the agent message in a bubble");
    // The blue bubble is the user's: no agent card sits inside one.
    assert.ok(await ev(`!document.querySelector("#log .msg.user .notice")`), tag + ": no card inside a bubble");
    assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), tag + ": no sideways scroll");
  };
  const shoot = async (name) => {
    if (!shots || firefox) return;
    await ev(`(() => { const l = document.getElementById("log"); l.scrollTop = 0; return 1; })()`);
    await sleep(300);
    const r = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(r.data, "base64"));
  };

  if (firefox) {
    await check("firefox 1280");
  } else {
    await size(412, 915);
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await check("chrome 412");
    await shoot("joined-412");
    await size(1280, 900);
    await check("chrome 1280");
    await shoot("joined-1280");
  }
  open.proc.kill();
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
