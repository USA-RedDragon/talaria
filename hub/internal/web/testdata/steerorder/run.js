"use strict";
// Drives the real hub page on a phone: headless Chrome with Pixel
// emulation and touch (DevTools protocol), or headless Firefox at phone
// size (WebDriver BiDi; picked when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR POKE_URL
// POKE_URL/start/<chat> starts a turn in the chat as another app does,
// POKE_URL/tool/<chat>/<id> runs one tool round of it (the turn reads the
// steers sent before it and stores them after its result),
// POKE_URL/finish/<chat> ends it.
// Asserts that three steers sent between tool calls of a running turn,
// two read and one not yet, show after a switch to another chat and back
// in the order and look of a fresh load: each once, solid, where the turn
// read it, the unread one at the end marked as sent to the turn.
// STEERORDER_SHOT=prefix writes Chrome screenshots at 412 and 1280 px,
// light and dark.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, poke] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const shotPrefix = kind === "chrome" ? process.env.STEERORDER_SHOT : "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 412;
const H = 915;

// The page records the kind of each chat event it gets and the chat it is for.
const preload = `() => {
  const E = window.EventSource;
  window.__kinds = [];
  window.EventSource = function (u, o) {
    const s = new E(u, o);
    s.addEventListener("message", (m) => { try { const e = JSON.parse(m.data); window.__kinds.push({ k: e.kind, u: String(u).split("/").slice(-2, -1)[0] }); } catch (_) { /* not ours */ } });
    return s;
  };
  window.EventSource.prototype = E.prototype;
}`;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return {
      proc,
      connect: async () => {
        const c = await connect();
        await c.send("script.addPreloadScript", { functionDeclaration: preload });
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
      await c.send("Page.addScriptToEvaluateOnNewDocument", { source: "(" + preload + ")()" });
      await c.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" });
      await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2.625, mobile: true });
      await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const tap = async (x, y) => {
        await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      return { ev: c.ev, send: c.send, nav: (u) => c.send("Page.navigate", { url: u }), reload: () => c.send("Page.reload", {}), tap, close: c.close };
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
      if (Date.now() > end) throw new Error(`${kind}: timed out waiting for ${what}; last ${JSON.stringify(last)}; log tail: ${JSON.stringify(await ev(`document.getElementById("log").innerText.slice(-600)`).catch(() => ""))}`);
      await sleep(25);
    }
  };
  const frames = (n = 3) => ev(`new Promise((res) => { let k = ${n}; const f = () => (--k > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  const hit = (path) => fetch(poke + path).then((r) => assert.strictEqual(r.status, 204, path));
  // order lists the chat's user bubbles and tool cards in the order they
  // show: "u:<text>" with "(dim)" for a bubble that reads as sending and
  // the line under it, "t:<tool id>" for a card.
  const order = () => ev(`Array.from(document.querySelectorAll("#log .msg.user, #log [data-ukey^='t:']")).map((n) => {
    if (n.matches("[data-ukey^='t:']")) return n.dataset.ukey;
    let next = n.nextElementSibling;
    while (next && !next.classList.contains("msg") && !next.classList.contains("queued") && !next.matches("[data-ukey^='t:']")) next = next.nextElementSibling;
    const line = next && next.classList.contains("queued") ? " [" + next.firstChild.textContent.trim() + "]" : "";
    return "u:" + n.innerText.trim().split("\\n")[0] + (n.classList.contains("pending") ? " (dim)" : "") + line;
  })`);
  const heard = (id, from) => `window.__kinds.slice(${from}).some((k) => k.u === "${id}" && (k.k === "snapshot" || k.k === "snapshot.same"))`;
  const open = async (id, title, ready) => {
    const from = await ev(`(() => { const n = window.__kinds.length; location.hash = "#/s/pc/${id}"; return n; })()`);
    await until(`location.hash === "#/s/pc/${id}" && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 0 && ${heard(id, from)}${ready ? " && (" + ready + ")" : ""}`, `${id} to be drawn`);
    await frames(4);
  };
  const send = async (text) => {
    await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
    await until(`!document.getElementById("send").disabled`, "the send button");
    const b = await ev(`(() => { const r = document.getElementById("send").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.tap(b.x, b.y);
    await until(`document.getElementById("input").value === ""`, "the message box to empty after " + JSON.stringify(text));
  };
  const sentToTurn = (n) => until(`Array.from(document.querySelectorAll("#log .queued")).filter((q) => q.textContent.includes("Sent to the running turn")).length === ${n}`, n + " steers marked sent to the running turn");
  // mine keeps the entries of the turn under test: its cards and steers.
  const mine = (id, list) => list.filter((x) => x.startsWith("t:" + id + "-") || x.includes(id + " steer"));
  const shoot = async (name) => {
    if (!shotPrefix) return;
    for (const [w, h, mobile] of [[W, H, true], [1280, 900, false]]) {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2.625 : 1, mobile });
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await frames(6);
        await ev(`(() => { const l = document.getElementById("log"); l.scrollTop = l.scrollHeight; return 1; })()`);
        await frames(6);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${shotPrefix}${name}-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
      }
    }
    await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2.625, mobile: true });
    await c.send("Emulation.setEmulatedMedia", { features: [] });
    await frames(4);
  };

  await c.nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll('#sessions a.go[href="#/s/pc/first"]').length === 1`, "the chat list");
  await until(`innerWidth === ${W}`, "the phone size");

  const steerTurn = async (id, title) => {
    if (!(await ev(`location.hash === "#/s/pc/${id}"`))) await open(id, title);
    await hit(`/start/${id}`);
    await until(`document.getElementById("subtitle").textContent !== ""`, `the turn in ${id} to run`);
    await hit(`/tool/${id}/${id}-a`);
    await send(`${id} steer one`);
    await sentToTurn(1);
    await hit(`/tool/${id}/${id}-b`);
    await send(`${id} steer two`);
    await sentToTurn(2);
    await hit(`/tool/${id}/${id}-c`);
    await send(`${id} steer three`);
    await sentToTurn(3);
    await until(`document.querySelectorAll("#log [data-ukey='t:${id}-c']").length === 1`, "the last card");
    await frames(4);
    return mine(id, await order());
  };
  // want is where Hermes put each steer: one and two after the result of
  // the tool round that read them, three at the end, not read yet.
  const want = (id) => [`t:${id}-a`, `t:${id}-b`, `u:${id} steer one`, `t:${id}-c`, `u:${id} steer two`,
    `u:${id} steer three [Sent to the running turn]`];

  for (const [id, title] of [["again", "Later turn"], ["first", "First turn"]]) {
    if (id === "again") {
      // A turn ends while the hub follows the chat: coming back, the hub
      // takes a new snapshot instead of replaying what it buffered.
      await open(id, title);
      await hit(`/start/${id}`);
      await hit(`/finish/${id}`);
      await until(`document.getElementById("log").innerText.includes("finished ${id}")`, "the earlier turn's reply");
    }
    const live = await steerTurn(id, title);
    console.log(kind, id, "live", JSON.stringify(live));
    await open("elsewhere", titleOther());
    await open(id, title, `document.querySelectorAll("#log [data-ukey='t:${id}-c']").length === 1`);
    await frames(6);
    const back = mine(id, await order());
    console.log(kind, id, "back", JSON.stringify(back));
    await shoot(`${id}-back`);
    // A fresh load of the chat, the reference.
    await ev(`(window.__old = true)`);
    await c.reload();
    await until(`!window.__old && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log [data-ukey='t:${id}-c']").length === 1 && ${heard(id, 0)}`, "the chat after a reload");
    await frames(6);
    const fresh = mine(id, await order());
    console.log(kind, id, "fresh", JSON.stringify(fresh));
    assert.deepStrictEqual(fresh, want(id), `${kind} ${id}: a fresh load shows the steers where the turn read them`);
    assert.deepStrictEqual(back, fresh, `${kind} ${id}: back in the chat, the steers show as a fresh load shows them`);
    // Away and back once more, now from the fresh load.
    await open("elsewhere", titleOther());
    await open(id, title, `document.querySelectorAll("#log [data-ukey='t:${id}-c']").length === 1`);
    await frames(6);
    assert.deepStrictEqual(mine(id, await order()), fresh, `${kind} ${id}: back again, the steers show as a fresh load shows them`);
    // The turn ends and reads the last steer.
    await hit(`/finish/${id}`);
    await until(`document.getElementById("log").innerText.includes("finished ${id}") && !document.querySelector("#log .queued")`, "the turn to end");
    await frames(4);
    const done = [`t:${id}-a`, `t:${id}-b`, `u:${id} steer one`, `t:${id}-c`, `u:${id} steer two`, `u:${id} steer three`];
    assert.deepStrictEqual(mine(id, await order()), done, `${kind} ${id}: after the turn, each steer once and solid`);
    await open("elsewhere", titleOther());
    await open(id, title);
    assert.deepStrictEqual(mine(id, await order()), done, `${kind} ${id}: after the turn and a switch, each steer once and solid`);
    await ev(`(window.__old = true)`);
    await c.reload();
    await until(`!window.__old && document.getElementById("title").textContent === ${JSON.stringify(title)} && !document.querySelector("#log .loading") && document.querySelectorAll("#log [data-ukey='t:${id}-c']").length === 1 && ${heard(id, 0)}`, "the chat after a reload");
    await frames(4);
    assert.deepStrictEqual(mine(id, await order()), done, `${kind} ${id}: after the turn and a reload, each steer once and solid`);
  }

  console.log(kind + ": ok");
  c.close();
})().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  try { proc.kill(); } catch (_) { /* gone */ }
  process.exit(1);
});

function titleOther() { return "Other"; }
