"use strict";
// Drives the real hub page in headless Chrome over the DevTools protocol.
// usage: node browser.js CHROME HUB_URL PROFILE_DIR
// The chat holds send_file results of every state and a link to a file. The
// media routes are answered by a script the page loads first (stub below),
// so the card is checked on its own; the page, the card code and the CSS are
// the real ones. FILECARD_SHOT=prefix writes one screenshot per card.
const assert = require("assert");
const fs = require("fs");
const zlib = require("zlib");
const [bin, url, dir] = process.argv.slice(2);
const { proc, connect } = require("../cdp.js").launch(bin, dir);
const { until } = require("../cdp.js");

// png makes a plain PNG: a gradient, or a white page with text-like bars.
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; const c = px(x, y); raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255; }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const plot = png(480, 240, (x, y) => [40 + (x >> 2), 90 + (y >> 1), 200 - (x >> 3)]);
const page = png(300, 388, (x, y) => ((y > 40 && y < 56 && x > 24 && x < 150) || (y > 90 && y % 28 < 4 && x > 24 && x < 276) ? [60, 60, 70] : [255, 255, 255]));
const code = ['package main', '', 'import (', '\t"fmt"', '\t"net/http"', ')', '', '// greet says hello to the user in the query.',
  'func greet(w http.ResponseWriter, r *http.Request) {', '\tname := r.URL.Query().Get("user")', '\tif name == "" { name = "alice" }',
  '\tfmt.Fprintf(w, "hello, %s\\n", name)', '}', ...Array.from({ length: 60 }, (_, i) => "// line " + (i + 14))].join("\n") + "\n";

const stub = `(() => {
  const png = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plot = ${JSON.stringify(plot.toString("base64"))}, page = ${JSON.stringify(page.toString("base64"))}, code = ${JSON.stringify(code)};
  const info = {
    "/home/alice/out/alice-board-rev3.zip": { state: "ready", transfers: [] },
    "/tmp/invoice-2026-11.pdf": { state: "ready", transfers: [] },
    "/img/bob-disk-image.tar.zst": { state: "ready", transfers: [{ sent: 1300000000, total: 3200000000, bytes_per_s: 38000000, started: Date.now() - 34000 }] },
    "/src/main.go": { state: "ready", transfers: [] },
    "/tmp/plot.png": { state: "ready", transfers: [] },
    "/data/report-q3.csv": { state: "offline", name: "report-q3.csv", size: 86000, machine: "alice-laptop", machine_kind: "device", transfers: [] },
    "/home/alice/alice-prod2.env": { state: "ready", transfers: [] },
    "/home/alice/notes.xyz": { state: "ready", name: "notes.xyz", size: 3000, mime: "application/octet-stream", kind: "other", type_label: "XYZ file", mtime: Math.floor(Date.now() / 1000) - 7200, machine: "alice-laptop", machine_kind: "device", transfers: [] },
  };
  window.__fetched = [];
  const real = window.fetch.bind(window);
  window.fetch = async (u, o) => {
    const x = new URL(typeof u === "string" ? u : u.url, location.href);
    const m = x.pathname.match(/\\/media(\\/info|\\/preview|\\/stop)?$/);
    if (!m || !x.pathname.startsWith("/api/sessions/")) return real(u, o);
    const p = x.searchParams.get("path");
    window.__fetched.push((o && o.method || "GET") + " " + m[1] + " " + p);
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (m[1] === "/info") return info[p] ? json(info[p]) : new Response("{}", { status: 404 });
    if (m[1] === "/preview") return new Response(png(page), { status: 200, headers: { "Content-Type": "image/png", "X-Talaria-Pages": "2" } });
    if (m[1] === "/stop") return new Response(null, { status: 204 });
    return new Response(code, { status: 206 });
  };
  // An image of a card reads the media route directly: give it a picture.
  const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", { get() { return d.get.call(this); },
    set(v) { d.set.call(this, /\\/media\\?path=%2Ftmp%2Fplot\\.png/.test(v) ? URL.createObjectURL(new Blob([png(plot)], { type: "image/png" })) : v); } });
})();`;

async function shot(c, name, clip) {
  if (!process.env.FILECARD_SHOT) return;
  await c.ev(`(() => { const t = document.querySelector(".tbhold"); if (t) t.style.visibility = "hidden"; })()`);
  const p = { format: "png" };
  if (clip) { p.clip = Object.assign({ scale: 1 }, clip); p.captureBeyondViewport = true; }
  fs.writeFileSync(process.env.FILECARD_SHOT + name + ".png", Buffer.from((await c.send("Page.captureScreenshot", p)).data, "base64"));
}

const cards = `[...document.querySelectorAll(".fc")]`;

async function run(c, w, h, touch, dark) {
  const { ev } = c;
  const tag = (w < 600 ? "412" : "1280") + "-" + (dark ? "dark" : "light");
  await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await c.load(url + "/auth/login?next=/", `[...document.querySelectorAll("#sessions *")].some((x) => x.children.length < 4 && x.textContent.trim().startsWith("Files"))`, "the Files session is listed");
  await ev(`[...document.querySelectorAll("#sessions *")].filter((x) => x.children.length < 4 && x.textContent.trim().startsWith("Files")).pop().click()`);
  await until(ev, `${cards}.length === 10`, tag + ": ten file cards");

  // Nothing is asked of the media routes until a card comes into view; the cards
  // are drawn from the results alone.
  const order = ["zip", "pdf", "big", "code", "img", "gone", "secret", "secret2", "server", "link"];
  const stateOf = {};
  async function view(i) {
    await c.poll(async () => {
      await ev(`${cards}[${i}].scrollIntoView({ block: "center" })`);
      await c.frames(3);
      return ev(`(() => { const b = ${cards}[${i}].getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight; })()`);
    }, "card " + i + " in view");
  }
  const text = (i) => ev(`${cards}[${i}].innerText.replace(/\\s+/g, " ").trim()`);

  // zip
  await view(0);
  await until(ev, `window.__fetched.some((f) => f.includes("alice-board-rev3"))`, tag + ": zip info fetched in view").catch(async (e) => { throw new Error(e.message + " " + JSON.stringify(await ev(`[window.__fetched, ${cards}.length, typeof IntersectionObserver, ${cards}[0].outerHTML.slice(0, 300), window.__errs]`))); });
  let t = await text(0);
  assert.ok(/alice-board-rev3\.zip/.test(t) && /18\.4 MB/.test(t) && /Zip archive/.test(t) && /from alice-laptop/.test(t) && /Gerbers and drill files for rev 3\./.test(t) && /hub keeps no copy/.test(t) && /Download/.test(t), tag + ": zip " + t);
  assert.strictEqual(await ev(`${cards}[0].querySelector("a.dl").getAttribute("href")`), "/api/sessions/" + await ev(`location.hash.split("/")[2]`) + "/s9/media?path=" + encodeURIComponent("/home/alice/out/alice-board-rev3.zip") + "&download=1", tag + ": download link");
  assert.ok(await ev(`!${cards}[5].classList.contains("gone") && !window.__fetched.some((f) => f.includes("report-q3"))`), tag + ": a card out of view is not asked about yet");
  await shot(c, tag + "-zip", await clipOf(c, 0));

  // pdf
  await view(1);
  await until(ev, `${cards}[1].querySelector("img.pdf-page")`, tag + ": pdf preview");
  t = await text(1);
  assert.ok(/PDF, 2 pages/.test(t) && /Page 1 of 2/.test(t) && /Open full size/.test(t) && /from the sandbox/.test(t), tag + ": pdf " + t);
  await until(ev, `${cards}[1].querySelector("img.pdf-page").complete`, tag + ": pdf page drawn");
  await shot(c, tag + "-pdf", await clipOf(c, 1));

  // big, transferring
  await view(2);
  await until(ev, `${cards}[2].dataset.state === "transferring"`, tag + ": transferring");
  t = await text(2);
  assert.ok(/1\.3 of 3\.2 GB/.test(t) && /38 MB\/s/.test(t) && /left/.test(t) && /bob-desktop to hub to your browser/.test(t) && !/Download/.test(t), tag + ": transfer " + t);
  assert.ok(await ev(`${cards}[2].querySelector(".fill").getBoundingClientRect().width > 0`), tag + ": progress bar drawn");
  await shot(c, tag + "-big", await clipOf(c, 2));

  // code
  await view(3);
  await until(ev, `${cards}[3].querySelector("pre.code")`, tag + ": code preview");
  t = await text(3);
  assert.ok(/Go source, 168 lines/.test(t) && /First 40 lines/.test(t) && /Show more/.test(t), tag + ": code " + t);
  assert.ok(await ev(`${cards}[3].querySelector(".gut").textContent.startsWith("1\\n2\\n3")`), tag + ": line numbers");
  await view(3);
  await shot(c, tag + "-code", await clipOf(c, 3));

  // image
  await view(4);
  await until(ev, `${cards}[4].querySelector("img.fc-img") && ${cards}[4].querySelector("img.fc-img").complete && ${cards}[4].querySelector("img.fc-img").naturalWidth > 0`, tag + ": image preview");
  await shot(c, tag + "-image", await clipOf(c, 4));

  // gone
  await view(5);
  await until(ev, `${cards}[5].dataset.state === "gone"`, tag + ": gone");
  t = await text(5);
  assert.ok(/Not available/.test(t) && /was 86 KB/.test(t) && /alice-laptop is offline/.test(t) && !/Download/.test(t), tag + ": gone " + t);
  await shot(c, tag + "-gone", await clipOf(c, 5));

  // secret refused, and the draft button
  await view(6);
  t = await text(6);
  assert.ok(/Not sent/.test(t) && /looks like a secret/.test(t) && /The hub did not read this file\./.test(t) && /alice-laptop's credential rules/.test(t), tag + ": secret " + t);
  await shot(c, tag + "-secret", await clipOf(c, 6));
  await ev(`${cards}[6].querySelector(".row button").click()`);
  assert.ok((await ev(`document.getElementById("input").value`)).includes("Send alice-prod.env anyway."), tag + ": draft in the composer");
  await ev(`document.getElementById("input").value = ""`);

  // secret at the user's request
  await view(7);
  await until(ev, `window.__fetched.some((f) => f.includes("alice-prod2"))`, tag + ": secret2 info");
  t = await text(7);
  assert.ok(/Sent at your request/.test(t) && /No preview is shown/.test(t) && /Download/.test(t) && !/Page 1|First \d+ lines/.test(t), tag + ": secret2 " + t);
  await shot(c, tag + "-secret2", await clipOf(c, 7));

  // refused from the server
  await view(8);
  t = await text(8);
  assert.ok(/refused by the Hermes server's credential rules/.test(t) && /Nothing left the Hermes server/.test(t) && /private key/.test(t), tag + ": server " + t);
  await shot(c, tag + "-server", await clipOf(c, 8));

  // a Markdown link to a file with any extension is a card
  await view(9);
  await until(ev, `/XYZ file/.test(${cards}[9].innerText)`, tag + ": link card info");
  t = await text(9);
  assert.ok(/notes\.xyz/.test(t) && /3 KB/.test(t) && /from alice-laptop/.test(t) && /2 h ago/.test(t) && /Download/.test(t), tag + ": link " + t);
  await shot(c, tag + "-link", await clipOf(c, 9));

  // Copy link: the URL (the clipboard is not read; the toast and the tooltip are).
  await ev(`navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }`);
  await ev(`${cards}[0].querySelector(".fc-copy").click()`);
  const be = await ev(`location.hash.split("/")[2]`);
  assert.strictEqual(await ev(`window.__copied`), url + "/#/file/" + be + "/s9/" + encodeURIComponent("/home/alice/out/alice-board-rev3.zip"), tag + ": copied link");

  // Every card is inside the column (no sideways scroll) and no card folded away.
  assert.ok(await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`), tag + ": the page does not scroll sideways");
  assert.ok(await ev(`${cards}.every((x) => !x.closest("details.toolgroup"))`), tag + ": no card in a folded group");
  const bad = await ev(`${cards}.filter((x) => x.getBoundingClientRect().right > document.getElementById("log").getBoundingClientRect().right + 1).length`);
  assert.strictEqual(bad, 0, tag + ": cards stay inside the log");

  // The card's own page: #/file/... shows that one card above the chat.
  await ev(`location.hash = "#/file/" + ${JSON.stringify(be)} + "/s9/" + encodeURIComponent("/src/main.go")`);
  await until(ev, `document.querySelector(".file-route .fc") && /main\\.go/.test(document.querySelector(".file-route .fc").innerText)`, tag + ": the file route shows its card");
  await ev(`location.hash = "#/s/" + ${JSON.stringify(be)} + "/s9"`);
  await until(ev, `!document.querySelector(".file-route")`, tag + ": the file route closes");
}

// clipOf is the viewport box of card i.
async function clipOf(c, i) {
  const b = await c.ev(`(() => { const r = ${cards}[${i}].getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16 }; })()`);
  return b;
}

(async () => {
  const c = await connect();
  await c.send("Page.enable");
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: stub });
  await run(c, 412, 915, true, false);
  await run(c, 412, 915, true, true);
  await run(c, 1280, 800, false, false);
  await run(c, 1280, 800, false, true);
  c.close();
  await new Promise((r) => { if (proc.exitCode !== null) r(); else proc.once("exit", r); });
})().catch((e) => { console.error(e); proc.kill(); process.exit(1); });
