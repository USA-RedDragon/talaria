"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, touch).
// usage: node run.js CHROME_BIN HUB_URL PROFILE_DIR
// The signed-in user is a Claude admin of the backend "pc" and may not use
// it. Asserts that #/usage/pc/30 stays on pc (the page does not fall back to
// another backend), shows the Claude accounts panel and nothing else of
// the backend, never asks for its chat usage, and opens the sign-in from
// the panel's button. With USAGEADMIN_SHOTS set to a folder it saves
// screenshots at 412 and 1280, light and dark.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const shots = process.env.USAGEADMIN_SHOTS || "";
const { proc, connect } = require("../cdp.js").launch(bin, dir);

(async () => {
  const c = await connect();
  const { ev } = c;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; hash ${await ev("location.hash")}; page ${await ev(`document.getElementById("usage").innerText.slice(0, 600)`)}`);
      await sleep(25);
    }
  };
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await c.load(url + "/#/usage/pc/30", "true", "the page");
  await until(`document.querySelector("#usage .claude-panel .claude-account")`, "the accounts panel");

  assert.strictEqual(await ev("location.hash"), "#/usage/pc/30", "the page stays on the backend it was asked for");
  assert.strictEqual(await ev(`document.querySelectorAll("#usage .usage-sec").length`), 1, "only the Claude panel");
  assert.strictEqual(await ev(`document.querySelectorAll("#usage select[aria-label='Agent server']").length`), 0, "no other backend to pick");
  assert.strictEqual(await ev(`document.querySelector("#usage .usage-backend").textContent`), "Kittykat", "the backend is named");
  assert.strictEqual(await ev(`document.querySelectorAll("#usage select").length`), 0, "no time range for a backend without chat usage");
  assert.strictEqual(await ev(`document.querySelector("#usage .claude-panel h2").textContent`), "Subscription accounts");
  assert.ok(await ev(`document.querySelectorAll("#usage .claude-account").length`) >= 1, "accounts");
  assert.strictEqual(await ev(`performance.getEntriesByType("resource").filter((r) => /\\/api\\/(usage|claude-code)/.test(r.name)).length`), 0, "no chat usage or Claude Code request");
  assert.ok(await ev(`Array.from(document.querySelectorAll("#usage .claude-account button")).some((b) => /Sign in/.test(b.textContent))`), "a sign-in button");

  // The sign-in dialog starts and shows the link.
  await ev(`Array.from(document.querySelectorAll("#usage .claude-account button")).find((b) => /Sign in/.test(b.textContent)).click()`);
  await until(`document.querySelector("dialog.claude-dialog[open] a.claude-link")`, "the sign-in link");

  if (shots) {
    await ev(`document.querySelector("dialog.claude-dialog").close()`);
    for (const [w, h] of [[412, 915], [1280, 900]]) {
      await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
      await c.load(url + "/?shot=" + w + "#/usage/pc/30", "true", "the page at " + w);
      await until(`document.querySelector("#usage .claude-panel .claude-account")`, "the panel at " + w);
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await sleep(500);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${shots}/usage-admin-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
      }
    }
  }
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
