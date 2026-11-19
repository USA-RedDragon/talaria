"use strict";
// Drives the real hub page in headless Chrome (DevTools protocol).
// usage: node run.js CHROME HUB_URL PROFILE_DIR SEEN_ID (SEENIMG_SHOTS=dir keeps screenshots)
// Every tool that gives the model an image shows it: vision_analyze, browser_vision, browser_screenshot
// (its own file is gone), and an image the user sent, in the chat and in a subagent's steps.
// The model looked at three images: two files that are not served (outside the
// chat's folder) and one old row with only a path. The rows that name a copy
// Hermes kept show that image, in the chat and in a subagent's steps in
// Activity; the old row with only a path says the image is not available.
// At 412 and 1280 px, light and dark.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, id] = process.argv.slice(2);
const shots = process.env.SEENIMG_SHOTS;
const { launch } = require("../cdp.js");
const { proc, connect } = launch(bin, dir);

(async () => {
  const c = await connect();
  const { ev, send, until } = c;
  await send("Page.enable");
  const shot = async (name) => {
    if (!shots) return;
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${shots}/${name}.png`, Buffer.from(r.data, "base64"));
  };
  const card = (n) => `document.querySelectorAll('#log .tool[data-tool="vision_analyze"]')[${n}]`;
  for (const [w, h, dark, tag] of [[412, 915, false, "412-light"], [412, 915, true, "412-dark"], [1280, 800, false, "1280-light"], [1280, 800, true, "1280-dark"]]) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await c.load(url + "/auth/login?next=/#/s/pc/s9", `document.querySelector("#actbtn")`, tag + ": the chat");
    await until(`document.querySelectorAll('#log .tool[data-tool="vision_analyze"]').length === 2`, tag + ": two vision cards");
    await ev(`document.querySelectorAll("#log details.toolgroup").forEach((d) => { d.open = true; })`);

    // The main chat: the copy Hermes kept is shown for the file that is not served.
    await until(`!!${card(0)}.querySelector(".vis-thumb img") && ${card(0)}.querySelector(".vis-thumb img").complete`, tag + ": the kept copy to load");
    assert.ok(await ev(`${card(0)}.querySelector(".vis-thumb img").naturalWidth === 64`), tag + ": the thumbnail is the kept image");
    assert.ok((await ev(`${card(0)}.querySelector(".vis-thumb img").src`)).includes("/seen/" + id + "?size=thumb"), tag + ": served by id");
    assert.ok(await ev(`!${card(0)}.querySelector(".vis-gone")`), tag + ": no placeholder when a copy exists");
    // An old row with only a path that is gone: the honest placeholder, never a broken image.
    await until(`!${card(1)}.querySelector("img") && !!${card(1)}.querySelector(".vis-gone")`, tag + ": the old row without a copy shows a placeholder");
    // browser_vision and browser_screenshot, whose own screenshot file was deleted, and the user's own image.
    const loaded = async (root, tool, what) => {
      const sel = `${root}.querySelector('.tool[data-tool="${tool}"]')`;
      await until(`!!${sel} && !!${sel}.querySelector(".vis-thumb img") && ${sel}.querySelector(".vis-thumb img").complete`, what + ": the " + tool + " image to load");
      assert.ok(await ev(`${sel}.querySelector(".vis-thumb img").naturalWidth === 64`), what + ": the " + tool + " image is the kept copy");
      assert.ok(await ev(`!${sel}.querySelector(".vis-gone") && !/not available|removed after/.test(${sel}.innerText)`), what + ": " + tool + " says nothing is missing");
      return sel;
    };
    for (const tool of ["browser_vision", "browser_screenshot"]) {
      const sel = await loaded("document.querySelector('#log')", tool, tag + " chat");
      await ev(`${sel}.scrollIntoView({ block: "center" })`);
      await c.frames(3);
      await shot(tool + "-chat-" + tag);
    }
    await until(`!!document.querySelector("#log .atts img") && document.querySelector("#log .atts img").complete`, tag + ": the user's image to load");
    assert.ok(await ev(`document.querySelector("#log .atts img").naturalWidth === 64`), tag + ": the user's image is the kept copy");
    await ev(`${card(0)}.scrollIntoView({ block: "center" })`);
    await c.frames(3);
    await shot("chat-" + tag);
    await ev(`document.querySelector("#log .atts").scrollIntoView({ block: "center" })`);
    await c.frames(3);
    await shot("attachment-" + tag);

    // Open it: the full copy.
    await ev(`${card(0)}.querySelector(".notice-head").click()`);
    await until(`!!${card(0)}.querySelector(".vis-big img") && ${card(0)}.querySelector(".vis-big img").complete`, tag + ": the open card to show the image");
    assert.ok((await ev(`${card(0)}.querySelector(".vis-big img").src`)).endsWith("/seen/" + id), tag + ": the full copy when open");
    assert.ok(await ev(`${card(0)}.querySelector(".vis-big img").naturalWidth === 64`), tag + ": the full copy loaded");

    // A subagent's step in Activity: a file under another folder, never served to the chat.
    await ev(`document.getElementById("actbtn").click()`);
    await until(`document.querySelector(".act .row-head .meta")`, tag + ": the subagent row");
    await ev(`document.querySelector(".act .row-head .meta").click()`);
    await until(`document.querySelectorAll('.act .tool[data-tool="vision_analyze"]').length === 1`, tag + ": the subagent's vision card");
    await ev(`document.querySelectorAll(".act details.toolgroup").forEach((d) => { d.open = true; })`);
    const sub = `document.querySelector('.act .tool[data-tool="vision_analyze"]')`;
    await until(`!!${sub}.querySelector(".vis-thumb img") && ${sub}.querySelector(".vis-thumb img").complete`, tag + ": the subagent's image to load");
    assert.ok(await ev(`${sub}.querySelector(".vis-thumb img").naturalWidth === 64`), tag + ": the subagent's image is the kept copy");
    assert.ok(await ev(`!${sub}.querySelector(".vis-gone")`), tag + ": no 'Image not available here' in the subagent view");
    assert.ok(!/Image not available here/.test(await ev(`${sub}.innerText`)), tag + ": says nothing is missing");
    await ev(`${sub}.scrollIntoView({ block: "center" })`);
    await c.frames(3);
    await shot("subagent-" + tag);
    for (const tool of ["browser_vision", "browser_screenshot"]) {
      await until(`!!document.querySelector('.act .tool[data-tool="${tool}"]')`, tag + ": the subagent's " + tool + " card");
      await ev(`document.querySelectorAll(".act details.toolgroup").forEach((d) => { d.open = true; })`);
      const s2 = await loaded("document.querySelector('.act')", tool, tag + " subagent");
      await ev(`${s2}.scrollIntoView({ block: "center" })`);
      await c.frames(3);
      await shot(tool + "-subagent-" + tag);
    }
    assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), tag + ": the page does not scroll sideways");
    await ev(`document.getElementById("actbtn").click()`);
  }
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
