"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol, a
// Pixel-sized phone) or headless Firefox (WebDriver BiDi, a desktop; picked
// when the path has "firefox" in it).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR (env ONECHAT_SHOTS=dir)
// The chat and its subagent have the same rows (onechat_script_test.go).
// The chat's log and the subagent's steps in Activity must be the same DOM
// from the first thinking block on: the chat starts with the user's prompt,
// the subagent with its task, and only that differs. Then the same with
// every group open.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const shots = process.env.ONECHAT_SHOTS;
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

// shape is the DOM of a log from its first thinking block on, without what
// only one of the two places has: the row numbers the chat's search jumps
// to and the chat's message buttons (msgacts.js). Times that tick read as #.
const shape = `((log) => {
  const walk = (x) => {
    if (x.nodeType === 3) return JSON.stringify(x.data.replace(/\\d+(:\\d+)+|\\d+(\\.\\d+)?\\s?(ms|s|m|h)\\b/g, "#"));
    if (x.nodeType !== 1) return "";
    const attrs = [...x.attributes].filter((a) => a.name !== "data-row" && a.name !== "data-since").map((a) => a.name + "=" + a.value).sort().join(",");
    return x.tagName + (x.hidden ? "[hidden]" : "") + "{" + attrs + "}(" + [...x.childNodes].map(walk).join(" ") + ")";
  };
  const kids = [...log.children].filter((n) => !n.classList.contains("acts"));
  const from = kids.findIndex((n) => n.matches("details.reasoning"));
  return from < 0 ? ["no thinking"] : kids.slice(from).map(walk);
})`;
const MAIN = `document.getElementById("log")`;
const MINI = `document.querySelector(".act .mc > .log")`;

let proc;
(async () => {
  const c = await open();
  proc = c.proc;
  const { ev } = c;
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await ev(`(() => { try { return !!(${expr}); } catch (e) { return false; } })()`);
      if (v) return;
      if (Date.now() > end) throw new Error("timed out waiting for " + what);
      await sleep(50);
    }
  };
  await c.nav(url + "/auth/login?next=/#/s/pc/s9");
  await until(`${MAIN}.querySelectorAll(".msg.assistant").length === 3`, "the chat's replies");
  await until(`document.querySelector("#actbtn") && !document.getElementById("actbtn").hidden`, "the Activity button");
  // On a wide screen the panel may open by itself after the chat loads: a
  // click then would close it. Click only while no row shows, now and then.
  for (let i = 0; !(await ev(`!!document.querySelector(".act .row-head") && document.querySelector(".act .row-head").getClientRects().length > 0`)); i++) {
    if (i >= 15) throw new Error("timed out waiting for the subagent row");
    if (i % 3 === 0) await ev(`document.getElementById("actbtn").click()`);
    await sleep(700);
  }
  if (!(await ev(`!!document.querySelector(".act .mc")`))) await ev(`document.querySelector(".act .row-head").click()`);
  await until(`${MINI} && ${MINI}.querySelectorAll(".msg.assistant").length === 3`, "the subagent's replies");
  await sleep(300);

  const who = firefox ? "firefox" : "chrome";
  const compare = async (state) => {
    const a = await ev(`${shape}(${MAIN})`);
    const b = await ev(`${shape}(${MINI})`);
    assert.strictEqual(b.length, a.length, `${who} ${state}: ${b.length} nodes in the subagent's steps, ${a.length} in the chat`);
    for (let i = 0; i < a.length; i++) assert.strictEqual(b[i], a[i], `${who} ${state}: node ${i} of the subagent's steps differs from the chat's`);
    return a;
  };
  const closed = await compare("closed");
  // What the sequence must show, in both: two thinking blocks, a group of
  // two commands, the finished command's card, the agent's card, the
  // failed turn's card, the user's steer as the user's bubble, the replies.
  const kinds = await ev(`[...${MAIN}.children].filter((n) => !n.classList.contains("acts") && !n.classList.contains("when")).map((n) =>
    n.matches("details.reasoning") ? "think" : n.matches("details.toolgroup") ? "group" : n.matches(".msg.assistant") ? "reply" :
    n.matches(".msg.user") ? "user" : n.classList.contains("notice") ? "notice:" + n.querySelector(".notice-title").textContent : n.className)`);
  assert.deepStrictEqual(kinds.slice(1), ["think", "reply", "group", "notice:Background command finished: OLD=$(kubectl get pods -A)",
    "notice:Message from the chat \"build\"", "think", "reply", "notice:Turn failed", "user", "reply"], JSON.stringify(kinds));
  assert.ok(closed.length > 8);
  // Every group open, then the cards in them.
  await ev(`(() => { document.querySelectorAll("details.toolgroup").forEach((d) => { d.open = true; }); return 1; })()`);
  await sleep(200);
  await compare("groups open");

  if (shots && !firefox) {
    fs.mkdirSync(shots, { recursive: true });
    const { send } = c;
    const panelOpen = () => ev(`!document.getElementById("app").classList.contains("act-closed")`);
    for (const [w, h, mobile] of [[412, 915, true], [1280, 900, false]]) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      for (const scheme of ["light", "dark"]) {
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        for (const where of ["main", "mini"]) {
          // The chat is shot with the Activity panel closed, the subagent's steps with it open.
          const shown = await panelOpen();
          if ((where === "main") === shown) await ev(`document.getElementById("actbtn").click()`);
          await sleep(500);
          const log = where === "main" ? MAIN : MINI;
          // The reader scrolls up (a wheel in the log), so the log stays at its top.
          await ev(`(() => { const l = ${log}; const r = l.getBoundingClientRect();
            l.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, clientX: r.left + 5, clientY: r.top + 5 })); l.scrollTop = 0; return 1; })()`);
          await sleep(150);
          const r = await send("Page.captureScreenshot", { format: "png" });
          fs.writeFileSync(`${shots}/onechat-${where}-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
        }
      }
    }
  }
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); if (proc) proc.kill(); process.exit(1); });
