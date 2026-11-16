"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node browser.js CHROME HUB_URL PROFILE_DIR
// After "/command " the suggestions stay open as help with that command's
// arguments, at 412 (a phone, by touch) and 1280 (a mouse), light and dark:
// "/compress " offers here, focus, --preview and --dry-run under the whole
// usage line; choosing here and a space shows the N hint; "/model " lists the
// models; typing narrows the list; Tab and the arrows and a tap choose;
// Enter still sends unless a choice was moved to; Escape closes; an unknown
// command shows one line. Nothing but the text of the box changes.
// SLASHARGS_SHOT=dir writes slashargs-{412,1280}-{light,dark}-*.png.
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
  const rows = () => ev(`[...document.querySelectorAll("#pop .opt:not(.hintrow) .c")].map((e) => e.textContent.trim())`);
  const hints = () => ev(`[...document.querySelectorAll("#pop .opt.hintrow")].map((e) => e.textContent.trim())`);
  const head = () => ev(`(document.querySelector("#pop .ph .grow") || {}).textContent || ""`);
  const none = () => ev(`(document.querySelector("#pop .none") || {}).textContent || ""`);
  const value = () => ev(`document.getElementById("input").value`);
  const shown = () => ev(`!document.getElementById("pop").hidden`);
  const key = async (k, code) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: code || k, windowsVirtualKeyCode: { Tab: 9, Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[k] });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: code || k });
  };
  // type puts the text in the box as typing does: a focused box and one
  // insert, so the page's own input handling runs.
  const type = async (text) => {
    await ev(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await send("Input.insertText", { text });
  };

  // Hermes's catalog has no /model for the hub; a second page load adds one
  // (window.name) to test the models of a command that is listed.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { const f = window.fetch; window.fetch = async function (u) {
    const r = await f.apply(this, arguments);
    try { if (window.name === "withModel" && String(u).endsWith("/commands")) { const l = await r.clone().json();
      l.push({ name: "/model", description: "Switch model", args: "[model|reset] [--provider name] [--reasoning level] [--global|--session] [--refresh]", aliases: [] });
      return new Response(JSON.stringify(l), { status: 200, headers: { "content-type": "application/json" } }); } } catch (_) { /* as it came */ }
    return r; }; })()` });
  const open = async (tag) => {
    await ev(`window.__old = true`);
    await send("Page.navigate", { url: url + "/auth/login?next=/" });
    await until(ev, `!window.__old && document.getElementById("composer") && window.HubSlash && window.HubSlash.options`, tag + ": the hub page");
    await ev(`location.hash = "#/s/pc/s1"`);
    await until(ev, `!document.getElementById("composer").hidden && document.getElementById("send").getBoundingClientRect().height > 0`, tag + ": the composer");
  };

  for (const [w, h, mobile] of [[412, 915, true], [1280, 900, false]]) {
    for (const dark of [false, true]) {
      const tag = `${w}-${dark ? "dark" : "light"}`;
      await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
      await ev(`window.name = ""`);
      await open(tag);
      const shot = async (n) => {
        if (!process.env.SLASHARGS_SHOT) return;
        await sleep(250);
        fs.writeFileSync(`${process.env.SLASHARGS_SHOT}/slashargs-${tag}-${n}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
      };
      const inside = async (what) => {
        const r = await ev(`(() => { const p = document.getElementById("pop").getBoundingClientRect(); const i = document.getElementById("input").getBoundingClientRect(); return { l: p.left, r: p.right, t: p.top, b: p.bottom, it: i.top, w: innerWidth }; })()`);
        assert.ok(r.l >= 0 && r.r <= r.w + 0.5 && r.t >= 0, `${tag} ${what}: the list is inside the window ${JSON.stringify(r)}`);
        assert.ok(r.b <= r.it + 12, `${tag} ${what}: the list sits above the box ${JSON.stringify(r)}`);
      };

      // The command name alone still lists commands.
      await type("/compr");
      await until(ev, `!document.getElementById("pop").hidden`, tag + ": commands");
      assert.ok((await rows())[0].startsWith("/compress"), `${tag}: commands first ${await rows()}`);

      // "/compress " helps with its arguments.
      await type("/compress ");
      await until(ev, `document.querySelectorAll("#pop .opt").length >= 4`, tag + ": compress arguments");
      assert.deepStrictEqual(await rows(), ["here", "focus", "--preview", "--dry-run"], `${tag}: the words of /compress`);
      assert.deepStrictEqual(await hints(), [], `${tag}: no value to type yet`);
      const h1 = await head();
      assert.ok(h1.includes("/compress") && h1.includes("[here [N] | focus topic | --preview|--dry-run]"), `${tag}: the whole usage line shows: ${h1}`);
      assert.ok(await ev(`getComputedStyle(document.querySelector("#pop .ph .grow")).textTransform === "none"`), `${tag}: the usage keeps its case`);
      const descs = await ev(`[...document.querySelectorAll("#pop .opt .d")].map((e) => e.textContent.trim())`);
      assert.ok(descs.length === 4 && descs.every(Boolean), `${tag}: each word has a description ${descs}`);
      await inside("compress");
      await shot("compress");

      // Enter on an untouched list does not insert a word; the text stays what the user wrote.
      const keep = await ev(`(() => { const i = document.getElementById("input"); const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }); i.dispatchEvent(e); return [e.defaultPrevented, i.value]; })()`);
      assert.deepStrictEqual(keep, [false, "/compress "], `${tag}: Enter is left alone`);

      // Choose "here"; the N hint follows, and nothing is inserted for it.
      if (mobile) {
        const box = await ev(`(() => { const r = document.querySelector("#pop .opt").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
        await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box[0], y: box[1] }] });
        await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await key("Tab");
      }
      await until(ev, `document.getElementById("input").value === "/compress here "`, tag + ": here chosen, got " + (await value()));
      await until(ev, `document.querySelectorAll("#pop .opt.hintrow").length === 1`, tag + ": the N hint");
      assert.deepStrictEqual(await rows(), [], `${tag}: no word after here`);
      const hh = await hints();
      assert.ok(hh[0].startsWith("N") && hh[0].length > 3, `${tag}: N hint with words ${hh}`);
      assert.strictEqual(await value(), "/compress here ", `${tag}: the N hint inserts nothing`);
      await shot("here");

      // Typing narrows the words; the arrows move; Enter on a moved choice inserts it.
      await type("/compress --");
      await until(ev, `document.querySelectorAll("#pop .opt").length === 2`, tag + ": narrowed");
      assert.deepStrictEqual(await rows(), ["--preview", "--dry-run"]);
      await type("/compress --d");
      await until(ev, `document.querySelectorAll("#pop .opt").length === 1`, tag + ": narrowed again");
      assert.deepStrictEqual(await rows(), ["--dry-run"]);
      await type("/compress ");
      await until(ev, `document.querySelectorAll("#pop .opt").length === 4`, tag + ": back to four");
      await key("ArrowDown");
      await key("ArrowDown");
      await until(ev, `document.querySelector("#pop .opt.sel .c").textContent.trim() === "--preview"`, tag + ": the arrows move");
      await key("Enter");
      await until(ev, `document.getElementById("input").value === "/compress --preview "`, tag + ": Enter chose --preview, got " + (await value()));
      await until(ev, `document.getElementById("pop").hidden === false && document.querySelectorAll("#pop .opt, #pop .none").length > 0`, tag + ": the helper goes on");
      assert.ok((await none()).includes("Enter to send"), `${tag}: end of the usage says Enter sends: ${await none()}`);

      // "focus" asks for a topic in words.
      await type("/compress focus ");
      await until(ev, `document.querySelectorAll("#pop .opt.hintrow").length === 1`, tag + ": the topic hint");
      assert.ok((await hints())[0].startsWith("topic"), `${tag}: ${await hints()}`);
      await type("/compress focus the api");
      await sleep(150);
      assert.ok((await hints())[0].startsWith("topic"), `${tag}: the topic hint stays while typing`);

      // Hermes runs no /model from here: the helper says so and lists what the model menu offers.
      await type("/model ");
      await until(ev, `document.querySelector("#pop .none") && document.querySelectorAll("#pop .opt.hintrow").length >= 2`, tag + ": /model unlisted");
      assert.ok((await none()).includes("model menu"), await none());
      const unlisted = await hints();
      assert.ok(unlisted.some((r) => r.startsWith("small")) && unlisted.some((r) => r.startsWith("big")), `${tag}: the menu's models ${unlisted}`);
      assert.deepStrictEqual(await rows(), [], `${tag}: nothing to insert for an unlisted /model`);
      await shot("model-unlisted");

      // A command without arguments, a skill and an unknown command say so in one line.
      await type("/usage ");
      await until(ev, `document.querySelector("#pop .none")`, tag + ": no arguments");
      assert.ok((await none()).includes("no arguments"), await none());
      await type("/my-skill ");
      await until(ev, `document.querySelector("#pop .opt.hintrow")`, tag + ": a skill takes words");
      assert.ok((await hints())[0].includes("your own words"), await hints());
      await type("/nosuchcmd x");
      await until(ev, `document.querySelector("#pop .none")`, tag + ": unknown command");
      assert.ok((await none()).includes("/nosuchcmd"), await none());
      await type("/home/alice/notes.txt is here");
      await sleep(150);
      assert.strictEqual(await shown(), false, `${tag}: a path is not a command`);
      await shot("unknown").catch(() => {});

      // A listed /model lists the models of the model menu, then --provider and --reasoning values.
      await ev(`window.name = "withModel"`);
      await open(tag);
      await type("/model ");
      await until(ev, `document.querySelectorAll("#pop .opt:not(.hintrow)").length >= 3`, tag + ": models");
      const ms = await rows();
      assert.ok(["small", "big"].every((m) => ms.some((r) => r.startsWith(m))), `${tag}: the models ${ms}`);
      assert.ok(ms.includes("reset") && ms.includes("--provider"), `${tag}: and the options of /model ${ms}`);
      assert.ok((await head()).includes("--reasoning level"), `${tag}: the usage line`);
      await shot("model");
      await type("/model re");
      await until(ev, `document.querySelectorAll("#pop .opt:not(.hintrow)").length >= 1 && [...document.querySelectorAll("#pop .opt:not(.hintrow) .c")].every((e) => /re/i.test(e.textContent)) && true`, tag + ": models narrow, rows " + JSON.stringify(await rows()));
      await type("/model --provider ");
      await until(ev, `[...document.querySelectorAll("#pop .opt .c")].some((e) => e.textContent.trim() === "local")`, tag + ": providers after --provider");
      await type("/model --reasoning ");
      await until(ev, `document.querySelectorAll("#pop .opt:not(.hintrow)").length >= 2 && ![...document.querySelectorAll("#pop .opt .c")].some((e) => e.textContent.trim() === "local")`, tag + ": efforts after --reasoning");
      await type("/model sm");
      await until(ev, `[...document.querySelectorAll("#pop .opt .c")].some((e) => e.textContent.trim() === "small")`, tag + ": a model by its name");
      await key("Tab");
      await until(ev, `document.getElementById("input").value === "/model small "`, tag + ": the model is inserted, got " + (await value()));
      await until(ev, `[...document.querySelectorAll("#pop .opt .c")].some((e) => e.textContent.trim() === "--global")`, tag + ": the next options");
      assert.ok(!(await rows()).includes("big"), `${tag}: one model only`);

      // Escape closes the helper and leaves the text.
      await type("/compress ");
      await until(ev, `document.querySelectorAll("#pop .opt").length === 4`, tag + ": open again");
      await key("Escape");
      await until(ev, `document.getElementById("pop").hidden`, tag + ": Escape closes");
      assert.strictEqual(await value(), "/compress ", `${tag}: Escape keeps the text`);
      // A word already chosen is not offered twice where the usage allows it once.
      await type("/compress here 3 ");
      await sleep(150);
      assert.deepStrictEqual(await rows(), [], `${tag}: nothing more after here 3`);
    }
  }
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); try { proc.kill(); } catch (_) { /* gone */ } process.exit(1); });
