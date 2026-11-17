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
const stat = { cut: false, attempts: 0, served: 0, byPath: {} };
const proxy = http.createServer((req, res) => {
  stat.served++;
  const p = req.url.split("?")[0];
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
  // watch samples the view every 100 ms for ms and returns every state seen.
  const watch = async (ms, each) => {
    const seen = [];
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await view();
      seen.push(Object.assign({ at: Date.now() }, v));
      if (each) await each();
      await sleep(100);
    }
    return seen;
  };
  // Poke the page the way a returning tab or a timer would: more reads.
  const poke = () => ev(`document.dispatchEvent(new Event("visibilitychange"))`);

  // Count what the page's own fetch calls send (the page's reads and writes),
  // apart from the connections a browser opens for them and for EventSource.
  await ev(`(() => { window.__fetches = 0; const f = window.fetch.bind(window); window.fetch = (...a) => { window.__fetches++; return f(...a); }; })()`);
  const fetches = () => ev(`window.__fetches`);

  const base = { chats: await ev(`document.querySelectorAll("#sessions .item").length`) };
  assert.ok(base.chats > 0);
  // The Activity panel is open (it polls every 3 s while open).
  await ev(`(() => { const b = document.getElementById("actbtn"); if (b && !document.getElementById("app").classList.contains("act-open")) b.click(); })()`).catch(() => {});
  await sleep(500);

  // 1. A 5 s drop: nothing shows at any moment.
  {
    const from = { attempts: stat.attempts };
    const served = stat.served;
    const f0 = await fetches();
    cutNetwork();
    const seen = await watch(5000, poke);
    restore();
    const more = await watch(3000);
    for (const v of [...seen, ...more]) {
      assert.ok(!v.bad, "a short drop shows no red banner: " + JSON.stringify(v));
      assert.ok(!v.banner, "a short drop shows no banner at all: " + JSON.stringify(v));
      assert.ok(!v.body, "no error text on the page: " + JSON.stringify(v));
      assert.ok(v.chats >= base.chats, "the chat list stays: " + JSON.stringify(v));
    }
    const sent = (await fetches()) - f0;
    assert.ok(sent <= 12, "a 5 s drop costs a handful of page requests, got " + sent);
    // Firefox opens several connections of its own for every request it
    // makes (retries and spare ones): count its connections, but hold the
    // page to its own requests.
    if (!firefox) assert.ok(asked(from) <= 25, "and few connections, got " + asked(from));
    console.log(`short drop: ${sent} page requests, ${asked(from)} refused connections`);
    // Back: the page asks again on its own and recovers.
    await until(`document.querySelectorAll("#sessions .item").length > 0`, "the list after the short drop");
    // The page finds the network on its own at its next probe (at most one
    // wait of the shared backoff after the drop) and fetches the list again.
    const r0 = Date.now();
    const s0 = stat.byPath["/api/sessions"] || 0;
    for (; (stat.byPath["/api/sessions"] || 0) <= s0 && Date.now() - r0 < 45000;) await sleep(100);
    assert.ok((stat.byPath["/api/sessions"] || 0) > s0, "the list is fetched again after the drop");
    console.log(`short drop: list fetched again ${Date.now() - r0} ms after the network came back`);
  }

  // 2. A 30 s drop: quiet, never red, bounded, and it recovers.
  {
    await sleep(2000);
    const from = { attempts: stat.attempts };
    const f0 = await fetches();
    const t0 = Date.now();
    cutNetwork();
    const seen = await watch(30000, poke);
    const reqs = asked(from);
    for (const v of seen) {
      assert.ok(!v.bad, "a long drop shows no red banner: " + JSON.stringify(v));
      assert.ok(!v.body, "no error text on the page: " + JSON.stringify(v));
      assert.ok(v.chats >= base.chats, "the chat list stays: " + JSON.stringify(v));
      if (v.at - t0 < 9000) assert.ok(!v.banner, "quiet for the first 9 s: " + JSON.stringify(v));
    }
    const quiet = seen.find((v) => v.quiet && /Reconnecting/.test(v.banner));
    assert.ok(quiet, "a quiet Reconnecting note shows once the drop lasts: " + JSON.stringify(seen[seen.length - 1]));
    assert.ok(quiet.at - t0 >= 9000 && quiet.at - t0 <= 16000, "the note comes after about 10 s, at " + (quiet.at - t0));
    const sent = (await fetches()) - f0;
    assert.ok(sent <= 20, "a 30 s drop costs a bounded number of page requests, got " + sent);
    if (!firefox) assert.ok(reqs <= 60, "and a bounded number of connections, got " + reqs);
    if (shots) {
      const r = firefox ? await c.send("browsingContext.captureScreenshot", { context: c.context }) : await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(`${shots}/netdrop-${firefox ? "firefox-1280" : "chrome-412"}-quiet.png`, Buffer.from(r.data, "base64"));
    }
    console.log(`long drop: ${sent} page requests, ${reqs} refused connections in 30 s; note at ${quiet.at - t0} ms`);
    restore();
    const s0 = stat.byPath["/api/sessions"] || 0;
    const t1 = Date.now();
    await until(`!document.getElementById("banner") || document.getElementById("banner").hidden || !/Reconnecting/.test(document.getElementById("banner").innerText)`, "the note to go after recovery", 40000);
    for (; (stat.byPath["/api/sessions"] || 0) <= s0 && Date.now() - t1 < 40000;) await sleep(100);
    assert.ok((stat.byPath["/api/sessions"] || 0) > s0, "everything is fetched again once the network is back");
    const after = await watch(2000);
    for (const v of after) assert.ok(!v.bad && !v.body, "no error after recovery: " + JSON.stringify(v));
    console.log(`recovered ${Math.round((Date.now() - t1))} ms after the check began`);
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
