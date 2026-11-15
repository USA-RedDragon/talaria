"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol) or headless
// Firefox (WebDriver BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR (CARD_SHOTS=dir keeps Chrome screenshots)
// A subagent card in the Activity panel opens and closes on a real mouse
// click anywhere on its header, the title included, and on Enter and Space;
// the title is one line while the card is closed.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const shots = process.env.CARD_SHOTS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return { proc, connect: async () => {
      const c = await connect();
      const act = (actions, type = "pointer") => c.send("input.performActions", { context: c.context, actions: [type === "key"
        ? { type, id: "k", actions } : { type, id: "m", parameters: { pointerType: "mouse" }, actions }] });
      return {
        ev: c.ev, nav: (u) => c.goto(u), close: c.close,
        size: (w, h) => c.send("browsingContext.setViewport", { context: c.context, viewport: { width: w, height: h } }),
        click: async (x, y) => act([{ type: "pointerMove", x: Math.round(x), y: Math.round(y) }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]),
        key: async (ch) => { const v = ch === "Enter" ? "\uE007" : ch; return act([{ type: "keyDown", value: v }, { type: "keyUp", value: v }], "key"); },
        shot: async () => {},
      };
    } };
  }
  const { proc, connect } = require("../cdp.js").launch(bin, dir);
  return { proc, connect: async () => {
    const c = await connect();
    await c.send("Page.enable");
    return {
      ev: c.ev, nav: (u) => c.send("Page.navigate", { url: u }), close: c.close,
      size: (w, h, dark) => c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 })
        .then(() => c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] })),
      click: async (x, y) => {
        const m = (type) => c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        await m("mouseMoved"); await m("mousePressed"); await m("mouseReleased");
      },
      key: async (ch) => {
        const code = ch === " " ? "Space" : "Enter", vk = ch === " " ? 32 : 13, text = ch === " " ? " " : "\r";
        for (const type of ["keyDown", "keyUp"]) await c.send("Input.dispatchKeyEvent", { type, key: ch === " " ? " " : "Enter", code, windowsVirtualKeyCode: vk, text: type === "keyDown" ? text : undefined });
      },
      shot: async (name) => {
        if (!shots) return;
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(r.data, "base64"));
      },
    };
  } };
}

const { proc, connect } = driver();
(async () => {
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(25);
    }
  };
  const frames = () => ev(`new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => res(true), 0))))`);
  const centre = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + Math.min(30, r.width / 2), y: r.y + Math.min(10, r.height / 2) }; })()`);
  const isOpen = () => ev(`document.querySelector(".act .row").classList.contains("open")`);
  const titleH = () => ev(`document.querySelector(".act .row-head .goal").getBoundingClientRect().height`);

  for (const [w, h, dark, name] of [[412, 915, false, "412-light"], [412, 915, true, "412-dark"], [1280, 800, false, "1280-light"], [1280, 800, true, "1280-dark"]]) {
    await c.size(w, h, dark);
    await c.nav(url + "/auth/login?next=/#/s/pc/s9");
    await until(`document.querySelector("#actbtn") && !document.getElementById("actbtn").hidden`, "the Activity button");
    await sleep(1500);
    if (!(await ev(`!!document.querySelector(".act .row-head .goal")`))) await ev(`document.getElementById("actbtn").click()`);
    await until(`document.querySelector(".act .row-head .goal")`, "the subagent row");
    assert.strictEqual(await isOpen(), false);
    const one = await titleH();
    assert.ok(one < 30, `the closed title is one line (${one}px)`);
    await c.shot(name + "-closed");

    // A click on the title opens the card; a second click on the title closes it.
    let p = await centre(".act .row-head .goal");
    await c.click(p.x, p.y);
    await until(`document.querySelector(".act .row.open")`, "the card to open on a title click");
    assert.strictEqual(await ev(`document.querySelector(".act .row-head").getAttribute("aria-expanded")`), "true");
    await until(`document.querySelector(".act .mc")`, "the card's chat");
    await frames();
    await c.shot(name + "-open");
    p = await centre(".act .row-head .goal");
    await c.click(p.x, p.y);
    await until(`!document.querySelector(".act .row.open")`, "the card to close on a title click");
    assert.ok((await titleH()) < 30, "the closed title is one line again");

    // The other parts of the header, and the keyboard.
    p = await centre(".act .row-head .meta");
    await c.click(p.x, p.y);
    await until(`document.querySelector(".act .row.open")`, "the card to open on a meta click");
    p = await centre(".act .row-head .goal");
    await c.click(p.x, p.y);
    await until(`!document.querySelector(".act .row.open")`, "the card to close");
    await ev(`document.querySelector(".act .row-head").focus()`);
    await c.key("Enter");
    await until(`document.querySelector(".act .row.open")`, "Enter to open the card");
    await ev(`document.querySelector(".act .row-head").focus()`);
    await c.key(" ");
    await until(`!document.querySelector(".act .row.open")`, "Space to close the card");
  }
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); try { proc.kill(); } catch (_) { /* gone */ } process.exit(1); });
