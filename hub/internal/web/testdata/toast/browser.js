"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node browser.js CHROME HUB_URL PROFILE_DIR
// At 412 and 1280 px, light and dark, with a chat open: a toast (one, and a
// stack of three with a long name and an error) sits just above the composer,
// centered over the chat column, never over the Activity panel (open or closed),
// the Jump to latest pill (a phone shows Activity as a drawer over the chat), the composer or the send button; an error is role=alert
// and the others role=status; the x closes it; and a toast waits while the
// pointer is on it, then stays 2 s or more. TOAST_SHOT=dir writes
// toast-build-{412,1280}-{light,dark}-{one,stack}.png.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = await connect();
  const { ev, send } = c;
  await send("Page.enable");
  const rect = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`;
  const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const count = () => ev(`document.querySelectorAll("#toasts .toast").length`);

  for (const [w, h, mobile] of [[412, 900, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? "dark" : "light"}`;
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await ev(`window.__old = true`);
      await send("Page.navigate", { url: url + "/auth/login?next=/" });
      await until(ev, `!window.__old && document.getElementById("composer") && window.HubToast`, tag + ": the hub page");
      await ev(`location.hash = "#/s/pc/s1"`);
      await until(ev, `!document.getElementById("composer").hidden && document.getElementById("send").getBoundingClientRect().height > 0`, tag + ": the composer");
      assert.strictEqual(await ev(`!!document.getElementById("toast")`), false, tag + ": the old #toast is gone");

      const shot = async (n) => {
        if (!process.env.TOAST_SHOT) return;
        await sleep(300);
        fs.writeFileSync(`${process.env.TOAST_SHOT}/toast-build-${tag}-${n}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      };
      // A toast sits in the chat column, above the composer (and above the
      // Jump to latest pill when it shows), clear of the Activity panel.
      const clear = async (what) => {
        const comp = await ev(rect("#composer"));
        const sendb = await ev(rect("#send"));
        const col = await ev(rect("section.main"));
        const act = await ev(`(() => { const e = document.getElementById("act"); if (!e || getComputedStyle(e).display === "none") return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; })()`);
        const pill = await ev(`(() => { const e = document.getElementById("tobottom"); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()`);
        const boxes = await ev(`[...document.querySelectorAll("#toasts .toast")].map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })`);
        assert.ok(boxes.length > 0, `${tag} ${what}: a toast is shown`);
        for (const b of boxes) {
          assert.ok(!hit(b, comp), `${tag} ${what}: overlaps the composer ${JSON.stringify([b, comp])}`);
          assert.ok(!hit(b, sendb), `${tag} ${what}: overlaps the send button`);
          assert.ok(b.b <= comp.t + 1 && (b.b < Math.max(...boxes.map((x) => x.b)) || comp.t - b.b < (pill ? 90 : 40)), `${tag} ${what}: just above the composer ${JSON.stringify([b, comp])}`);
          assert.ok(b.l >= col.l - 1 && b.r <= col.r + 1, `${tag} ${what}: inside the chat column ${JSON.stringify([b, col])}`);
          assert.ok(b.l >= 0 && b.r <= w && b.t >= 0, `${tag} ${what}: inside the window ${JSON.stringify(b)}`);
          assert.ok(Math.abs((b.l + b.r) / 2 - (col.l + col.r) / 2) < 2, `${tag} ${what}: centered over the chat column ${JSON.stringify([b, col])}`);
          assert.ok(b.r - b.l <= 460, `${tag} ${what}: at most 28rem wide`);
          if (mobile) assert.ok(b.r - b.l >= w - 24 - 2, `${tag} ${what}: full width on a phone ${JSON.stringify(b)}`);
          if (act && !mobile) assert.ok(!hit(b, act), `${tag} ${what}: overlaps the Activity panel ${JSON.stringify([b, act])}`);
          if (pill) assert.ok(!hit(b, pill) && b.b <= pill.t + 1, `${tag} ${what}: overlaps the Jump to latest pill ${JSON.stringify([b, pill])}`);
        }
        return boxes;
      };
      // Activity open or closed, pill shown or not: one toast each time.
      for (const [actOpen, pillOn] of [[true, false], [false, false], [true, true], [false, true]]) {
        await ev(`document.getElementById("app").classList.toggle("act-closed", ${!actOpen}); document.getElementById("app").classList.remove("act-none"); document.getElementById("tobottom").hidden = ${!pillOn}`);
        await ev(`HubToast.show("Sent. Read after the current step.", { ok: true })`);
        await until(ev, `document.querySelectorAll("#toasts .toast").length === 1`, tag + ": a toast");
        await sleep(300);
        await clear(`act ${actOpen ? "open" : "closed"} pill ${pillOn}`);
        if (actOpen && !pillOn) await shot("act-open");
        if (!actOpen && pillOn) await shot("pill");
        await ev(`document.querySelector("#toasts .toast .x").click()`);
      }
      await ev(`document.getElementById("app").classList.add("act-closed"); document.getElementById("tobottom").hidden = true`);

      // One toast.
      await ev(`HubToast.show("Copied", { ok: true })`);
      await until(ev, `document.querySelectorAll("#toasts .toast").length === 1`, tag + ": one toast");
      await clear("one");
      assert.strictEqual(await ev(`document.querySelector("#toasts .toast").getAttribute("role")`), "status");
      const st = await ev(`(() => { const e = document.querySelector("#toasts .toast"); const s = getComputedStyle(e); return { bg: s.backgroundColor, card: getComputedStyle(document.documentElement).getPropertyValue("--card").trim(), fs: s.fontSize, bl: s.borderLeftWidth }; })()`);
      assert.strictEqual(st.bl, "3px", tag + ": 3px left bar");
      assert.strictEqual(st.fs, "13.6px", tag + ": .85rem text");
      assert.notStrictEqual(st.bg, "rgba(0, 0, 0, 0)");
      await shot("one");
      // The x closes it.
      await ev(`document.querySelector("#toasts .toast .x").click()`);
      assert.strictEqual(await count(), 0, tag + ": x closes");

      // A stack: the steer toast with a long goal, an error, and two more.
      const goal = "Survey every dependency of the build and write up which ones are out of date and why they matter";
      await ev(`HubToast.show("Sent to {name}. It reads it at its next step.", { ok: true, name: ${JSON.stringify(goal)} })`);
      await ev(`HubToast.show("Copied", { ok: true })`);
      await ev(`HubToast.show("Could not send: the subagent already finished", { bad: true })`);
      await ev(`HubToast.show("Copied", { ok: true })`);
      assert.strictEqual(await count(), 3, tag + ": three shown, the identical Copied refreshed");
      await ev(`HubToast.show("Queued for the end of the turn")`);
      assert.strictEqual(await count(), 3, tag + ": at most three");
      const order = await ev(`[...document.querySelectorAll("#toasts .toast .tx")].map((e) => e.textContent)`);
      assert.strictEqual(order[0], "Queued for the end of the turn", tag + ": newest on top");
      assert.ok(!order.some((t) => t.startsWith("Sent to")), tag + ": the oldest was dropped");
      assert.strictEqual(await ev(`document.querySelector("#toasts .toast.bad").getAttribute("role")`), "alert");
      await clear("stack");
      await ev(`HubToast.show("Sent to {name}. It reads it at its next step.", { ok: true, name: ${JSON.stringify(goal)} })`);
      const named = await ev(`(() => { const e = document.querySelector("#toasts .toast .tx"); return { title: e.title, b: e.querySelector("b").textContent, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }; })()`);
      assert.strictEqual(named.title, `Sent to ${goal}. It reads it at its next step.`, tag + ": full text in the title");
      assert.ok(Array.from(named.b).length <= 40 && named.b.endsWith("\u2026"), tag + ": name clamped " + named.b);
      assert.ok(named.lines <= 2, tag + ": at most 2 lines, " + named.lines);
      await shot("stack");
      for (const x of await ev(`document.querySelectorAll("#toasts .toast .x").length`) ? [1, 2, 3, 4] : []) {
        if (!(await count())) break;
        await ev(`document.querySelector("#toasts .toast .x").click()`);
      }
      assert.strictEqual(await count(), 0, tag + ": all closed");
    }
  }

  // Hover pauses a toast; once the pointer leaves it stays 2 s or more.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await ev(`HubToast.show("Copied", { ok: true })`);
  const b = await ev(rect("#toasts .toast"));
  const at = { x: b.l + 40, y: (b.t + b.b) / 2 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(4700); // past its 4.06 s
  assert.strictEqual(await count(), 1, "still shown after its time while the pointer is on it");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 600 });
  await sleep(1500);
  assert.strictEqual(await count(), 1, "still shown 1.5 s after the pointer left");
  await until(ev, `document.querySelectorAll("#toasts .toast").length === 0`, "the toast to go after the pointer left");
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
