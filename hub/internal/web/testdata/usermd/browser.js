"use strict";
// Drives the real hub page on a phone: headless Chrome with Pixel emulation
// (DevTools protocol), or headless Firefox at phone size (WebDriver BiDi;
// picked when the path has "firefox" in it).
// usage: node browser.js BROWSER_BIN HUB_URL PROFILE_DIR RICH_TEXT
// Asserts that a message sent with "> quote" shows a blockquote and not the
// marker, that it does after a reload and after a switch to another chat and
// back, that Copy and Edit keep the typed text, that HTML typed in a message
// stays inert, and that the seeded rich message shows each kind of block.
// With USERMD_SHOT=prefix, Chrome also writes prefix-<width>-<scheme>.png.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, rich] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const shot = process.env.USERMD_SHOT || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 412;
const H = 915;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return {
      proc,
      connect: async () => {
        const c = await connect();
        await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: W, height: H }, devicePixelRatio: 2.625 });
        return { ev: c.ev, nav: (u) => c.goto(u), reload: () => c.send("browsingContext.reload", { context: c.context, wait: "complete" }), tap: c.click, close: c.close };
      },
    };
  }
  const { proc, connect } = require("../cdp.js").launch(bin, dir);
  return {
    proc,
    connect: async () => {
      const c = await connect();
      await c.send("Page.enable");
      await c.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
      await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2.625, mobile: true });
      await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const tap = async (x, y) => {
        await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const screenshot = async (file, width, scheme) => {
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await c.send("Emulation.setDeviceMetricsOverride", { width, height: width > 600 ? 900 : H, deviceScaleFactor: width > 600 ? 1 : 2, mobile: width <= 600 });
        await sleep(400);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      };
      return { ev: c.ev, nav: (u) => c.send("Page.navigate", { url: u }), reload: () => c.send("Page.reload", {}), tap, screenshot, close: c.close };
    },
  };
}

const { proc, connect } = driver();
(async () => {
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 30000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`).catch(() => false);
      if (last) return last;
      if (Date.now() > end) throw new Error(`${kind}: timed out waiting for ${what}; last ${JSON.stringify(last)}; log tail: ${JSON.stringify(await ev(`document.getElementById("log").innerText.slice(-400)`).catch(() => ""))}`);
      await sleep(25);
    }
  };
  const frames = (n = 3) => ev(`new Promise((res) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  const open = async (id, title) => {
    await ev(`(location.hash = "#/s/pc/${id}", 1)`);
    await until(`location.hash === "#/s/pc/${id}" && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, `${id} to be drawn`);
    await frames(4);
  };
  const send = async (text) => {
    await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await until(`!document.getElementById("send").disabled`, "the send button");
    const b = await ev(`(() => { const r = document.getElementById("send").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.tap(b.x, b.y);
    await until(`document.getElementById("input").value === ""`, "the message box to empty");
  };
  // The user bubble whose typed text is text: what it shows.
  const mine = (text) => ev(`(() => {
    const b = Array.from(document.querySelectorAll("#log .msg.user")).find((x) => x.rawText === ${JSON.stringify(text)});
    if (!b) return null;
    return { quotes: b.querySelectorAll("blockquote").length, text: b.innerText, html: b.querySelector(".utext") ? b.querySelector(".utext").innerHTML : "", raw: b.rawText, pending: b.classList.contains("pending") };
  })()`);

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/work"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");
  await open("work", "Markdown");

  // The seeded rich message.
  const r = await ev(`(() => {
    const b = Array.from(document.querySelectorAll("#log .msg.user")).find((x) => x.rawText === ${JSON.stringify(rich)});
    if (!b) return null;
    const q = (s) => b.querySelectorAll(s).length;
    return { quote: q("blockquote"), strong: q("strong"), em: q("em"), code: q("p code"), li: q("li"), a: q("a[href^='https://example.com']"), h1: q("h1"), block: q(".codeblock"), text: b.innerText, h1size: q("h1") ? getComputedStyle(b.querySelector("h1")).fontSize : "", base: getComputedStyle(b).fontSize };
  })()`);
  assert.ok(r, kind + ": the rich message is drawn with its typed text kept");
  assert.deepStrictEqual([r.quote, r.strong, r.em, r.code, r.li, r.a, r.h1, r.block], [1, 1, 1, 1, 2, 1, 1, 1], kind + ": " + JSON.stringify(r));
  assert.ok(!r.text.includes("> From"), kind + ": the quote marker is not shown as text: " + r.text);
  assert.ok(r.text.includes("~/my_dir/some_file_name.txt") && r.text.includes("*.go"), kind + ": path and glob kept as typed: " + r.text);
  assert.ok(parseFloat(r.h1size) <= parseFloat(r.base) + 0.01, kind + ": a heading is no larger than the text: " + r.h1size + " vs " + r.base);

  // Send one.
  const typed = "> quote line\nnext **bold** `code` <b>x</b>";
  await send(typed);
  await until(`document.getElementById("log").innerText.includes("echo:")`, "the reply");
  const check = async (when) => {
    const m = await until(`(() => { const b = Array.from(document.querySelectorAll("#log .msg.user")).find((x) => x.rawText === ${JSON.stringify(typed)}); return b ? true : false; })()`, "the sent bubble " + when).then(() => mine(typed));
    assert.strictEqual(m.quotes, 1, kind + ": " + when + ": a blockquote shows: " + JSON.stringify(m));
    assert.ok(!m.text.includes("> quote"), kind + ": " + when + ": no marker as text: " + m.text);
    assert.ok(m.html.includes("<strong>bold</strong>") && m.html.includes("<code>code</code>"), kind + ": " + when + ": " + m.html);
    assert.ok(m.html.includes("&lt;b&gt;x&lt;/b&gt;") && !/<b>/.test(m.html), kind + ": " + when + ": typed HTML stays text: " + m.html);
    assert.strictEqual(m.raw, typed, kind + ": " + when + ": the typed Markdown is kept for Copy and Edit");
    assert.strictEqual(m.pending, false, kind + ": " + when + ": not pending");
  };
  await check("after sending");
  await open("elsewhere", "Other");
  await open("work", "Markdown");
  await check("after a chat switch");
  await ev(`(window.__old = true)`);
  await c.reload();
  await until(`!window.__old && document.getElementById("title").textContent === "Markdown" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0`, "the chat after a reload");
  await frames(4);
  await check("after a reload");

  if (shot && c.screenshot) {
    for (const w of [412, 1280]) for (const s of ["light", "dark"]) {
      await c.screenshot(`${shot}-${w}-${s}.png`, w, s);
    }
  }
  console.log(kind + ": ok");
  c.close();
  process.exit(0);
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  try { proc.kill(); } catch (_) { /* gone */ }
  process.exit(1);
});
