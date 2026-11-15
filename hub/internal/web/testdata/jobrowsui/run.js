"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, touch)
// or headless Firefox (WebDriver BiDi; picked when the path has "firefox"
// in it, a desktop window).
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// The fake hub has two scheduled jobs. "Chapter watch" has four run chats,
// none opened; "Morning digest" has two, the newer one failed. Asserts that the
// runs of a job are one row in Recent with a count of runs not opened, a
// failed run keeps its own row, a tap on the row opens the newest run and
// the count drops, the chevron lists the runs, a tap on one opens it, the
// count survives a reload, the link goes to the job on the Scheduled page,
// and a search finds each run chat.
// With JOBROWS_SHOTS set (Chrome only) it saves screenshots there.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.JOBROWS_SHOTS || "";

const open = firefox ? require("../bidi.js").launch(bin, dir) : require("../cdp.js").launch(bin, dir);
const { proc, connect } = open;

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
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; hash ${await ev("location.hash")}; list ${await ev(`document.getElementById("sessions").innerText.slice(0, 600)`)}`);
      await sleep(25);
    }
  };
  let phone = false;
  if (firefox) {
    await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
  } else {
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    phone = true;
  }
  const nav = async (u) => {
    if (firefox) await c.goto(u);
    else await c.load(u, "true", "the page");
  };
  const box = (sel) => ev(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return null; n.scrollIntoView({ block: "center" }); const r = n.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 60), y: r.y + r.height / 2, w: r.width }; })()`);
  const tap = async (sel) => {
    await until(`document.querySelector(${JSON.stringify(sel)})`, "to see " + sel);
    await sleep(120);
    const p = await box(sel);
    assert.ok(p && p.w, "no box for " + sel);
    if (firefox) await c.click(p.x, p.y);
    else {
      await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
      await sleep(40);
      await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
  };
  // side opens the chat list on a phone, where it is a panel.
  const side = async () => {
    if (!phone) return;
    if (!(await ev(`document.getElementById("side").classList.contains("open")`))) {
      await tap("#menu");
      await until(`document.getElementById("side").classList.contains("open") && document.getElementById("side").getAnimations().length === 0`, "the list to open");
    }
  };
  const rows = () => ev(`Array.from(document.querySelectorAll("#sessions .group.recent > .item, #sessions .group.recent > .jobgroup > .item")).map((r) => ({
    job: r.classList.contains("jobrow"), name: (r.querySelector(".name") || {}).textContent, where: (r.querySelector(".where") || {}).textContent,
    href: r.querySelector("a.go").getAttribute("href"), unread: r.classList.contains("unread"), dot: !!r.querySelector(".mark.unread"),
    badge: (r.querySelector(".badge") || {}).textContent || ""}))`);
  const job = async (name) => (await rows()).find((r) => r.job && r.name.startsWith(name));
  const shot = async (name) => {
    if (!shots || firefox) return;
    for (const [w, h] of [[412, 915], [1280, 900]]) {
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        if (w < 500) { phone = true; } else { phone = false; }
        await sleep(400);
        if (w < 500) await side();
        await sleep(300);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${shots}/${name}-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
      }
    }
    await c.send("Emulation.setEmulatedMedia", { features: [] });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    phone = true;
  };

  await nav(url + "/auth/login?next=/");
  await until(`document.querySelectorAll("#sessions .item").length >= 3`, "the chats");
  await side();

  // One row for each job, the failed run on its own.
  await until(`document.querySelectorAll("#sessions .jobrow").length === 2`, "two job rows");
  let all = await rows();
  const jobs = all.filter((r) => r.job);
  assert.strictEqual(jobs.length, 2, JSON.stringify(all));
  const cw = await job("Chapter watch");
  assert.ok(cw, JSON.stringify(all));
  assert.strictEqual(cw.badge, "4 new", "count of the Chapter watch row");
  assert.ok(cw.unread && cw.dot, "the row has the unread dot");
  assert.ok(/^Scheduled, every 3 hours · \S/.test(cw.where), "subtitle: " + cw.where);
  assert.strictEqual(cw.href, "#/s/pc/r4", "the row opens the newest run");
  const dg = await job("Morning digest");
  assert.strictEqual(dg.badge, "1 new", "Morning digest counts its one run that did not fail");
  assert.ok(/^Scheduled, every day at 9:00 AM/.test(dg.where), dg.where);
  // The failed run is its own row, the other runs of its job are not.
  const own = all.filter((r) => !r.job).map((r) => r.href);
  assert.ok(own.includes("#/s/pc/d2"), "the failed run keeps its row: " + own);
  for (const id of ["r1", "r2", "r3", "r4", "d1"]) assert.ok(!own.includes("#/s/pc/" + id), id + " is in its job's row");
  assert.ok(own.includes("#/s/pc/plain"), "a chat of no job is unchanged");
  assert.strictEqual(await ev(`document.querySelectorAll("#sessions .jobruns").length`), 0, "runs are listed only when opened");
  await shot("collapsed");

  // A tap on the row opens the newest run; the count drops.
  await tap(`#sessions .jobrow a.go[href="#/s/pc/r4"]`);
  await until(`location.hash === "#/s/pc/r4"`, "the newest run to open");
  await side();
  await until(`Array.from(document.querySelectorAll("#sessions .jobrow .badge")).some((b) => b.textContent === "3 new")`, "the count to drop to 3");
  assert.strictEqual((await job("Chapter watch")).badge, "3 new");

  // The chevron lists the runs, newest first, with how each ended.
  await tap(`#sessions .jobrow .jobtoggle[aria-label*="Chapter watch"]`);
  await until(`document.querySelectorAll("#sessions .jobrun").length === 4`, "the four runs");
  const listed = await ev(`Array.from(document.querySelectorAll("#sessions .jobrun")).map((r) => ({ name: r.querySelector(".name").textContent, how: r.querySelector(".where").textContent, href: r.querySelector("a.go").getAttribute("href"), unread: r.classList.contains("unread") }))`);
  assert.deepStrictEqual(listed.map((r) => r.href), ["#/s/pc/r4", "#/s/pc/r3", "#/s/pc/r2", "#/s/pc/r1"]);
  for (const r of listed) {
    assert.ok(/^Run at \d{1,2}:\d{2}/.test(r.name) || /^Run at \w+ \d{1,2}:\d{2}/.test(r.name), r.name);
    assert.strictEqual(r.how, "Finished");
  }
  assert.deepStrictEqual(listed.map((r) => r.unread), [false, true, true, true]);
  const link = await ev(`document.querySelector("#sessions .jobruns-all").getAttribute("href")`);
  assert.strictEqual(link, "#/scheduled/pc/j1");
  await shot("expanded");

  // A tap on a run opens it; the count drops again.
  await tap(`#sessions .jobrun a.go[href="#/s/pc/r2"]`);
  await until(`location.hash === "#/s/pc/r2"`, "run r2 to open");
  await side();
  await until(`Array.from(document.querySelectorAll("#sessions .jobrow .badge")).some((b) => b.textContent === "2 new")`, "the count to drop to 2");

  // It survives a reload, and so does the open list.
  await nav(url + "/?again=1#/s/pc/r2");
  await until(`document.querySelectorAll("#sessions .jobrow").length === 2`, "the job rows after the reload");
  await side();
  await until(`Array.from(document.querySelectorAll("#sessions .jobrow .badge")).some((b) => b.textContent === "2 new")`, "the count after the reload");
  assert.strictEqual(await ev(`document.querySelectorAll("#sessions .jobrun").length`), 4, "the open list after the reload");

  // The link opens the job on the Scheduled page.
  await tap("#sessions .jobruns-all");
  await until(`location.hash === "#/scheduled/pc/j1"`, "the Scheduled page");
  await until(`document.querySelector("#scheduled .job.open .name") && document.querySelector("#scheduled .job.open .name").textContent === "Chapter watch"`, "the job open on the page");

  // A search finds each run chat on its own.
  await side();
  await ev(`(() => { const i = document.getElementById("search"); i.value = "Chapter"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await until(`document.querySelectorAll('#sessions a.go[href^="#/s/pc/r"]').length === 4 && !document.querySelector("#sessions .jobrow")`, "each run chat in the search");
  await ev(`(() => { const i = document.getElementById("search"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()`);
  await until(`document.querySelectorAll("#sessions .jobrow").length === 2`, "the rows after the search");
  console.log("ok");
  c.close();
  process.exit(0);
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
