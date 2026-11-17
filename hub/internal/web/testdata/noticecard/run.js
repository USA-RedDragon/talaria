"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol).
// usage: node run.js CHROME HUB_URL PROFILE_DIR NOTICES_JSON
// Each notice of a finished subagent is a card with a title in words, a
// status line under it that never breaks inside a word, and the first line
// of the result, at 412 and 1280 px, light and dark. With SHOT_DIR set it
// saves notice-<id>-<w>-<scheme>.png of each card.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, json] = process.argv.slice(2);
const notices = JSON.parse(json);
const { launch, until } = require("../cdp.js");
const { connect } = launch(bin, dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = process.env.SHOT_DIR || "";

(async () => {
  const c = await connect();
  const { ev } = c;
  await c.send("Page.enable");
  await c.send("Page.navigate", { url: url + "/auth/login?next=/#/s/pc/s9" });
  await until(ev, `document.querySelectorAll('#log .notice[data-kind="delegation"]').length === ${notices.length}`, "every notice card");
  const card = (i) => `document.querySelectorAll('#log .notice[data-kind="delegation"]')[${i}]`;
  for (const [w, h, mobile] of [[412, 915, true], [1280, 900, false]]) {
    for (const scheme of ["light", "dark"]) {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await sleep(300);
      if (await ev(`!document.getElementById("app").classList.contains("act-closed")`)) await ev(`document.getElementById("actbtn").click()`);
      await sleep(300);
      for (let i = 0; i < notices.length; i++) {
        const tag = notices[i].id + " " + w + " " + scheme;
        await ev(`${card(i)}.scrollIntoView({ block: "center" })`);
        await sleep(100);
        const g = await ev(`(() => {
          const n = ${card(i)};
          const head = n.querySelector(":scope > .notice-head");
          const t = head.querySelector(".notice-title"), m = head.querySelector(".notice-meta");
          const tb = t.getBoundingClientRect(), mb = m.getBoundingClientRect(), hb = head.getBoundingClientRect();
          // A word broken across lines: the meta's lines are more than its words allow.
          const words = m.textContent.split(/\\s+/).filter(Boolean);
          const lh = parseFloat(getComputedStyle(m).lineHeight) || 18;
          return { title: t.textContent.trim(), tw: tb.width, mw: mb.width, hw: hb.width, mtop: mb.top, tbottom: tb.bottom, lines: Math.round(mb.height / lh), words: words.length, meta: m.textContent };
        })()`);
        assert.ok(g.title.length > 0, tag + ": the card has a title " + JSON.stringify(g));
        assert.ok(g.mw > g.hw * 0.5, tag + ": the status line has the card's width " + JSON.stringify(g));
        assert.ok(g.mtop >= g.tbottom - 1, tag + ": the status is under the title " + JSON.stringify(g));
        assert.ok(g.lines <= 2, tag + ": the status takes at most two lines " + JSON.stringify(g));
        if (out) {
          const r = await ev(`(() => { const b = ${card(i)}.getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(b.width + 16, ${w}), height: Math.min(b.height + 16, ${h}) }; })()`);
          const png = await c.send("Page.captureScreenshot", { format: "png", clip: Object.assign(r, { scale: 1 }) });
          fs.writeFileSync(`${out}/notice-${notices[i].id}-${w}-${scheme}.png`, Buffer.from(png.data, "base64"));
        }
      }
    }
  }
  // No clock time or date on a notice card.
  const dated = await ev(`[...document.querySelectorAll('#log .notice')].map((n) => n.textContent).filter((t) => /\\b\\d{1,2}:\\d\\d\\s?[AP]M\\b|\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b/.test(t))`);
  assert.deepStrictEqual(dated, [], "a notice card shows a time");
  const titles = await ev(`[...document.querySelectorAll('#log .notice[data-kind="delegation"] > .notice-head > .notice-title')].map((t) => t.textContent)`);
  console.log(JSON.stringify(titles));
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
