"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node run.js CHROME HUB_URL PROFILE_DIR DEMO_PROJECT_ID
// A project's notes on Memory > Notes, at 412 and 1280 px, light and dark:
//  - Index (4), Topics (4), Path notes (2), Skills (1) under the project picker;
//  - Index: the "Index space" meter (amber from 80%), the whole project's size, the inbox note, and each line
//    that points to a topic shows its text and a "Topic: <name>" link that opens the topic;
//  - Topics: pills for the inbox and topics no line points to; Open shows the text in place; Edit gives name,
//    description and text; New topic; Delete asks first;
//  - Path notes: patterns as chips and the text; Edit has the patterns and the text.
// Nothing overflows sideways. PROJNOTES_SHOT=dir writes project-notes-v2-build-*.png.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir, demo] = process.argv.slice(2);
const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const btnIn = (scope, text) => `[...${scope}.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)})`;
const row = (name) => `[...document.querySelectorAll("#memory .mem-skill")].find((r) => r.dataset.doc === ${JSON.stringify(name)})`;

async function open(c, w, dark, tag) {
  const { ev, send } = c;
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await ev(`window.__old = true`);
  await send("Page.navigate", { url: url + "/auth/login?next=/" });
  await until(ev, `!window.__old && ${q("#gearbtn")} && document.getElementById("sessions")`, tag + ": the hub page");
}

async function shot(c, name) {
  if (!process.env.PROJNOTES_SHOT) return;
  await sleep(250);
  fs.writeFileSync(`${process.env.PROJNOTES_SHOT}/project-notes-v2-build-${name}.png`, Buffer.from((await c.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
}

const noSideways = async (ev, tag) => assert.ok(await ev(`document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth`), tag + ": nothing overflows sideways");
const text = (ev) => ev(`document.getElementById("memory").innerText`);

async function project(c, tag) {
  const { ev } = c;
  await ev(`location.hash = "#/memory/pc/notes"`);
  await until(ev, `${q('#memory select[data-k="project"]')} && ${q('#memory select[data-k="project"]')}.options.length > 1`, tag + ": the project picker");
  await ev(`(() => { const s = ${q('#memory select[data-k="project"]')}; s.value = ${JSON.stringify(demo)}; s.dispatchEvent(new Event("change")); })()`);
  await until(ev, `${q("#memory .mem-entry")} && ${q('#memory [data-k="sub-topics"]')}`, tag + ": the index");
}

async function sub(c, id, tag) {
  await c.ev(`${q(`#memory [data-k="sub-${id}"]`)}.click()`);
  await until(c.ev, `${q(`#memory [data-k="sub-${id}"]`)}.getAttribute("aria-selected") === "true"`, tag + ": the " + id + " tab");
}

async function index(c, w, tag) {
  const { ev } = c;
  const labels = await ev(`[...document.querySelectorAll("#memory .mem-subtab")].map((b) => b.textContent.replace(/\\s+/g, " ").trim())`);
  assert.deepStrictEqual(labels, ["Index (4)", "Topics (4)", "Path notes (2)", "Skills (1)"], tag + ": tabs with the real counts");
  const t = await text(ev);
  assert.ok(t.includes("Detail lives in topics; the agent reads a topic when a task calls for it."), tag + ": index help");
  assert.ok(/Index space\s+2\d\d \/ 300 characters/.test(t), tag + ": the index meter");
  assert.ok(await ev(`!!${q("#memory .mem-meter.warn")}`), tag + ": amber past 80%");
  assert.ok(t.includes("Only the index has a limit."), tag + ": the whole project's size");
  assert.ok(/The index is \d+% full\. When it fills, Talaria keeps saving/.test(t), tag + ": the 80% note");
  assert.ok(t.includes("The inbox topic holds 1 note saved while the index was full."), tag + ": the inbox note");
  assert.ok(!t.includes("->"), tag + ": no raw pointer");
  const links = await ev(`[...document.querySelectorAll("#memory .mem-entry .mem-link")].map((a) => a.textContent)`);
  assert.deepStrictEqual(links, ["Topic: release", "Topic: gb-timing"], tag + ": topic links");
  assert.ok(!/needs|wants/i.test(t), tag + ": no needs or wants");
  await noSideways(ev, tag);
}

async function topics(c, tag) {
  const { ev } = c;
  // The link on an index line opens its topic.
  await ev(`[...document.querySelectorAll("#memory .mem-link")].find((a) => a.textContent === "Topic: gb-timing").click()`);
  await until(ev, `${q("#memory .mem-skill-text")} && /Mode 3 length/.test(${q("#memory .mem-skill-text")}.textContent)`, tag + ": the topic opens from the link");
  assert.ok((await ev(`location.hash`)).endsWith("/" + demo + "/topics"), tag + ": the address keeps the Topics tab");
  const t = await text(ev);
  assert.ok(t.includes("Every chat gets the list of topic names; the agent reads a topic when a task calls for it."), tag + ": topics help");
  const rows = await ev(`[...document.querySelectorAll("#memory .mem-skill")].map((r) => [r.querySelector(".mem-skill-name").textContent, [...r.querySelectorAll(".mem-pill")].map((p) => p.textContent).join()])`);
  assert.deepStrictEqual(rows, [["gb-timing", ""], ["inbox", "unsorted"], ["mbc-quirks", "not in the index"], ["release", ""]], tag + ": topics and pills");
  assert.ok(await ev(`/changed Nov 13/.test(${row("release")}.textContent)`), tag + ": the date");
  await noSideways(ev, tag);
}

async function paths(c, tag) {
  const { ev } = c;
  await sub(c, "paths", tag);
  await until(ev, `/dot-accurate loop/.test(document.getElementById("memory").innerText) && /pnpm, not npm/.test(document.getElementById("memory").innerText)`, tag + ": path note texts");
  const chips = await ev(`[...document.querySelectorAll("#memory .mem-pill.glob")].map((p) => p.textContent)`);
  assert.deepStrictEqual(chips, ["src/ppu/**", "src/video/*.rs", "web/**/*.ts", "web/**/*.css"], tag + ": patterns");
  await noSideways(ev, tag);
}

(async () => {
  const c = await connect();
  const { ev, send } = c;
  try {
    await send("Page.enable");
    for (const w of [412, 1280]) {
      for (const dark of [false, true]) {
        const th = dark ? "dark" : "light";
        const tag = `${w}-${th}`;
        await open(c, w, dark, tag);
        await project(c, tag);
        await index(c, w, tag);
        await shot(c, `index-${th}-${w}`);
        // Editing an index line.
        await ev(`${btnIn(`document.querySelectorAll("#memory .mem-entry")[1]`, "Edit")}.click()`);
        await until(ev, q("#memory .mem-entry.editing textarea"), tag + ": the line editor");
        await noSideways(ev, tag + " editing a line");
        await shot(c, `index-edit-${th}-${w}`);
        await ev(`${btnIn(q("#memory .mem-entry.editing"), "Cancel")}.click()`);
        await topics(c, tag);
        await shot(c, `topics-${th}-${w}`);
        await ev(`${btnIn(row("gb-timing"), "Edit")}.click()`);
        await until(ev, `${q('#memory .mem-form [data-k="doc-text"]')} && /Mode 3/.test(${q('#memory .mem-form [data-k="doc-text"]')}.value)`, tag + ": the topic editor");
        assert.strictEqual(await ev(`${q('#memory [data-k="doc-desc"]')}.value`), "PPU modes, STAT interrupts, mid-scanline writes", tag + ": the description in the editor");
        await noSideways(ev, tag + " editing a topic");
        await shot(c, `topic-edit-${th}-${w}`);
        await ev(`${btnIn(q("#memory .mem-form"), "Cancel")}.click()`);
        await ev(`${btnIn(row("mbc-quirks"), "Delete")}.click()`);
        await until(ev, `/Delete this topic\\?/.test(${row("mbc-quirks")}.textContent)`, tag + ": asks first");
        await noSideways(ev, tag + " confirm");
        assert.ok(await ev(`[...${row("mbc-quirks")}.querySelectorAll("button")].every((b) => b.getBoundingClientRect().right <= ${row("mbc-quirks")}.getBoundingClientRect().right + 1)`), tag + ": the confirm fits its row");
        await ev(`${row("mbc-quirks")}.scrollIntoView({ block: "center" })`);
        await shot(c, `topics-confirm-${th}-${w}`);
        await ev(`${btnIn(row("mbc-quirks"), "Cancel")}.click()`);
        await paths(c, tag);
        await shot(c, `paths-${th}-${w}`);
        await ev(`${btnIn(row("ppu-code"), "Edit")}.click()`);
        await until(ev, `${q('#memory [data-k="doc-paths"]')} && ${q('#memory [data-k="doc-paths"]')}.value === "src/ppu/**, src/video/*.rs"`, tag + ": the path note editor");
        await noSideways(ev, tag + " editing a path note");
        await shot(c, `path-edit-${th}-${w}`);
        await ev(`${btnIn(q("#memory .mem-form"), "Cancel")}.click()`);
        await sub(c, "skills", tag);
        await until(ev, `document.querySelectorAll("#memory .mem-skill").length === 1`, tag + ": the skills");
        await shot(c, `skills-${th}-${w}`);
      }
    }

    // Changes: edit a topic, create one, delete one with the confirm, change a path note's patterns.
    const tag = "changes";
    await open(c, 412, false, tag);
    await project(c, tag);
    await sub(c, "topics", tag);
    await until(ev, row("gb-timing"), tag + ": topics");
    const set = (k, v) => `(() => { const f = ${q(`#memory [data-k="${k}"]`)}; f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event("input")); })()`;
    await ev(`${btnIn(row("gb-timing"), "Edit")}.click()`);
    await until(ev, `${q('#memory [data-k="doc-text"]')} && /Mode 3/.test(${q('#memory [data-k="doc-text"]')}.value)`, tag + ": the editor");
    await ev(set("doc-text", "# PPU timing\n\nSTAT blocking: a line that stays high does not fire again."));
    await ev(`${btnIn(q("#memory .mem-form"), "Save")}.click()`);
    await until(ev, `/Topic gb-timing is saved/.test(document.getElementById("memory").innerText)`, tag + ": saved");
    await until(ev, `/STAT blocking/.test(${row("gb-timing")}.textContent)`, tag + ": the new text shows");
    await ev(`${btnIn(q("#memory .mem-acts"), "New topic")}.click()`);
    await until(ev, q('#memory [data-k="doc-name"]'), tag + ": the new topic form");
    await ev(set("doc-name", "audio-apu"));
    await ev(set("doc-desc", "APU channel 3 wave RAM"));
    await ev(set("doc-text", "Wave RAM reads return 0xFF while channel 3 plays."));
    await ev(`${btnIn(q("#memory .mem-form"), "Save")}.click()`);
    await until(ev, `${row("audio-apu")} && /Topics \\(5\\)/.test(${q('#memory [data-k="sub-topics"]')}.textContent)`, tag + ": created, and the count follows");
    await ev(`${btnIn(row("mbc-quirks"), "Delete")}.click()`);
    await until(ev, `/Delete this topic\\?/.test(${row("mbc-quirks")}.textContent)`, tag + ": asks first");
    await ev(`${btnIn(row("mbc-quirks"), "Delete")}.click()`);
    await until(ev, `!${row("mbc-quirks")} && /mbc-quirks is deleted/.test(document.getElementById("memory").innerText)`, tag + ": deleted");
    // Search narrows the list.
    await ev(`(() => { const i = ${q('#memory input[type=search]')}; i.value = "wave"; i.dispatchEvent(new Event("input")); })()`);
    assert.deepStrictEqual(await ev(`[...document.querySelectorAll("#memory .mem-skill-name")].map((n) => n.textContent)`), ["audio-apu"], tag + ": search");
    await sub(c, "paths", tag);
    await until(ev, row("ppu-code"), tag + ": path notes");
    await ev(`${btnIn(row("ppu-code"), "Edit")}.click()`);
    await until(ev, `${q('#memory [data-k="doc-paths"]')} && ${q('#memory [data-k="doc-text"]')}.value.length > 0`, tag + ": the path note editor");
    await ev(set("doc-paths", "src/ppu/**, src/lcd/**"));
    await ev(`${btnIn(q("#memory .mem-form"), "Save")}.click()`);
    await until(ev, `/Path note ppu-code is saved/.test(document.getElementById("memory").innerText) && /src\\/lcd/.test(${row("ppu-code")}.textContent)`, tag + ": the patterns change");
    await noSideways(ev, tag);
  } finally {
    c.close();
    proc.kill();
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
