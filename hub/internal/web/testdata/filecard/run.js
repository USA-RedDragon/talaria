"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const [script, icons, fake] = process.argv.slice(2);
const { el, El } = require(require("path").resolve(fake));
const sandbox = { window: {}, document: { createElementNS: (ns, t) => new El(t), createElement: (t) => new El(t) } };
sandbox.window.document = sandbox.document;
vm.runInNewContext(fs.readFileSync(icons, "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync(script, "utf8"), sandbox);
const FC = sandbox.window.HubFileCard;

const NOW = Date.parse("2026-11-14T12:00:00Z");
const BASE = "/api/sessions/b%201/s9";

// A fake page: info answers per path, a record of calls.
function world(info, extra) {
  const w = { calls: [], drafts: [], copies: [], loaders: [], every: [], stops: 0, info, infoNow: () => info };
  w.ctx = Object.assign({
    el, base: BASE, backend: "b 1", session: "s9", origin: "https://hub.example.com", now: () => NOW,
    api: async (method, url) => {
      w.calls.push(method + " " + url);
      if (method === "POST") { w.stops++; return null; }
      const v = typeof w.info === "function" ? w.info() : w.info;
      if (v instanceof Error) throw v;
      return v;
    },
    preview: async () => ({ src: "blob:page1", pages: 2 }),
    range: async () => "package main\n\nimport (\n\t\"fmt\"\n)\n\nfunc main() { fmt.Println(\"hi\") }\n",
    draft: (t) => w.drafts.push(t),
    copy: (t) => w.copies.push(t),
    every: (fn) => { w.every.push(fn); return () => { w.every = w.every.filter((x) => x !== fn); }; },
    observe: (node, fn) => w.loaders.push(fn),
    zoom: () => {},
    highlight: () => null,
  }, extra || {});
  return w;
}
const text = (n) => n.textContent.replace(/\s+/g, " ").trim();
const meta = (n) => text(n.querySelector(".fc-meta")).replace(/·/g, " · ").replace(/\s+/g, " ");
const has = (n, cls) => n.querySelectorAll(cls);

async function card(offer, info, extra) {
  const w = world(info, extra);
  const c = FC.create(w.ctx, offer);
  w.c = c;
  w.load = async () => { for (const f of w.loaders) await f(); };
  return w;
}

(async () => {
  // Helpers.
  assert.strictEqual(FC.fmtSize(18400000), "18.4 MB");
  assert.strictEqual(FC.fmtSize(212000), "212 KB");
  assert.strictEqual(FC.fmtSize(4100), "4.1 KB");
  assert.strictEqual(FC.fmtSize(3200000000), "3.2 GB");
  assert.strictEqual(FC.fmtSize(12), "12 B");
  assert.strictEqual(FC.fmtPair(1300000000, 3200000000), "1.3 of 3.2 GB");
  assert.strictEqual(FC.fmtPair(36000000, 2147483648), "36 MB of 2.1 GB");
  assert.strictEqual(FC.extOf("/home/alice/.env"), "env");
  assert.strictEqual(FC.extOf("Makefile"), "");
  assert.strictEqual(FC.fmtPair(0, 2147483648), "0 B of 2.1 GB");
  assert.strictEqual(FC.fmtRate(38e6), "38 MB/s");
  assert.strictEqual(FC.fmtLeft(50), "about 50 s left");
  assert.strictEqual(FC.ago(NOW - 30000, NOW), "just now");
  assert.strictEqual(FC.ago(NOW - 120000, NOW), "2 min ago");
  assert.strictEqual(FC.ago(NOW - 5 * 3600000, NOW), "5 h ago");

  // 1. Ready zip with a note: size, type, from machine, time, note, Download and Copy link.
  {
    const offer = { status: "offered", id: "f1", name: "alice-board-rev3.zip", path: "/home/alice/out/alice-board-rev3.zip", size: 18400000, mime: "application/zip",
      kind: "archive", type_label: "Zip archive", mtime: (NOW - 20000) / 1000, machine: "alice-laptop", machine_kind: "device", note: "Gerbers and drill files for rev 3." };
    const w = await card(offer, { state: "ready", ...offer, transfers: [] });
    const n = w.c.node;
    assert.ok(n.classList.contains("fc"));
    assert.strictEqual(text(n.querySelector(".fc-name")), "alice-board-rev3.zip");
    assert.strictEqual(meta(n), "18.4 MB · Zip archive · from alice-laptop · just now");
    assert.ok(n.querySelector(".fc-ico.k2"), "archive icon color");
    assert.strictEqual(text(n.querySelector(".fc-ico")), "zip");
    assert.ok(text(n.querySelector(".fc-note")).startsWith("Gerbers and drill files for rev 3."));
    assert.ok(text(n.querySelector(".fc-note small")).includes("the hub keeps no copy"));
    const dl = n.querySelector("a.dl");
    assert.strictEqual(text(dl), "Download");
    assert.strictEqual(dl.href, BASE + "/media?path=" + encodeURIComponent(offer.path) + "&download=1");
    assert.strictEqual(dl.download, "alice-board-rev3.zip");
    assert.ok(n.querySelector(".fc-copy"));
    assert.ok(!n.querySelector(".fc-prev"), "no preview for a zip");
    assert.strictEqual(w.calls.length, 0, "no info fetched before the card is in view");
    await w.load();
    assert.deepStrictEqual(w.calls, ["GET " + BASE + "/media/info?path=" + encodeURIComponent(offer.path)]);
    assert.strictEqual(w.c.state(), "ready");

    // Copy link: the URL and the tooltip that sign-in is needed.
    const b = n.querySelector(".fc-copy");
    assert.ok(/signed in/.test(b.title));
    b.dispatch("click");
    assert.deepStrictEqual(w.copies, ["https://hub.example.com/#/file/b%201/s9/" + encodeURIComponent(offer.path)]);
    assert.strictEqual(FC.linkURL("https://h", "claude", "s 1", "/a b/c.zip"), "https://h/#/file/claude/s%201/%2Fa%20b%2Fc.zip");
  }

  // 2. PDF with a preview and page count.
  {
    const offer = { status: "offered", name: "invoice-2026-11.pdf", path: "/tmp/invoice-2026-11.pdf", size: 212000, kind: "pdf", type_label: "PDF",
      mtime: (NOW - 120000) / 1000, machine: "the sandbox", machine_kind: "sandbox" };
    const w = await card(offer, { state: "ready", ...offer, transfers: [] });
    await w.load();
    const n = w.c.node;
    assert.strictEqual(meta(n), "212 KB · PDF, 2 pages · from the sandbox · 2 min ago");
    assert.ok(n.querySelector(".fc-ico.k2"));
    assert.strictEqual(text(n.querySelector(".fc-prev-bar")), "Page 1 of 2Open full size");
    assert.strictEqual(n.querySelector("img.pdf-page").src, "blob:page1");
  }

  // 3. Code with line numbers and Show more.
  {
    const offer = { status: "offered", name: "main.go", path: "/src/main.go", size: 4100, kind: "code", type_label: "Go source", lines: 168,
      mtime: (NOW - 300000) / 1000, machine: "alice-laptop", machine_kind: "device" };
    const long = Array.from({ length: 100 }, (_, i) => "line" + (i + 1)).join("\n") + "\n";
    const w = await card(offer, { state: "ready", ...offer, transfers: [] }, { range: async (url, r) => { w.range = r; return long; } });
    await w.load();
    const n = w.c.node;
    assert.strictEqual(w.range, "bytes=0-65535");
    assert.strictEqual(meta(n), "4.1 KB · Go source, 168 lines · from alice-laptop · 5 min ago");
    assert.ok(n.querySelector(".fc-ico.k3"));
    assert.strictEqual(text(n.querySelector(".fc-prev-bar")), "First 40 linesShow more");
    const gut = n.querySelector(".gut").textContent.split("\n");
    assert.strictEqual(gut.length, 40);
    assert.strictEqual(gut[0], "1");
    assert.ok(n.querySelector("code.body").textContent.startsWith("line1\nline2"));
    n.querySelector(".fc-prev-bar button").dispatch("click");
    assert.strictEqual(n.querySelector(".gut").textContent.split("\n").length, 100);
    assert.ok(/^100 lines|^First 100 lines/.test(text(n.querySelector(".fc-prev-bar"))));
    assert.ok(/Show less/.test(text(n.querySelector(".fc-prev-bar"))));
  }

  // 4. Image, audio, video previews; a file of binary data shows no code preview.
  {
    const o = { status: "offered", name: "plot.png", path: "/tmp/plot.png", size: 52000, kind: "image", type_label: "PNG image", machine: "alice-laptop", machine_kind: "device" };
    const w = await card(o, { state: "ready", ...o, transfers: [] });
    await w.load();
    const img = w.c.node.querySelector("img.fc-img");
    assert.strictEqual(img.src, BASE + "/media?path=" + encodeURIComponent("/tmp/plot.png"));
    assert.ok(w.c.node.querySelector(".fc-prev.image"));
    for (const [kind, tag, name] of [["audio", "audio", "memo.mp3"], ["video", "video", "demo.mp4"]]) {
      const x = { status: "offered", name, path: "/tmp/" + name, size: 9e6, kind, type_label: kind, machine: "bob-desktop", machine_kind: "device" };
      const v = await card(x, { state: "ready", ...x, transfers: [] });
      await v.load();
      const m = v.c.node.querySelector(tag + ".fc-media");
      assert.ok(m, kind + " element");
      assert.strictEqual(m.src, BASE + "/media?path=" + encodeURIComponent("/tmp/" + name));
      assert.strictEqual(m.getAttribute("controls"), "");
    }
    const bin = { status: "offered", name: "x.bin", path: "/tmp/x.bin", size: 99, kind: "text", type_label: "Text", machine: "alice-laptop", machine_kind: "device" };
    const v = await card(bin, { state: "ready", ...bin, transfers: [] }, { range: async () => "a\u0000b" });
    await v.load();
    assert.ok(!v.c.node.querySelector(".fc-prev"));
  }

  // 5. Transferring: progress, rate, time left, Stop; the poll ends when it is over.
  {
    const offer = { status: "offered", name: "bob-disk-image.tar.zst", path: "/img/bob-disk-image.tar.zst", size: 3200000000, kind: "archive", type_label: "Zstandard tar",
      mtime: (NOW - 60000) / 1000, machine: "bob-desktop", machine_kind: "device" };
    let transfers = [];
    const w = await card(offer, () => ({ state: "ready", ...offer, transfers }));
    await w.load();
    const n = w.c.node;
    const dl = n.querySelector("a.dl");
    assert.ok(dl);
    transfers = [{ sent: 1300000000, total: 3200000000, bytes_per_s: 38e6, started: NOW - 30000 }];
    dl.dispatch("click");
    assert.strictEqual(w.every.length, 1, "polling starts on a click");
    await w.every[0]();
    assert.strictEqual(w.c.state(), "transferring");
    assert.ok(!n.querySelector("a.dl"), "Download gives way to Stop");
    assert.ok(n.querySelector(".fc-stop"));
    assert.strictEqual(n.querySelector(".fill").style.width, "41%");
    assert.strictEqual(text(n.querySelector(".prog .l")), "1.3 of 3.2 GB38 MB/s · about 50 s left");
    assert.ok(/bob-desktop to hub to your browser/.test(text(n.querySelector(".hop"))));
    assert.ok(n.querySelectorAll(".hop i.on").length === 2);
    n.querySelector(".fc-stop").dispatch("click");
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(w.stops, 1);
    assert.ok(w.calls.includes("POST " + BASE + "/media/stop?path=" + encodeURIComponent(offer.path)));
    transfers = [];
    await w.every[0]();
    assert.strictEqual(w.c.state(), "ready");
    assert.strictEqual(w.every.length, 0, "polling stops when the transfer ends");
    assert.ok(n.querySelector("a.dl"));
  }

  // 6. Gone: offline and deleted, with the ask-again draft.
  {
    const offer = { status: "offered", name: "report-q3.csv", path: "/data/report-q3.csv", size: 86000, kind: "text", type_label: "CSV", machine: "alice-laptop", machine_kind: "device" };
    const w = await card(offer, { state: "offline", name: "report-q3.csv", size: 86000, machine: "alice-laptop", machine_kind: "device", transfers: [] });
    await w.load();
    const n = w.c.node;
    assert.ok(n.classList.contains("gone"));
    assert.strictEqual(meta(n), "Not available · was 86 KB · alice-laptop");
    assert.ok(text(n.querySelector(".fc-note.warn")).startsWith("alice-laptop is offline."));
    assert.ok(/hub keeps no copy/.test(text(n)));
    assert.ok(!n.querySelector("a.dl"));
    n.querySelector(".fc-again").dispatch("click");
    assert.deepStrictEqual(w.drafts, ["Please send report-q3.csv again."]);
    const g = await card(offer, { state: "gone", ...offer, transfers: [] });
    await g.load();
    assert.ok(/moved or deleted/.test(text(g.c.node.querySelector(".fc-note"))));
    const big = await card(offer, { state: "too_large", ...offer, transfers: [] });
    await big.load();
    assert.ok(/Too large/.test(meta(big.c.node)));
  }

  // 7. Refused secret, with the draft button; a refusal from a server chat names the server.
  {
    const offer = { status: "refused", name: "alice-prod.env", path: "/home/alice/alice-prod.env", machine: "alice-laptop", machine_kind: "device", reason: "looks like a secret", secret: true };
    const w = await card(offer, { state: "refused", ...offer, transfers: [] });
    await w.load();
    const n = w.c.node;
    assert.ok(n.classList.contains("refused"));
    assert.strictEqual(meta(n), "Not sent · looks like a secret");
    assert.ok(text(n.querySelector(".fc-note.bad")).startsWith("The hub did not read this file."));
    assert.ok(text(n.querySelector(".fc-note small")).includes("alice-laptop's credential rules"));
    assert.ok(text(n.querySelector(".fc-note small")).includes("Nothing left the computer."));
    assert.ok(!n.querySelector("a.dl") && !n.querySelector(".fc-copy"));
    assert.deepStrictEqual(w.calls, [], "a refused card needs no info call");
    const b = n.querySelector(".row button");
    assert.strictEqual(text(b), "Draft \"send it anyway\"");
    b.dispatch("click");
    assert.deepStrictEqual(w.drafts, ["Send alice-prod.env anyway."]);

    const s = await card({ status: "refused", name: "id_ed25519", path: "/root/.ssh/id_ed25519", machine: "", machine_kind: "server", reason: "private key", secret: true }, {});
    await s.load();
    assert.ok(/refused by the Hermes server's credential rules/.test(text(s.c.node)));
    assert.ok(/Nothing left the Hermes server\./.test(text(s.c.node)));
    assert.ok(/private key/.test(meta(s.c.node)));
  }

  // 8. Secret sent at the user's request: warning note, no preview.
  {
    const offer = { status: "offered", name: "alice-prod.env", path: "/home/alice/alice-prod.env", size: 1200, kind: "text", type_label: "Environment file", machine: "alice-laptop",
      machine_kind: "device", secret: true, requested: true };
    const w = await card(offer, { state: "ready", ...offer, transfers: [] });
    await w.load();
    const n = w.c.node;
    assert.strictEqual(meta(n), "1.2 KB · Environment file · from alice-laptop");
    assert.strictEqual(text(n.querySelector(".badge.warn")), "Sent at your request");
    assert.ok(/No preview is shown\./.test(text(n.querySelector(".fc-note.warn"))));
    assert.ok(!n.querySelector(".fc-prev"));
    assert.ok(n.querySelector("a.dl"));
    // A secret the route reports without a request stays refused even if the offer said ready.
    const x = { ...offer, requested: false };
    const v = await card(x, { state: "ready", ...x, transfers: [] });
    await v.load();
    assert.strictEqual(v.c.state(), "refused");
  }

  // 9. A Markdown link to any file: a card from the info alone.
  {
    const w = await card({ path: "/home/alice/notes.xyz", name: "notes.xyz", link: true },
      { state: "ready", name: "notes.xyz", size: 3000, kind: "other", type_label: "XYZ file", mtime: (NOW - 7200000) / 1000, machine: "alice-laptop", machine_kind: "device", transfers: [] });
    assert.strictEqual(text(w.c.node.querySelector(".fc-name")), "notes.xyz");
    await w.load();
    assert.strictEqual(meta(w.c.node), "3 KB · XYZ file · from alice-laptop · 2 h ago");
    assert.ok(w.c.node.querySelector("a.dl"));
    // The info call fails: the card stays usable.
    const f = await card({ path: "/x/y.bin", name: "y.bin" }, new Error("boom"));
    await f.load();
    assert.ok(f.c.node.querySelector("a.dl"));
  }

  // 10. Loads once.
  {
    const o = { status: "offered", name: "a.zip", path: "/a.zip", size: 1, kind: "archive" };
    const w = await card(o, { state: "ready", ...o, transfers: [] });
    await w.load(); await w.load();
    assert.strictEqual(w.calls.length, 1);
  }
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
