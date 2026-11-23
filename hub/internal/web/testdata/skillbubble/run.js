"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR (env SHOT_PREFIX writes screenshots)
// Asserts that a slash command of a skill shows as a bubble with only what
// the user typed, followed by a collapsed card that holds the skill's text,
// for stored rows and for a command sent from the page, and that nothing of
// the skill's text or of the notes Hermes added is in a bubble. With a
// prefix it writes PREFIX-<412|desktop>-<light|dark>[-open].png.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const shot = process.env.SHOT_PREFIX;

const { proc, connect } = require("../cdp.js").launch(bin, dir);

(async () => {
  const c = await connect();
  const { ev, send } = c;
  await send("Page.enable");
  await c.load(url + "/auth/login?next=/", `document.getElementById("sessions").children.length > 0`, "the chat list");
  await ev(`location.hash = "#/s/pc/s9"; 1`);
  await c.until(`document.querySelectorAll("#log .msg.user").length >= 3 && document.querySelectorAll("#log .notice").length >= 3`, "the stored chat to be drawn");

  const bubbles = `Array.from(document.querySelectorAll("#log .msg.user")).map((n) => n.innerText.trim())`;
  const titles = `Array.from(document.querySelectorAll("#log .notice .notice-title")).map((n) => n.textContent.trim())`;
  const stored = ["/askswsupport-stats", "/askswsupport-stats last 7 days, only TFE", "/askswsupport-stats /ticket-notes compare them"];
  assert.deepStrictEqual(await ev(bubbles), stored, "stored bubbles");
  assert.deepStrictEqual(await ev(titles), ["Skill loaded: askswsupport-stats", "Skill loaded: askswsupport-stats", "Skills loaded: askswsupport-stats, ticket-notes"], "stored cards");
  assert.strictEqual(await ev(`Array.from(document.querySelectorAll("#log .msg.user")).some((n) => /Skill directory|\\[IMPORTANT|Subagents in this chat|supporting files/.test(n.innerText))`), false, "no skill text or note in a bubble");
  assert.strictEqual(await ev(`Array.from(document.querySelectorAll("#log .notice .notice-body-wrap")).every((n) => n.hidden)`), true, "every card is collapsed");
  assert.deepStrictEqual(await ev(`Array.from(document.querySelectorAll("#log .notice")).slice(0, 3).map((n) => { let p = n; while (p && !(p.classList && p.classList.contains("msg") && p.classList.contains("user"))) p = p.previousElementSibling || (p.parentElement && p.parentElement.id !== "log" ? p.parentElement : null); return p ? p.innerText.trim() : null; })`), stored, "each card follows its bubble");

  await ev(`(() => { const i = document.getElementById("input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); i.blur(); return 1; })()`);
  for (const [name, w, h, mobile] of [["412", 412, 915, true], ["desktop", 1280, 800, false]]) {
    for (const scheme of ["light", "dark"]) {
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: mobile ? 2.625 : 1, mobile });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await c.until(`innerWidth === ${w} && matchMedia("(prefers-color-scheme: dark)").matches === ${scheme === "dark"}`, "the size and scheme to apply");
      if (!shot) continue;
      const snap = async (suffix) => {
        const r = await send("Page.captureScreenshot", {});
        fs.writeFileSync(`${shot}-${name}-${scheme}${suffix}.png`, Buffer.from(r.data, "base64"));
      };
      await ev(`document.querySelectorAll("#log .notice-head").forEach((h) => h.getAttribute("aria-expanded") === "true" && h.click()); document.activeElement && document.activeElement.blur(); document.querySelectorAll("#log .msg.user")[1].scrollIntoView({ block: "start" }); 1`);
      await snap("");
      await ev(`document.querySelectorAll("#log .notice-head")[1].click(); document.querySelectorAll("#log .msg.user")[1].scrollIntoView({ block: "start" }); 1`);
      await c.until(`!document.querySelectorAll("#log .notice .notice-body-wrap")[1].hidden`, "the card to open");
      await c.until(`getComputedStyle(document.querySelectorAll("#log .notice-chev")[1]).transform === "none"`, "the arrow to turn down");
      await snap("-open");
    }
  }

  const typed = "/askswsupport-stats last week, only TFE";
  await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(typed)}; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await c.until(`!document.getElementById("send").disabled`, "the send button");
  await ev(`document.getElementById("send").click(); 1`);
  await c.until(`document.querySelectorAll("#log .msg.user").length === 4 && document.querySelectorAll("#log .notice:not(.tool)").length === 4 && !document.querySelector("#log .msg.user.command") && document.querySelectorAll("#log .msg.user").length === document.querySelectorAll("#log .msg.user:not(.pending)").length`, "the sent command to start");
  const live = await ev(bubbles);
  assert.strictEqual(live.length, 4, "one bubble per command: " + JSON.stringify(live));
  assert.ok(/^\/(my-skill|askswsupport-stats) last week, only TFE$/.test(live[3]), "the sent command shows as typed: " + live[3]);
  assert.strictEqual(await ev(`Array.from(document.querySelectorAll("#log .msg.user")).some((n) => /Skill directory|\\[IMPORTANT|supporting files/.test(n.innerText))`), false, "no skill text in the sent bubble");

  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
