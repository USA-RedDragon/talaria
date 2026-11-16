"use strict";
// Cards of looking: screenshots, images and the page, scripts in a page.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, base, host, verb, errorText, rawOf, num, size } = H.util;

  // vision is vision_analyze and browser_vision: the card shows the image the
  // call looked at (d.vision) with the question as a plain line. A path the
  // hub may serve is a thumbnail, a data: URL is shown as it is, a web link
  // is a link and never loaded, and the rest is a placeholder. The generic
  // "Image loaded into your context" output is dropped; any other stays.
  const dataImage = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

  const imageExt = /\.(png|jpe?g|gif|webp)$/i;

  function imageFile(p) {
    return p.length > 1 && p.length < 4096 && p[0] === "/" && !/[\x00-\x1f\x7f]/.test(p) && imageExt.test(p) &&
      !p.slice(1).split("/").some((x) => x === "" || x === "." || x === "..");
  }

  function visionSource(a, res) {
    let u = str(a.image_url).trim();
    if (!u && Array.isArray(res.content)) {
      for (const part of res.content) {
        const v = isObj(part) ? (isObj(part.image_url) ? part.image_url.url : part.image_url) : "";
        if (typeof v === "string" && dataImage.test(v)) {
          u = v;
          break;
        }
      }
    }
    if (dataImage.test(u)) return { kind: "data", url: u };
    if (/^https?:\/\//i.test(u)) return { kind: "link", url: u };
    if (imageFile(u)) return { kind: "file", path: u };
    // browser_vision keeps the screenshot it looked at and names it in its result
    if (!u && typeof res.path === "string" && imageFile(res.path)) return { kind: "file", path: res.path };
    return { kind: "none", path: u[0] === "/" ? u : "" };
  }

  // hostPath is an address without its scheme, query and a lone slash.
  function hostPath(u) {
    return str(u).replace(/^[a-z]+:\/\//i, "").split(/[?#]/)[0].replace(/\/$/, "");
  }

  const hostOf = (u) => (str(u) ? host(str(u)) : "");

  // fail gives the status of a failed call: a refusal in warn color, else
  // the error. prefix goes before the error text.
  function fail(c, out, prefix) {
    if (!c.failed) return false;
    const code = isObj(c.res) ? str(c.res.code) : "";
    out.ownFailure = true;
    if (code === "declined") {
      out.tone = "warn";
      out.status = "Not allowed: you declined this";
    } else {
      out.status = (prefix || "") + (cut(squash(errorText(c.res) || str(c.error) || first(c.out)), 100) || "the call did not work");
    }
    return true;
  }

  // opaque is the call and result as JSON for the Raw toggle, only for a
  // failure whose only trace is the JSON.
  const opaque = (c) => (c.failed && !(errorText(c.res) || str(c.error)) ? rawOf(c) : "");

  // pageInfo is what a browser tool says about the page it looked at: the
  // result's own fields, plus the summary that browser_vision puts in the
  // text part of its multimodal result.
  function pageInfo(res) {
    const info = Object.assign({}, res);
    if (Array.isArray(res.content)) {
      for (const part of res.content) {
        if (!isObj(part) || part.type !== "text" || typeof part.text !== "string" || part.text[0] !== "{") continue;
        try {
          const j = JSON.parse(part.text);
          if (isObj(j)) Object.assign(info, j);
        } catch (_) { /* not the summary */ }
      }
    }
    return info;
  }

  // modelLine says whether a tool output is only the generic line meant for
  // the model, bare or as {"result": "..."}.
  function modelLine(t) {
    let x = str(t).trim();
    if (x[0] === "{") {
      try {
        const j = JSON.parse(x);
        if (isObj(j) && Object.keys(j).length === 1 && typeof j.result === "string") x = j.result.trim();
      } catch (_) { /* not JSON */ }
    }
    return /^Image loaded into your context/.test(x);
  }

  const keptShot = /\/cache\/screenshots\//;

  function vision(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const page = c.name === "browser_vision";
    const info = page ? pageInfo(res) : res;
    const out = { icon: "eye", blocks: [], lines: [], status: "Done" };
    const q = str(a.question).trim();
    const src = visionSource(a, page ? info : res);
    if (page) {
      const site = hostOf(info.url);
      out.title = c.failed ? "Could not look at the page" : verb(c, "Looked at", "Looking at") + " the page";
      if (site) out.chips = [site];
    } else {
      const named = src.kind === "file" ? base(src.path) : src.kind === "link" ? base(hostPath(src.url)) : "";
      out.title = c.failed ? "Could not look at the image" : verb(c, "Looked at", "Looking at") + " an image";
      if (named) out.chips = [named];
    }
    // The answer is what the model said about the image right after the
    // call (toolcard.js answers()); the question and image show with it.
    out.vision = Object.assign(src, { question: q, answer: str(c.answer).trim() });
    if (src.kind === "file" && keptShot.test(src.path)) out.vision.hidePath = true;
    // The page's own screenshot comes with the result: until then, or when
    // it did not, only the question shows.
    if (page && src.kind === "none") out.vision.kind = "nothing";
    if (!c.done) {
      if (page) {
        out.status = "Taking a screenshot";
        out.keepRunStatus = true;
      }
      return out;
    }
    if (fail(c, out, "Failed: ")) {
      out.raw = opaque(c);
      return out;
    }
    if (typeof info.screenshot === "string" && info.screenshot) {
      out.status = "Screenshot taken, but this model cannot see images in tool results";
      out.tone = "warn";
      out.ownFailure = true;
    }
    if (typeof info.screenshot_bytes === "number") out.more = [size(info.screenshot_bytes)];
    const rows = [];
    if (page) {
      if (str(info.title)) {
        out.lines.push({ parts: short(info.title), dim: true });
        rows.push({ k: "Page", v: short(info.title) });
      }
      if (str(info.url)) rows.push({ k: "Address", v: [{ code: str(info.url) }] });
    } else if (src.kind === "file") {
      const folder = src.path.replace(/\/[^/]*$/, "");
      if (folder) out.lines.push({ parts: folder, dim: true });
    }
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    const text = modelLine(c.out || "") ? "" : c.out || "";
    if (text && !text.includes("data:image/") && !page) out.blocks.push({ label: "Output", text, pre: true });
    return out;
  }

  // screenshot is browser_screenshot: the card shows the picture.
  function screenshot(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "camera", blocks: [], lines: [] };
    if (!c.done) {
      out.title = "Taking a screenshot";
      return out;
    }
    if (c.failed) {
      out.title = "Could not take a screenshot";
      fail(c, out, "Failed: ");
      out.raw = opaque(c);
      return out;
    }
    out.title = "Took a screenshot of " + (str(res.title) ? short(res.title) : "the page");
    out.status = "Done";
    out.more = [{ chip: a.full_page === true ? "Whole page" : "Visible part" }];
    const where = hostPath(res.url);
    if (where) out.lines.push({ parts: where, mono: true });
    if (typeof res.path === "string" && res.path) out.vision = { kind: imageFile(res.path) ? "file" : "none", path: res.path, question: "", answer: "", hidePath: true };
    const rows = [];
    if (str(res.title)) rows.push({ k: "Page title", v: short(res.title) });
    if (str(res.url)) rows.push({ k: "Address", v: [{ code: str(res.url) }] });
    rows.push({ k: "Captured", v: a.full_page === true ? "Whole page" : "Visible part" });
    out.blocks.push({ kind: "kv", rows });
    return out;
  }

  // snapshot is browser_snapshot: the page read as an outline or as text.
  function snapshot(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const mode = str(a.mode).toLowerCase() || (a.text_only ? "text" : a.full_text ? "both" : a.interactive_only ? "interactive" : "outline");
    const out = { icon: "eye", blocks: [], lines: [] };
    const waitText = str(a.wait_for) ? "\u201c" + short(a.wait_for) + "\u201d" : "";
    const waitSel = str(a.wait_selector);
    if (!c.done) {
      out.title = "Reading the page";
      if (waitText || waitSel) out.lines.push({ parts: waitText ? ["Waiting for " + waitText] : ["Waiting for ", { code: waitSel }], dim: true });
      out.status = "Running";
      out.keepRunStatus = true;
      return out;
    }
    const where = hostPath(res.url);
    out.title = where ? ["Read the page ", { code: where }] : "Read the page";
    if (c.failed) {
      const e = cut(squash(errorText(res) || str(c.error) || first(c.out)), 120);
      out.title = "Read the page";
      out.status = "Failed";
      out.ownFailure = true;
      if (e) out.lines.push(e);
      out.raw = opaque(c);
      return out;
    }
    out.status = "Done";
    const count = Number.isFinite(res.element_count) ? res.element_count : null;
    const what = mode === "text" ? "page text" : mode === "both" ? (count !== null ? plural(count, "element") + " and page text" : "outline and text") : mode === "interactive" ? (count !== null ? plural(count, "interactive element") : "interactive elements") : count !== null ? plural(count, "element") : "outline";
    const parts = [];
    if (str(res.title)) parts.push(short(res.title));
    parts.push(what);
    const first1 = [parts.join(" · ")];
    if (str(a.selector)) first1.push(" · limited to ", { code: short(a.selector) });
    else if (str(a.ref)) first1.push(" · limited to one element");
    out.lines.push(first1);
    const offset = Number(a.offset) || 0;
    const total = typeof res.total_chars === "number" ? res.total_chars : typeof res.text_total_chars === "number" ? res.text_total_chars : 0;
    const next = typeof res.next_offset === "number" ? res.next_offset : typeof res.text_next_offset === "number" ? res.text_next_offset : 0;
    const part = str(res.snapshot) || str(res.text);
    if (res.truncated === true || res.text_truncated === true) {
      if (offset > 0) out.lines.push({ parts: "Read on from character " + num(offset) + (next && total ? ", " + num(next) + " of " + num(total) + " characters" : ""), dim: true });
      else if (next && total && part.length) out.lines.push({ parts: "Part 1 of about " + Math.ceil(total / part.length) + ", " + num(next) + " of " + num(total) + " characters", dim: true });
    } else if (offset > 0) {
      out.lines.push({ parts: "Read on from character " + num(offset), dim: true });
    }
    if (res.waited !== undefined && res.waited !== null && res.waited !== false && (waitText || waitSel)) out.lines.push({ parts: waitText ? ["Waited for " + waitText] : ["Waited for ", { code: waitSel }], dim: true });
    if (str(res.snapshot)) out.blocks.push({ label: "What the page showed", text: str(res.snapshot), pre: true });
    if (str(res.text)) out.blocks.push({ label: mode === "text" ? "What the page showed" : "Page text", text: str(res.text), pre: true });
    if (!out.blocks.length && count === 0) out.lines.push({ parts: "No elements found", dim: true });
    return out;
  }

  // The script of a browser_eval call, and where it came from.
  function scriptOf(a) {
    const ref = isObj(a.script_ref) ? a.script_ref : null;
    if (ref) return { text: "", where: str(ref.file) + (str(ref.skill) ? " of " + str(ref.skill) : "") };
    return { text: str(a.script), where: "" };
  }

  const evalBlocked = /\bblocked\b|not allowed|saved password|autologin|sign-in list|confirm/i;
  const evalTimeout = /did not finish|timed out|timeout/i;

  // evalCard is browser_eval: a script run in the page.
  function evalCard(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const site = hostOf(res.url);
    const on = site ? " on " + site : "";
    const writes = a.allow_writes === true;
    const sc = scriptOf(a);
    const out = { icon: "globe", blocks: [], lines: [] };
    const script = sc.text.trim();
    const lead = sc.where ? [sc.where] : script ? [{ code: cut(squash(script.split("\n")[0]), 90) }] : [];
    const chip = res.read_only === true || (c.done && !c.failed && !writes && res.read_only !== false) ? [" ", { chip: "read-only" }] : [];
    if (!c.done) {
      out.title = "Running a script" + (writes ? " that can change data" : "") + on;
      if (lead.length) out.lines.push([...lead, ...(!writes ? [" ", { chip: "read-only" }] : [])]);
      if (str(a.wait_selector) || str(a.wait_for)) out.lines.push({ parts: "Waiting for the page", dim: true });
      return out;
    }
    const err = errorText(res) || str(c.error) || (c.failed ? first(c.out) : "");
    if (c.failed) {
      const declined = str(res.code) === "declined";
      const blocked = !declined && evalBlocked.test(err);
      out.title = (blocked ? "Script blocked" : "Script failed") + on;
      if (lead.length) out.lines.push(lead);
      out.ownFailure = true;
      if (declined) {
        out.tone = "warn";
        out.status = "You said no";
      } else if (blocked) out.status = "Blocked: " + cut(squash(err.replace(/^blocked:\s*/i, "")), 100);
      else if (evalTimeout.test(err)) out.status = "The script did not finish";
      else out.status = "Script error: " + (cut(squash(err), 100) || "the script did not run");
      if (script) out.blocks.push({ label: "Script", text: script, kind: "command" });
      out.raw = opaque(c);
      return out;
    }
    out.title = "Ran a script" + (writes ? " that can change data" : "") + on;
    if (lead.length) out.lines.push([...lead, ...chip]);
    else if (chip.length) out.lines.push(chip.slice(1));
    const text = typeof res.result_text === "string" ? res.result_text : res.result === undefined || res.result === null ? "" : typeof res.result === "string" ? res.result : JSON.stringify(res.result);
    const n = typeof res.result_chars === "number" ? res.result_chars : text.length;
    if (res.truncated === true) {
      out.status = "Cut off at " + num(text.length) + " of " + num(n) + " characters";
      out.tone = "warn";
      out.ownFailure = true;
    } else out.status = "Done";
    if (!text) out.lines.push({ parts: "Returned nothing", dim: true });
    else out.lines.push({ parts: "Returned " + (text.length > 80 ? size(n) + ": " + cut(squash(text), 80) : squash(text)), dim: true });
    if (script) out.blocks.push({ label: "Script", text: script, kind: "command" });
    else if (sc.where) out.blocks.push({ label: "Script", plain: true, text: sc.where + (isObj(a.args) ? "\nwith " + JSON.stringify(a.args) : "") });
    const rows = [];
    if (str(res.title)) rows.push({ k: "Title", v: short(res.title) });
    if (str(res.url)) rows.push({ k: "Address", v: [{ code: str(res.url) }] });
    if (str(res.frame) || str(a.frame)) rows.push({ k: "Frame", v: str(res.frame) || str(a.frame) });
    const waited = str(a.wait_selector) ? [{ code: str(a.wait_selector) }] : str(a.wait_for) ? ["\u201c" + short(a.wait_for) + "\u201d"] : null;
    if (waited && res.waited !== undefined) rows.push({ k: "Waited for", v: waited });
    if (rows.length) out.blocks.push({ label: "Page", kind: "kv", rows });
    if (text) {
      let shown = text;
      try {
        const j = JSON.parse(text);
        if (j !== null && typeof j === "object") shown = JSON.stringify(j, null, 2);
      } catch (_) { /* a plain value */ }
      out.blocks.push({ label: "Result", text: shown, pre: true });
    }
    if (str(res.hint)) out.blocks.push({ plain: true, text: str(res.hint) });
    return out;
  }

  H.register({ vision_analyze: vision, browser_vision: vision, browser_screenshot: screenshot, browser_snapshot: snapshot, browser_eval: evalCard });
})();
