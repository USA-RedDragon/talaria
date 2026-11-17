"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol, a
// Pixel-sized phone) or headless Firefox (WebDriver BiDi, a desktop; picked
// when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR IDS_JSON
// The chat and its subagent ran the same calls (IDS_JSON lists their ids).
// Each call's card in the chat and in the subagent's steps in Activity must
// be the same DOM: closed, then open.
const assert = require("assert");
const [bin, url, dir, idsJSON] = process.argv.slice(2);
const ids = JSON.parse(idsJSON);
// meta: which calls are still running (their counter ticks) and each call's tool name.
const meta = JSON.parse(process.argv[6] || "{}");
const running = meta.running || [];
const names = meta.names || {};
// A running call has no stored result and no stored card: the chat draws it from its live
// tool.start event, which a request to pokeURL makes the hub's fake Hermes publish.
const pokeURL = process.argv[7];
const firefox = /firefox/.test(bin);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open() {
  if (firefox) {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    const c = await connect();
    await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
    return { proc, ev: c.ev, nav: (u) => c.goto(u), close: c.close };
  }
  const { proc, connect } = require("../cdp.js").launch(bin, dir);
  const c = await connect();
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  return { proc, ev: c.ev, send: c.send, nav: (u) => c.send("Page.navigate", { url: u }), close: c.close };
}

// shape is a card's DOM with what differs by place taken out: the times
// that tick, and the Show in Activity link, which only a card outside
// Activity has (with it, the card opens; without anything else to show, the
// same card in Activity is flat). Every other attribute and class stays.
const shape = `((n, tick) => {
  // A card that shows nothing more when open differs by place only in that.
  const only = !!n && !!n.view && !n.view.derived.opens;
  const walk = (x) => {
    if (x.nodeType === 3) return JSON.stringify(tick ? x.data.replace(/\\d+(:\\d+)+|\\d+(\\.\\d+)?\\s?(ms|s|m|h)\\b/g, "#") : x.data);
    if (x.nodeType !== 1) return "";
    if (x.classList.contains("tool-open")) return "";
    if (only && x.classList.contains("notice-body-wrap")) return "";
    const attrs = [...x.attributes].filter((a) => !(tick && a.name === "data-since"))
      .filter((a) => !(only && a.name === "aria-expanded"))
      .map((a) => a.name + "=" + (only && a.name === "class" ? a.value.replace(/\\bflat\\b/, "").trim() : a.value)).sort().join(",");
    return x.tagName + (x.hidden ? "[hidden]" : "") + "{" + attrs + "}(" + [...x.childNodes].map(walk).join(" ") + ")";
  };
  return n ? walk(n) : "missing";
})`;
const argsOf = (id) => (running.includes(id) ? ", true" : "");

// takeShots saves each card, open and closed, at 412 and 1280 px, light
// and dark, in the chat and in the subagent's steps in Activity:
// <dir>/<tool>-<id>-<main|mini>-<open|closed>-<w>-<light|dark>.png. The
// Activity panel is narrower than the chat: that is expected.
const shots = process.env.CARD_SHOTS;
const only = (process.env.CARD_IDS || "").split(",").filter(Boolean);
async function takeShots(c, main, mini) {
  const fs = require("fs");
  const { ev } = c;
  const panelOpen = () => ev(`!document.getElementById("app").classList.contains("act-closed")`);
  for (const [w, h, mobile, dark] of [[412, 915, true, false], [412, 915, true, true], [1280, 900, false, false], [1280, 900, false, true]]) {
    await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await sleep(300);
    // The first folded group of tool cards in the chat, closed: its summary line.
    if (await ev(`!!document.querySelector("#log details.toolgroup")`)) {
      if (await panelOpen()) await ev(`document.getElementById("actbtn").click()`);
      await sleep(300);
      await ev(`(() => { const g = document.querySelector("#log details.toolgroup"); g.open = false; g.querySelector(":scope > summary").scrollIntoView({ block: "center" }); })()`);
      await sleep(500);
      await ev(`document.querySelector("#log details.toolgroup > summary").scrollIntoView({ block: "center" })`);
      await sleep(300);
      const r = await ev(`(() => { const b = document.querySelector("#log details.toolgroup > summary").getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: Math.min(b.width + 16, ${w}), height: b.height + 16 }; })()`);
      const png = await c.send("Page.captureScreenshot", { format: "png", clip: Object.assign(r, { scale: 1 }) });
      fs.writeFileSync(`${shots}/toolgroup-${w}-${dark ? "dark" : "light"}.png`, Buffer.from(png.data, "base64"));
    }
    for (const [where, sel] of [["main", main], ["mini", mini]]) {
      // The chat's cards are shot with the Activity panel closed, the subagent's with it open.
      const shown = await panelOpen();
      if (where === "main" && shown) await ev(`document.getElementById("actbtn").click()`);
      if (where === "mini" && !shown) await ev(`document.getElementById("actbtn").click()`);
      await sleep(400);
      for (const id of ids.filter((x) => !only.length || only.includes(x))) {
        for (const want of ["open", "closed"]) {
          const isOpen = await ev(`${sel(id)}.querySelector(".notice-head").getAttribute("aria-expanded") === "true"`);
          if (isOpen !== (want === "open")) await ev(`${sel(id)}.querySelector(".notice-head").click()`);
          // A card in a folded group of calls is shown once its groups are open.
          await ev(`(() => { let g = ${sel(id)}.closest("details"); while (g) { g.open = true; g = g.parentElement && g.parentElement.closest("details"); } })()`);
          // Images load as they come into view and grow the card: wait for
          // them, then put the card in view again before the clip is taken.
          await ev(`${sel(id)}.scrollIntoView({ block: "center" })`);
          for (let i = 0; i < 40 && !(await ev(`[...${sel(id)}.querySelectorAll("img")].every((m) => m.complete)`)); i++) await sleep(50);
          await sleep(100);
          await ev(`${sel(id)}.scrollIntoView({ block: "center" })`);
          await sleep(150);
          const r = await ev(`(() => { const b = ${sel(id)}.getBoundingClientRect(); return { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: Math.min(b.width + 8, ${w}), height: Math.min(b.height + 8, ${h}) }; })()`);
          const png = await c.send("Page.captureScreenshot", { format: "png", clip: Object.assign(r, { scale: 1 }) });
          fs.writeFileSync(`${shots}/${names[id] || "call"}-${id}-${where}-${want}-${w}-${dark ? "dark" : "light"}.png`, Buffer.from(png.data, "base64"));
        }
      }
    }
  }
}

let proc;
(async () => {
  const c = await open();
  proc = c.proc;
  const { ev } = c;
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(`(() => { try { const r = ${expr}; return r && typeof r === "object" ? true : r; } catch (e) { return false; } })()`);
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what + "; cards in the page: " + JSON.stringify(await ev(`[...document.querySelectorAll(".tool")].map((n) => (n.closest(".act") ? "mini:" : "main:") + n.dataset.ukey + ":" + n.className)`)));
      await sleep(30);
    }
  };
  await c.nav(url + "/auth/login?next=/#/s/pc/s9");
  const main = (id) => `document.querySelector('#log .tool[data-ukey="t:${id}"]')`;
  const mini = (id) => `document.querySelector('.act .mc .tool[data-ukey="t:${id}"]')`;
  const done = ids.filter((id) => !running.includes(id));
  await until(done.map((id) => main(id)).join(" && "), "every finished card in the chat");
  if (running.length) {
    await sleep(500);
    await new Promise((res, rej) => require("http").get(pokeURL, (r) => { r.resume(); r.on("end", res); }).on("error", rej));
  }
  await until(ids.map((id) => main(id)).join(" && "), "every card in the chat");
  // A running call shows as running in the chat and in the subagent's steps, and a finished one does not.
  for (const id of ids) {
    for (const [where, sel] of [["chat", main], ["subagent", mini]]) {
      if (where === "subagent") continue;
      assert.strictEqual(await ev(`${sel(id)}.classList.contains("running")`), running.includes(id), id + ": the " + where + "'s card running state");
    }
  }
  await until(`document.querySelector("#actbtn") && !document.getElementById("actbtn").hidden`, "the Activity button");
  // On a wide screen the panel may open by itself after the chat loads: a
  // click then would close it. Click only while no row shows, now and then.
  for (let i = 0; !(await ev(`!!document.querySelector(".act .row-head") && document.querySelector(".act .row-head").getClientRects().length > 0`)); i++) {
    if (i >= 15) throw new Error("timed out waiting for the subagent row");
    if (i % 3 === 0) await ev(`document.getElementById("actbtn").click()`);
    await sleep(700);
  }
  if (!(await ev(`!!document.querySelector(".act .mc")`))) await ev(`document.querySelector(".act .row-head").click()`);
  await until(ids.map((id) => mini(id)).join(" && "), "every card in the subagent's steps");
  await ev(`document.querySelectorAll("details.toolgroup").forEach((d) => { d.open = true; })`);

  // No clock time or date anywhere in the chat or the Activity panel, but
  // in a message's own corner (.when under a bubble, .ts in a subagent's
  // message) and a scheduled job's schedule: cards, groups, notices and rows
  // say how long, never when.
  const noTimes = async (where) => {
    const hits = await ev(`(() => {
      const re = /\\b\\d{1,2}:\\d\\d\\s?[AP]M\\b|\\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\b|\\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \\d{1,2}, \\d{4}\\b/;
      const out = [];
      for (const root of document.querySelectorAll("#log, .act")) {
        const walk = (n) => {
          if (n.nodeType === 1 && (n.classList.contains("when") || (n.classList.contains("ts") && n.closest(".msg")))) return;
          // A scheduled job's card states its schedule and next run: that is its data.
          if (n.nodeType === 1 && n.matches('.tool[data-tool^="cronjob"]')) return;
          // A scheduled job's card states its schedule and next run: that is its data.
          if (n.nodeType === 1 && n.matches('.tool[data-tool^="cronjob"]')) return;
          if (n.nodeType === 3 && re.test(n.data)) out.push((n.parentElement && n.parentElement.className) + ": " + n.data.trim().slice(0, 80));
          for (const k of n.childNodes) walk(k);
        };
        walk(root);
      }
      return out;
    })()`);
    assert.deepStrictEqual(hits, [], where + ": a clock time or date outside a message's corner");
  };
  const compare = async (state) => {
    await noTimes(state);
    // The subagent's steps never carry Show in Activity: they are in it.
    assert.strictEqual(await ev(`document.querySelectorAll(".act .mc .tool-open").length`), 0, "Show in Activity inside Activity");
    for (const id of ids) {
      const a = await ev(`${shape}(${main(id)}${argsOf(id)})`);
      const b = await ev(`${shape}(${mini(id)}${argsOf(id)})`);
      assert.strictEqual(b, a, `${firefox ? "firefox" : "chrome"}: ${id} ${state}: the subagent's card differs from the chat's`);
    }
  };
  await compare("closed");
  for (const id of ids) {
    await ev(`${main(id)}.querySelector(".notice-head").click()`);
    await ev(`${mini(id)}.querySelector(".notice-head").click()`);
  }
  // A card with nothing more to show (flat) does not open.
  await until(ids.map((id) => `(${main(id)}.querySelector(".notice-head").classList.contains("flat") || ${main(id)}.querySelector(".notice-head").getAttribute("aria-expanded") === "true")`).join(" && "), "the chat's cards open");
  await compare("open");
  // The cards say something: no card has an empty title.
  const titles = await ev(`[...document.querySelectorAll("#log .tool .notice-title")].map((t) => t.textContent)`);
  assert.ok(titles.every((t) => t.trim()), JSON.stringify(titles));
  if (shots && !firefox) await takeShots(c, main, mini);
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); if (proc) proc.kill(); process.exit(1); });
