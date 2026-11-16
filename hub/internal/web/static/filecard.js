"use strict";
// HubFileCard draws the card of a file the agent offers the user: from a
// send_file result, or from a Markdown link to a file in a reply. create(ctx,
// offer) returns { node, load, poll, state, refresh }. The pure helpers
// (sizes, times, the copy link) are exported for the node test.
//
// ctx: { el, base, backend, session, origin, api(method, url) -> Promise of
// JSON, preview(url) -> Promise of { src, pages } or null, range(url, range)
// -> Promise of text, draft(text), copy(text), every(fn, ms) -> stop(),
// observe(node, fn), zoom(src, name), open(url), highlight(text, ext) ->
// HTML or null, now() }. The hub keeps no copy of any file: every byte shown
// here is streamed from the media routes of the chat.
window.HubFileCard = (() => {
  const SEP = " \u00B7 ";
  const PREVIEW_BYTES = 65536;
  const FIRST_LINES = 40;
  const MORE_LINES = 400;

  const baseName = (p) => String(p || "").replace(/\/+$/, "").split("/").pop() || String(p || "");
  // A dot file such as .env counts its name as the extension.
  const extOf = (n) => { const b = baseName(n); const i = b.lastIndexOf("."); return i >= 0 && i < b.length - 1 ? b.slice(i + 1).toLowerCase() : ""; };

  // fmtSize writes a byte count in SI units: 212 KB, 4.1 KB, 18.4 MB, 3.2 GB.
  function fmtSize(n) {
    if (typeof n !== "number" || !(n >= 0)) return "";
    if (n < 1000) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1000;
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    const text = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
    return text + " " + units[i];
  }

  // fmtPair writes "1.3 of 3.2 GB": both in the unit of the total, or
  // "36 MB of 2.1 GB" while the sent part is under a tenth of that unit.
  function fmtPair(sent, total) {
    const t = fmtSize(total);
    const unit = t.split(" ")[1] || "B";
    const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[unit];
    const v = sent / scale;
    if (unit !== "B" && v < 0.1) return fmtSize(sent) + " of " + t;
    const s = unit === "B" ? String(Math.round(v)) : v.toFixed(1);
    return s + " of " + t;
  }

  function fmtRate(bps) {
    if (!(bps > 0)) return "";
    const s = fmtSize(Math.round(bps));
    const [v, u] = s.split(" ");
    return (u === "B" || parseFloat(v) >= 10 ? String(Math.round(parseFloat(v))) : v) + " " + u + "/s";
  }

  function fmtLeft(secs) {
    if (!isFinite(secs) || secs < 0) return "";
    if (secs < 2) return "almost done";
    if (secs < 60) return "about " + Math.round(secs) + " s left";
    if (secs < 3600) return "about " + Math.round(secs / 60) + " min left";
    return "about " + Math.round(secs / 3600) + " h left";
  }

  // ms turns an mtime (Unix seconds, milliseconds or an ISO time) to ms.
  function ms(t) {
    if (typeof t === "string") { const v = Date.parse(t); return v || 0; }
    if (typeof t !== "number" || !(t > 0)) return 0;
    return t > 1e11 ? t : t * 1000;
  }

  function ago(at, now) {
    if (!at || at < 978307200000) return "";
    const s = Math.max(0, (now - at) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    const d = Math.floor(s / 86400);
    return d === 1 ? "1 day ago" : d + " days ago";
  }

  // linkURL is what Copy link copies: it opens this card after sign-in.
  const linkURL = (origin, backend, session, path) =>
    origin + "/#/file/" + encodeURIComponent(backend) + "/" + encodeURIComponent(session) + "/" + encodeURIComponent(path);

  const cap = (s) => (/^the /.test(s) ? s[0].toUpperCase() + s.slice(1) : s);

  // whose is the machine in a sentence: a computer by its name, else the
  // sandbox or the Hermes server.
  const own = (d) => (d.machine ? d.machine + "'s" : d.machine_kind === "server" ? "the Hermes server's" : "the computer's");
  const where = (d) => d.machine || (d.machine_kind === "server" ? "the Hermes server" : d.machine_kind === "sandbox" ? "the sandbox" : "the computer");

  // iconClass picks the color of the file icon.
  function iconClass(d) {
    const k = d.kind || "";
    if (k === "archive" || k === "pdf") return "k2";
    if (k === "code") return "k3";
    if (k === "image" || k === "audio" || k === "video") return "k4";
    return "k1";
  }

  function create(ctx, offer) {
    const { el } = ctx;
    const icons = window.HubIcons;
    const now = () => (ctx.now ? ctx.now() : Date.now());
    const d = Object.assign({}, offer);
    d.name = d.name || baseName(d.path);
    const at = offer.at || 0;
    const qp = () => "?path=" + encodeURIComponent(d.path);
    const inlineURL = () => ctx.base + "/media" + qp();
    const downURL = () => inlineURL() + "&download=1";

    // state: ready | transferring | gone | refused | toolarge
    let state = offer.status === "refused" ? "refused" : offer.status === "gone" ? "gone" : "ready";
    let loaded = false;
    let transfers = [];
    let sawTransfer = false;
    let stopPoll = null;
    let ticks = 0;
    let gone = "";
    let pages = 0;
    const prev = { box: null, kind: "", lines: null, expanded: false, text: null, truncated: false };
    const node = el("div", "fc filecard");
    node.dataset.path = d.path || "";

    const secretShown = () => d.secret && !d.requested;

    function icon(cls) {
      const e = el("span", "fc-ico " + cls, extOf(d.name) || "file");
      return e;
    }

    function copyButton() {
      const b = el("button", "ghost ib fc-copy");
      b.type = "button";
      b.title = "Copy link (you must be signed in to open it)";
      b.setAttribute("aria-label", "Copy link");
      b.append(icons.icon("link"));
      b.addEventListener("click", () => {
        ctx.copy(linkURL(ctx.origin, ctx.backend, ctx.session, d.path));
        b.title = "Link copied";
        b.classList.add("done");
      });
      return b;
    }

    function dlLink() {
      const a = el("a", "primary dl");
      a.append(icons.icon("download"), "Download");
      a.href = downURL();
      a.download = d.name;
      a.rel = "noopener";
      a.setAttribute("role", "button");
      a.addEventListener("click", () => startPoll());
      return a;
    }

    function stopButton() {
      const b = el("button", "ghost ib fc-stop");
      b.type = "button";
      b.title = "Stop";
      b.setAttribute("aria-label", "Stop");
      b.append(icons.icon("close"));
      b.addEventListener("click", async () => {
        b.disabled = true;
        try { await ctx.api("POST", ctx.base + "/media/stop" + qp()); } catch (_) { /* the poll shows what is left */ }
        poll();
      });
      return b;
    }

    function badge(cls, text) { return el("span", "badge " + cls, text); }

    function metaLine(parts) {
      const m = el("div", "fc-meta");
      parts.forEach((p, i) => {
        if (i) m.append(el("span", "sep", "\u00B7"));
        m.append(p);
      });
      return m;
    }

    function typeText() {
      let t = d.type_label || "";
      if (pages) t = (t || "PDF") + ", " + pages + (pages === 1 ? " page" : " pages");
      else if (d.lines) t = (t || "Text") + ", " + d.lines + (d.lines === 1 ? " line" : " lines");
      return t;
    }

    function header(cls, parts, act, name) {
      const top = el("div", "fc-top");
      const nm = el("div", "fc-name", name || d.name);
      nm.title = d.name;
      top.append(icon(cls), nm, metaLine(parts));
      const a = el("div", "fc-act");
      a.append(...act);
      top.append(a);
      return top;
    }

    function readyMeta() {
      const parts = [];
      if (typeof d.size === "number") parts.push(fmtSize(d.size));
      const tt = typeText();
      if (tt) parts.push(tt);
      const from = d.machine || (d.machine_kind === "server" ? "the Hermes server" : d.machine_kind === "sandbox" ? "the sandbox" : "");
      if (from) parts.push("from " + from);
      const t = ago(ms(d.mtime) || at, now());
      if (t) parts.push(t);
      return parts;
    }

    function note(cls, children) {
      const n = el("div", "fc-note" + (cls ? " " + cls : ""));
      n.append(...children);
      return n;
    }

    function render() {
      node.className = "fc filecard";
      node.dataset.state = state;
      const kids = [];
      if (state === "refused") {
        node.classList.add("refused");
        const reason = d.reason || "looks like a secret";
        kids.push(header("bad", [badge("bad", "Not sent"), reason], []));
        const small = el("small", "", "It was refused by " + own(d) + " credential rules (same list as file tools). Nothing left " + (d.machine_kind === "device" || !d.machine_kind ? "the computer" : where(d)) +
          ". If you want it anyway, tell the agent in the chat, for example \"send " + d.name + " anyway\", and the card then shows that you allowed it.");
        const row = el("div", "row");
        const b = el("button", "", "Draft \"send it anyway\"");
        b.type = "button";
        b.addEventListener("click", () => ctx.draft("Send " + d.name + " anyway."));
        row.append(b);
        kids.push(note("bad", ["The hub did not read this file. Names like .env, keys, tokens and credential folders are never sent unless you ask for that file in the chat.", small, row]));
      } else if (state === "gone" || state === "toolarge") {
        node.classList.add("gone");
        const parts = [badge("warn", state === "toolarge" ? "Too large" : "Not available")];
        if (typeof d.size === "number") parts.push((state === "toolarge" ? "" : "was ") + fmtSize(d.size));
        if (d.machine) parts.push(d.machine);
        const act = [];
        if (state === "gone") {
          const b = el("button", "ghost ib fc-again");
          b.type = "button";
          b.title = "Ask the agent to send it again";
          b.setAttribute("aria-label", "Ask again");
          b.append(icons.icon("retry"));
          b.addEventListener("click", () => ctx.draft("Please send " + d.name + " again."));
          act.push(b);
        }
        kids.push(header("off", parts, act));
        if (state === "toolarge") {
          kids.push(note("warn", ["This file is larger than the hub is set to pass on.", el("small", "", "Ask the agent to split it, or fetch it from " + where(d) + " directly.")]));
        } else if (gone === "offline") {
          kids.push(note("warn", [cap(where(d)) + " is offline.", el("small", "", "The hub keeps no copy. Open this card again when the computer is back, or ask the agent to send it again.")]));
        } else if (gone === "gone") {
          kids.push(note("warn", ["The file was moved or deleted on " + where(d) + ".", el("small", "", "The hub keeps no copy. Ask the agent to send it again.")]));
        } else {
          kids.push(note("warn", [cap(where(d)) + " is offline, or the file was moved or deleted.", el("small", "", "The hub keeps no copy. Open this card again when the computer is back, or ask the agent to send it again.")]));
        }
      } else {
        const transferring = state === "transferring";
        const act = transferring ? [stopButton(), copyButton()] : [copyButton(), dlLink()];
        kids.push(header(iconClass(d), readyMeta(), act));
        if (d.requested && d.secret) {
          kids.push(note("warn", [badge("warn", "Sent at your request"), " You asked for this file in the chat, so the secret rules were skipped. No preview is shown."]));
        } else if (d.note) {
          kids.push(note("", [d.note, el("small", "", "Streamed from " + where(d) + " when you download; the hub keeps no copy.")]));
        }
        if (transferring) kids.push(progress());
        else if (prev.box && !secretShown()) kids.push(prev.box);
      }
      node.replaceChildren(...kids);
    }

    function progress() {
      const t = transfers.slice().sort((a, b) => (b.sent || 0) - (a.sent || 0))[0] || { sent: 0, total: d.size || 0, bytes_per_s: 0 };
      const total = t.total || d.size || 0;
      const sent = Math.min(t.sent || 0, total);
      const pct = total ? Math.round((sent / total) * 100) : 0;
      const box = el("div", "prog");
      const track = el("div", "track");
      const fill = el("div", "fill");
      fill.style.width = pct + "%";
      fill.setAttribute("role", "progressbar");
      fill.setAttribute("aria-valuenow", String(pct));
      track.append(fill);
      const l = el("div", "l");
      const rate = fmtRate(t.bytes_per_s);
      const left = t.bytes_per_s > 0 ? fmtLeft((total - sent) / t.bytes_per_s) : "";
      l.append(el("span", "", total ? fmtPair(sent, total) : fmtSize(sent)), el("span", "", [rate, left].filter(Boolean).join(" \u00B7 ")));
      const hop = el("div", "hop");
      const chip = (txt, on) => el("i", on ? "on" : "", txt);
      hop.append(chip(d.machine || "source", true), " to ", chip("hub", true), " to ", chip("your browser", false),
        el("span", "", "Your browser saves it with its own downloads. If it drops, resume continues from the same byte."));
      box.append(track, l, hop);
      return box;
    }

    // ---- previews ----

    function previewBox(kind) {
      const box = el("div", "fc-prev " + kind);
      prev.box = box;
      prev.kind = kind;
      return box;
    }

    function bar(label, extra) {
      const b = el("div", "fc-prev-bar");
      b.append(el("span", "lbl", label), el("span", "grow"));
      if (extra) b.append(extra);
      return b;
    }

    function showImage() {
      const box = previewBox("image");
      const img = el("img", "fc-img");
      img.alt = d.name;
      img.loading = "lazy";
      img.src = inlineURL();
      img.addEventListener("error", () => { box.remove(); prev.box = null; });
      if (ctx.zoom) img.addEventListener("click", () => ctx.zoom(inlineURL(), d.name));
      box.append(img);
    }

    async function showPdf() {
      let r = null;
      try { r = await ctx.preview(ctx.base + "/media/preview" + qp()); } catch (_) { r = null; }
      if (!r || !r.src) return false;
      const box = previewBox("pdf");
      pages = r.pages || 0;
      const open = el("button", "ghost", "Open full size");
      open.type = "button";
      open.addEventListener("click", () => (ctx.open ? ctx.open(inlineURL()) : null));
      const wrap = el("div", "pdf");
      const img = el("img", "pdf-page");
      img.alt = "Page 1 of " + (d.name);
      img.src = r.src;
      wrap.append(img);
      box.append(bar(pages ? "Page 1 of " + pages : "Page 1", open), wrap);
      return true;
    }

    function codeBlock(text, expanded) {
      const all = text.split("\n");
      if (all.length && all[all.length - 1] === "") all.pop();
      const cap2 = expanded ? MORE_LINES : FIRST_LINES;
      const shown = all.slice(0, cap2);
      const pre = el("pre", "code");
      const gut = el("span", "gut", shown.map((_, i) => String(i + 1)).join("\n"));
      gut.setAttribute("aria-hidden", "true");
      const code = el("code", "body");
      const html = ctx.highlight ? ctx.highlight(shown.join("\n"), extOf(d.name)) : null;
      if (html) code.innerHTML = html; else code.textContent = shown.join("\n");
      pre.append(gut, code);
      return { pre, shown: shown.length, total: all.length, more: all.length > cap2 };
    }

    function drawCode() {
      const box = prev.box;
      const b = codeBlock(prev.text, prev.expanded);
      const hidden = b.more || prev.truncated;
      let label;
      if (prev.expanded) label = b.more || prev.truncated ? "First " + b.shown + " lines" : (b.total === 1 ? "1 line" : b.total + " lines");
      else label = hidden ? "First " + b.shown + " lines" : (b.total === 1 ? "1 line" : b.total + " lines");
      let btn = null;
      if (b.more || prev.expanded) {
        btn = el("button", "ghost", prev.expanded ? "Show less" : "Show more");
        btn.type = "button";
        btn.addEventListener("click", () => { prev.expanded = !prev.expanded; drawCode(); });
      }
      box.replaceChildren(bar(label, btn), b.pre);
    }

    async function showText() {
      let text = "";
      try { text = await ctx.range(inlineURL(), "bytes=0-" + (PREVIEW_BYTES - 1)); } catch (_) { return false; }
      if (typeof text !== "string" || !text || text.indexOf("\u0000") >= 0) return false;
      prev.text = text;
      prev.truncated = typeof d.size === "number" && d.size > PREVIEW_BYTES;
      previewBox("code");
      drawCode();
      return true;
    }

    function showMedia(tag) {
      const box = previewBox(tag);
      const m = el(tag, "fc-media");
      m.controls = true;
      m.preload = "metadata";
      m.src = inlineURL();
      m.setAttribute("controls", "");
      box.append(m);
    }

    async function startPreview() {
      if (prev.box || secretShown() || (d.secret && d.requested)) return;
      const k = d.kind;
      let ok = true;
      if (k === "image") showImage();
      else if (k === "pdf") ok = await showPdf();
      else if (k === "audio") showMedia("audio");
      else if (k === "video") showMedia("video");
      else if (k === "text" || k === "code") ok = await showText();
      else ok = false;
      if (ok !== false && state === "ready") render();
    }

    // ---- info and transfers ----

    function merge(info) {
      for (const k of ["name", "size", "mime", "kind", "type_label", "mtime", "machine", "machine_kind", "secret", "requested", "lines"]) {
        if (info[k] !== undefined && info[k] !== null && info[k] !== "") d[k] = info[k];
      }
      if (info.reason) d.reason = info.reason;
    }

    function apply(info) {
      merge(info);
      transfers = Array.isArray(info.transfers) ? info.transfers : [];
      gone = "";
      if (info.state === "offline" || info.state === "gone") { state = "gone"; gone = info.state; }
      else if (info.state === "too_large") state = "toolarge";
      else if (info.state === "refused") state = "refused";
      else if (transfers.length) state = "transferring";
      else if (state !== "refused" || info.state === "ready") state = "ready";
      if (info.state === "ready" && d.secret && !d.requested) state = "refused";
    }

    async function fetchInfo() {
      return ctx.api("GET", ctx.base + "/media/info" + qp());
    }

    // load fetches the card's info once, when it first scrolls into view,
    // then starts its preview.
    async function load() {
      if (loaded) return;
      loaded = true;
      if (offer.status === "refused") { render(); return; }
      try {
        apply(await fetchInfo());
      } catch (_) {
        // Keep the card as the agent offered it.
      }
      render();
      if (state === "ready") await startPreview();
      else if (state === "transferring") startPoll();
    }

    // poll is one step of the progress loop: it reads the info and shows a
    // transfer while one runs.
    async function poll() {
      ticks++;
      let info;
      try { info = await fetchInfo(); } catch (_) { return; }
      const was = state;
      apply(info);
      if (transfers.length) sawTransfer = true;
      if (state !== "transferring" && (sawTransfer || ticks >= 4 || state !== "ready")) stopLoop();
      if (state !== was || state === "transferring") render();
      if (state === "ready" && was === "transferring" && !prev.box) startPreview();
    }

    function stopLoop() {
      if (stopPoll) { stopPoll(); stopPoll = null; }
    }

    function startPoll() {
      stopLoop();
      ticks = 0;
      sawTransfer = false;
      if (ctx.every) stopPoll = ctx.every(poll, 1000);
    }

    render();
    if (ctx.observe) ctx.observe(node, load);
    return { node, load, poll, startPoll, data: d, state: () => state, destroy: stopLoop };
  }

  return { create, fmtSize, fmtPair, fmtRate, fmtLeft, ago, ms, linkURL, extOf, baseName, SEP };
})();
