"use strict";
// Drives the real hub page in headless Chrome or Firefox and checks the
// view report: a log moved off the newest message by the page itself,
// long after the chat opened and with nobody touching it, produces exactly
// one report that goes through fetch to the hub; a real wheel scroll
// produces none.
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR MODE
// MODE is jump (a script moves the log), wheel (the reader scrolls up),
// mid (the reader scrolls up, presses something outside the log, and a
// script then throws the log more than a screen further up: one jump
// report), swipe (Chrome only: a finger swipes up on a phone while older
// rows render above; the reader stays put) or hand (Alt+J sends the record by hand, with a toast).
// Prints ok when the page's own count is right; the Go test counts the
// lines the hub logged.
const assert = require("assert");
const [bin, url, dir, mode] = process.argv.slice(2);
const kind = /firefox/.test(bin) ? "firefox" : "chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1504;
const H = 1002;

const preload = `() => {
  window.__reports = [];
  window.__answers = [];
  const f0 = window.fetch;
  window.fetch = function (u, o) {
    const p = f0.apply(this, arguments);
    if (String(u).includes("/api/view-report")) {
      const b = JSON.parse(o.body);
      window.__reports.push({ kind: b.kind, why: b.why, keepalive: !!o.keepalive, body: o.body });
      p.then((r) => window.__answers.push({ kind: b.kind, status: r.status }), () => window.__answers.push({ kind: b.kind, status: 0 }));
    }
    return p;
  };
}`;

function driver() {
  if (kind === "firefox") {
    const { proc, connect } = require("../bidi.js").launch(bin, dir);
    return {
      proc,
      connect: async () => {
        const c = await connect();
        await c.send("script.addPreloadScript", { functionDeclaration: preload });
        await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: W, height: H }, devicePixelRatio: 1.5 });
        const wheel = (x, y, dy) => c.send("input.performActions", { context: c.context, actions: [{ type: "wheel", id: "w", actions: [{ type: "scroll", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: dy }] }] });
        return { ev: c.ev, nav: (u) => c.goto(u), wheel, close: c.close };
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
      if (mode === "swipe") {
        // A phone: touch only, as Chrome on Android.
        await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true });
        await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      } else await c.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1.5, mobile: false });
      return {
        ev: c.ev,
        // A finger that drags the log down by dy px (the view goes up).
        // Several strokes from y, 20 px a frame, as a thumb reading up.
        swipe: async (x, y, dy) => {
          const touch = (type, ty) => c.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(ty), id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
          for (let done = 0; done < dy; done += 400) {
            await touch("touchStart", y);
            for (let k = 1; k <= 20; k++) {
              await sleep(16);
              await touch("touchMove", y + 20 * k);
            }
            await touch("touchEnd", y + 400);
            await sleep(120);
          }
        },
        nav: (u) => c.send("Page.navigate", { url: u }),
        wheel: (x, y, dy) => c.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }),
        close: c.close,
      };
    },
  };
}

const { proc, connect } = driver();
(async () => {
  const c = await connect();
  const { ev } = c;
  const until = async (expr, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (v) return v;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(25);
    }
  };
  await c.nav(url + "/auth/login?next=/#/s/pc/long1");
  await until(`location.hash === "#/s/pc/long1" && !document.querySelector("#log .loading") && document.querySelectorAll("#log .msg").length > 5`, "long1 drawn");
  await until(`window.__reports.some((r) => r.kind === "loaded")`, "the page loaded report");
  // Well past the open: the report is not only for the first seconds.
  await sleep(16500);
  const gap = () => ev(`(() => { const l = document.getElementById("log"); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight); })()`);
  assert.ok((await gap()) <= 24, "the chat is not at its newest message before the test moves it");
  const left = () => ev(`window.__reports.filter((r) => r.kind === "left")`);
  if (mode === "jump") {
    await ev(`(() => { const l = document.getElementById("log"); l.scrollTop -= 400; return 1; })()`);
    await until(`window.__reports.some((r) => r.kind === "left")`, "the view report", 10000);
    // Back to the end and away again inside 30 s: no second report.
    await sleep(600);
    await ev(`(() => { const l = document.getElementById("log"); l.scrollTop = l.scrollHeight; return 1; })()`);
    await sleep(600);
    await ev(`(() => { const l = document.getElementById("log"); l.scrollTop -= 400; return 1; })()`);
    await sleep(1500);
    const rs = await left();
    assert.strictEqual(rs.length, 1, "reports: " + rs.length);
    assert.ok(rs[0].keepalive, "the report goes with keepalive");
    const b = JSON.parse(rs[0].body);
    for (const k of ["chat", "ms", "up", "vis", "nav", "reconnect60", "loaded60", "trail", "stack", "gap"]) assert.ok(k in b, "no " + k + " in the report");
    assert.ok(b.up > 16000, "up = " + b.up);
    assert.ok(/^[0-9a-f]{8}$/.test(b.chat), "chat = " + b.chat);
    assert.ok(!rs[0].body.includes("long1"), "the report names the chat");
    await until(`window.__answers.some((a) => a.kind === "left" && a.status === 204)`, "the hub's answer");
  } else if (mode === "swipe") {
    // A finger swipes up from the newest message while older rows render
    // above: the reader stays on what the swipe brought into view.
    const box = await ev(`(() => { const r = document.getElementById("log").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 60 }; })()`);
    await c.swipe(box.x, box.y, 2800);
    await sleep(2500);
    const g = await gap();
    const js = await ev(`window.__reports.filter((r) => r.kind === "jump").map((r) => r.body)`);
    assert.strictEqual(js.length, 0, "a finger's swipe was reported as a jump: " + js.join("\n").slice(0, +(process.env.VR_DUMP || 600)));
    assert.ok(g > 1800 && g < 4200, "after a 2800 px swipe the log is " + g + " px from its end");
    assert.strictEqual((await left()).length, 0, "a reader's swipe was reported as a leave");
  } else if (mode === "mid" || mode === "hand") {
    const box = await ev(`(() => { const r = document.getElementById("log").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.wheel(box.x, box.y, -1500);
    await until(`(() => { const l = document.getElementById("log"); return l.scrollHeight - l.scrollTop - l.clientHeight > 100; })()`, "the wheel to move the log");
    await sleep(2500);
    if (await ev(`document.getElementById("log").scrollTop < 1.7 * document.getElementById("log").clientHeight`)) {
      await c.wheel(box.x, box.y, 1200);
      await sleep(2500);
    }
    const text = (b) => b.includes("answer that fills") || b.includes("question x") || b.includes("long1");
    if (mode === "mid") {
      // A press outside the log, then the page itself moves the reader.
      await ev(`(() => { document.getElementById("title").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); return 1; })()`);
      const by = await ev(`(() => { const l = document.getElementById("log"); const by = Math.round(Math.min(l.scrollTop - 10, 1.6 * l.clientHeight)); l.scrollTop -= by; return by / l.clientHeight; })()`);
      assert.ok(by > 1.05, "the log has too little above the reader for the test: " + by);
      await until(`window.__reports.some((r) => r.kind === "jump")`, "the jump report", 10000);
      await sleep(1000);
      const rs = await ev(`window.__reports.filter((r) => r.kind === "jump" && r.why === "jump")`);
      assert.strictEqual(rs.length, 1, "jump reports: " + rs.length);
      const b = JSON.parse(rs[0].body);
      assert.strictEqual(b.why, "jump");
      assert.ok(b.d > 0 && b.from && b.to && b.from.top > b.to.top, "the report has no move: " + rs[0].body.slice(0, 400));
      assert.ok(Array.isArray(b.ring) && b.ring.some((e) => e[1] === "i" && e[2] === "x"), "the press outside the log is not in the ring");
      assert.ok(b.ring.some((e) => e[1] === "gw"), "the wheel is not in the ring");
      assert.ok(!text(rs[0].body), "the report holds chat text");
      assert.ok(/\.js:\d+[^"]*=\d+/.test(JSON.stringify(b.ring)), "the ring has no scrollTop write with its call site");
      await until(`window.__answers.some((a) => a.kind === "jump" && a.status === 204)`, "the hub's answer");
    } else {
      await ev(`(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", code: "KeyJ", altKey: true, bubbles: true })); return 1; })()`);
      await until(`window.__reports.some((r) => r.kind === "manual")`, "the manual report", 10000);
      await until(`document.body.textContent.includes("Sent what just happened. Thanks.")`, "the toast", 10000);
      const rs = await ev(`window.__reports.filter((r) => r.kind === "manual")`);
      const b = JSON.parse(rs[0].body);
      assert.ok(Array.isArray(b.ring) && b.ring.length > 3, "the manual report has no ring");
      assert.ok(!text(rs[0].body), "the report holds chat text");
      await until(`window.__answers.some((a) => a.kind === "manual" && a.status === 204)`, "the hub's answer");
    }
    const left = await ev(`window.__reports.filter((r) => r.kind === "left").length`);
    assert.strictEqual(left, 0, "a reader's own scroll up was reported as a leave");
  } else {
    const box = await ev(`(() => { const r = document.getElementById("log").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await c.wheel(box.x, box.y, -1500);
    await until(`(() => { const l = document.getElementById("log"); return l.scrollHeight - l.scrollTop - l.clientHeight > 100; })()`, "the wheel to move the log");
    await sleep(2000);
    const rs = await left();
    assert.strictEqual(rs.length, 0, "a reader's scroll was reported");
    // As far from the newest message as the wheel went, not thrown into
    // the older rows that rendered above.
    const g = await gap();
    assert.ok(g > 1000 && g < 2600, "after a 1500 px wheel the log is " + g + " px from its end");
    // Older rows render above the reader during the wheel: the reader stays
    // on the rows the wheel brought into view.
    const js = await ev(`window.__reports.filter((r) => r.kind === "jump").map((r) => r.body)`);
    assert.strictEqual(js.length, 0, "a reader's scroll was reported as a jump: " + js.join("\n").slice(0, +(process.env.VR_DUMP || 600)));
  }
  const loaded = await ev(`window.__reports.filter((r) => r.kind === "loaded").length`);
  assert.strictEqual(loaded, 1, "page loaded reports: " + loaded);
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
