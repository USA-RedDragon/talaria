"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone) or headless
// Firefox (BiDi; picked when the path has "firefox" in it, a desktop window)
// through a network drop on the user's side.
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// The page reaches the hub through a small proxy in this script. Cutting the
// network destroys every connection and every new one, so the page sees the
// same NetworkError a dropped Wi-Fi gives. A 5 s drop: no banner of any kind
// at any moment, the chat list stays, few requests. A 30 s drop: no red
// banner, a quiet "Reconnecting" after the 10 s grace, the Activity panel
// quiet too, a bounded number of requests, and on recovery the note goes and
// the list is fetched again. NETDROP_SHOTS=dir saves screenshots at 412 and 1280.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.NETDROP_SHOTS || "";
const open = firefox ? require("../bidi.js").launch(bin, dir) : require("../cdp.js").launch(bin, dir);
const { connect } = open;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The proxy: counts what the page asks, and can be cut.
const up = new URL(url);
const sockets = new Set();
const stat = { cut: false, attempts: 0, served: 0, byPath: {}, streams: new Set() };
const proxy = http.createServer((req, res) => {
  stat.served++;
  const p = req.url.split("?")[0];
  if (p.endsWith("/events")) { const at = Date.now(); stat.streams.add(at); res.on("close", () => stat.streams.delete(at)); }
  stat.byPath[p] = (stat.byPath[p] || 0) + 1;
  const r = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, (u) => {
    res.writeHead(u.statusCode, u.headers);
    u.pipe(res);
    res.on("close", () => u.destroy());
  });
  r.on("error", () => res.destroy());
  req.pipe(r);
  res.on("close", () => r.destroy());
});
proxy.on("connection", (s) => {
  if (stat.cut) { stat.attempts++; s.destroy(); return; }
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});
proxy.on("request", () => {});
const cutNetwork = () => { stat.cut = true; for (const s of sockets) s.destroy(); sockets.clear(); };
const restore = () => { stat.cut = false; };
// asked is what the page asked while cut: refused connections and any
// request that got through before the sockets went.
const asked = (from) => stat.attempts - from.attempts;

(async () => {
  await new Promise((r) => proxy.listen(0, up.hostname, r));
  const purl = "http://" + up.hostname + ":" + proxy.address().port;
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; banner ${await ev(`document.getElementById("banner").innerText`)}`);
      await sleep(50);
    }
  };
  let phone = false;
  if (firefox) await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
  else {
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    phone = true;
  }
  const nav = async (u) => { if (firefox) await c.goto(u); else await c.load(u, "true", "the page"); };

  // Sign in on the hub itself; cookies do not mind the port, so the same
  // session reaches the hub through the proxy.
  await nav(url + "/auth/login?next=/");
  await until(`document.getElementById("composer")`, "the hub page");
  await nav(purl + "/#/s/pc/s1");
  await until(`document.querySelectorAll("#sessions .item").length > 0 && !document.getElementById("composer").hidden`, "the chat list and a chat");
  await ev(`document.getElementById("app").classList.remove("act-closed", "act-none")`);
  const named = await ev(`document.getElementById("sessions").innerText.includes("First")`);
  assert.ok(named, "the list shows the chat First");

  // What the page shows about the network, as the reader would see it.
  const view = () => ev(`(() => {
    const b = document.getElementById("banner");
    const sum = document.getElementById("actsum");
    return { banner: b.hidden ? "" : b.innerText.replace(/\\s+/g, " ").trim(), bad: !b.hidden && b.classList.contains("bad"),
      quiet: !b.hidden && b.classList.contains("quiet"), chats: document.querySelectorAll("#sessions .item").length,
      sum: sum ? sum.innerText.trim() : "", body: /Could not load|NetworkError/.test(document.body.innerText) };
  })()`);
  // Poke the page the way a returning tab or a timer would: more reads.
  const poke = () => ev(`document.dispatchEvent(new Event("visibilitychange"))`);


  const fetches = () => ev(`window.__fetches`);
  const base = { chats: await ev(`document.querySelectorAll("#sessions .item").length`) };
  assert.ok(base.chats > 0);
  // The Activity panel is open (it polls while open).
  await ev(`(() => { const b = document.getElementById("actbtn"); if (b && !document.getElementById("app").classList.contains("act-open")) b.click(); })()`).catch(() => {});
  await ev(`window.__fetches = 0`);

  // A fake clock for the page: its timers and Date.now move only when this
  // script says so, so the grace, the backoff and the stream's waits are
  // driven by explicit steps, not by how fast the machine is. Real events
  // (fetches, connections) are awaited by what they did, never by a sleep.
  await ev(`(() => {
    const real = { st: window.setTimeout.bind(window), ct: window.clearTimeout.bind(window), si: window.setInterval.bind(window), ci: window.clearInterval.bind(window) };
    const k = { now: Date.now(), seq: 0, q: new Map() };
    window.__k = k;
    const add = (fn, ms, every) => { const id = 1e9 + (++k.seq); k.q.set(id, { fn, at: k.now + Math.max(0, ms || 0), every: every ? Math.max(1, ms || 1) : 0 }); return id; };
    window.setTimeout = (fn, ms, ...a) => add(() => fn(...a), ms, false);
    window.setInterval = (fn, ms, ...a) => add(() => fn(...a), ms, true);
    window.clearTimeout = (id) => { if (id >= 1e9) k.q.delete(id); else real.ct(id); };
    window.clearInterval = (id) => { if (id >= 1e9) k.q.delete(id); else real.ci(id); };
    Date.now = () => k.now;
    window.__advance = (ms) => {
      const to = k.now + ms;
      for (let guard = 0; guard < 5000; guard++) {
        let best = null;
        for (const [id, t] of k.q) if (t.at <= to && (!best || t.at < best.t.at || (t.at === best.t.at && id < best.id))) best = { id, t };
        if (!best) break;
        k.now = Math.max(k.now, best.t.at);
        if (best.t.every) best.t.at = k.now + best.t.every; else k.q.delete(best.id);
        try { best.t.fn(); } catch (e) { /* the page's own error handling */ }
      }
      k.now = to;
    };
    window.__pending = 0;
    const f = window.fetch.bind(window);
    window.fetch = (...a) => { window.__fetches++; window.__pending++; const p = f(...a); p.then(() => { window.__pending--; }, () => { window.__pending--; }); return p; };
  })()`);
  // step moves the fake clock by ms and lets what that started finish:
  // timers due now run, in-flight fetches settle, and the page paints.
  const step = async (ms) => {
    await ev(`window.__advance(${ms})`);
    for (let i = 0; i < 400; i++) {
      await ev(`window.__advance(0)`);
      if (await ev(`window.__pending === 0`)) break;
      await sleep(10);
    }
    await ev(`new Promise((res) => { let n = 3; const f = () => (--n > 0 ? requestAnimationFrame(f) : res(true)); requestAnimationFrame(f); })`);
  };
  const sessionsSeen = () => stat.byPath["/api/sessions"] || 0;
  const fakeNow = () => ev(`window.__k.now`);

  // 1. A 5 s drop: nothing shows at any moment, and the page asks for a
  // handful of things, not one per retry.
  {
    const f0 = await fetches();
    const t0 = await fakeNow();
    cutNetwork();
    for (let s = 0; s < 5; s++) {
      await poke();
      await step(1000);
      const v = await view();
      assert.ok(!v.bad && !v.banner && !v.body && v.chats >= base.chats, "a short drop shows nothing at +" + (s + 1) + " s: " + JSON.stringify(v));
    }
    const sent = (await fetches()) - f0;
    assert.ok(sent <= 12, "a 5 s drop costs a handful of page requests, got " + sent);
    console.log(`short drop: ${sent} page requests in 5 s`);
    restore();
    // The shared backoff finds the network again within its longest wait.
    const s0 = sessionsSeen();
    let waited = 0;
    for (; sessionsSeen() <= s0 && waited < 40; waited++) {
      await step(1000);
      const v = await view();
      // A request the browser cut can leave the hub's own quiet note about its
      // agent for a moment: never red, never an error text, the list stays.
      assert.ok(!v.bad && !v.body && v.chats >= base.chats, "nothing red shows while it recovers: " + JSON.stringify(v));
    }
    assert.ok(sessionsSeen() > s0, "the list is fetched again after the drop (fake " + waited + " s)");
    assert.ok(waited <= 30, "found within the longest wait of 30 s, took " + waited);
    console.log(`short drop: list fetched again ${waited} fake s after the network came back`);
  }

  // 2. A 30 s drop: quiet, never red, bounded, and it recovers. The event
  // stream is healthy first (open past its 2 s), so its own grace is
  // counted from this drop.
  {
    for (let i = 0; i < 60 && !(stat.streams.size && (await view()).banner === ""); i++) await step(1000);
    assert.ok(stat.streams.size, "the event stream is open again");
    await step(3000);
    const f0 = await fetches();
    const t0 = await fakeNow();
    cutNetwork();
    let noteAt = -1;
    for (let s = 1; s <= 30; s++) {
      await poke();
      await step(1000);
      const v = await view();
      assert.ok(!v.bad && !v.body && v.chats >= base.chats, "a long drop shows no red and keeps the list at +" + s + " s: " + JSON.stringify(v));
      if (s < 10) assert.ok(!v.banner, "quiet for the first 9 s, at +" + s + " s: " + JSON.stringify(v));
      if (noteAt < 0 && v.quiet && /Reconnecting/.test(v.banner)) noteAt = s;
    }
    assert.ok(noteAt >= 10 && noteAt <= 16, "the quiet Reconnecting note comes after the 10 s grace, at +" + noteAt + " s");
    const sent = (await fetches()) - f0;
    assert.ok(sent <= 20, "a 30 s drop costs a bounded number of page requests, got " + sent);
    if (shots) {
      const r = firefox ? await c.send("browsingContext.captureScreenshot", { context: c.context }) : await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${shots}/netdrop-${firefox ? "firefox-1280" : "chrome-412"}-quiet.png`, Buffer.from(r.data, "base64"));
    }
    console.log(`long drop: ${sent} page requests in 30 s; note at +${noteAt} s`);
    restore();
    const s0 = sessionsSeen();
    let waited = 0;
    for (; waited < 60; waited++) {
      await step(1000);
      const v = await view();
      assert.ok(!v.bad && !v.body, "no error while it recovers: " + JSON.stringify(v));
      if (sessionsSeen() > s0 && !/Reconnecting/.test(v.banner)) break;
    }
    assert.ok(sessionsSeen() > s0, "everything is fetched again once the network is back");
    assert.ok(!/Reconnecting/.test((await view()).banner), "the note is gone after recovery");
    console.log(`recovered ${waited} fake s after the network came back`);
  }

  // Screenshots at 412 and 1280 of the quiet state, with the network cut again.
  if (shots && !firefox) {
    for (const [w, h] of [[412, 915], [1280, 900]]) {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
      await nav(purl + "/?shot=" + w + "#/s/pc/s1");
      await until(`document.querySelectorAll("#sessions .item").length > 0 && !document.getElementById("composer").hidden`, "the page at " + w);
      cutNetwork();
      await until(`/Reconnecting/.test(document.getElementById("banner").innerText)`, "the note at " + w, 30000);
      await sleep(400);
      const r = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${shots}/netdrop-chrome-${w}-quiet.png`, Buffer.from(r.data, "base64"));
      restore();
      await sleep(1500);
    }
  }
  console.log("ok");
  c.close();
  proxy.close();
  process.exit(0);
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
