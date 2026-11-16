"use strict";
// Cards of files: read, write, edit, search, send, publish a page.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, short, plural, base, dir, lines, stripAnsi, verb, errorText, upperFirst, num, size, rawOf } = H.util;

  const args = (c) => (isObj(c.args) ? c.args : {});
  const result = (c) => (isObj(c.res) ? c.res : {});
  const pathOf = (a) => str(a.path) || str(a.file_path);
  const names = (list) => list.map((x) => (isObj(x) ? str(x.path || x.file || x.name) : str(x))).filter(Boolean);
  const bytesOf = (s) => {
    let n = 0;
    for (const ch of s) {
      const p = ch.codePointAt(0);
      n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4;
    }
    return n;
  };
  const noPath = (r) => /not found|no such|does not exist|cannot find|missing/i.test(r);
  // tail is the last two folders of a path's folder, with its slash.
  function tail(path) {
    const d = dir(path);
    if (!d) return "";
    const segs = d.split("/").filter(Boolean);
    if (segs.length <= 2) return d.startsWith("/") && segs.length < 2 && d !== "/" ? d : segs.join("/") + "/";
    return segs.slice(-2).join("/") + "/";
  }
  const folder = (path, slash) => {
    const d = dir(path);
    return slash ? d : d.length > 1 ? d.replace(/\/+$/, "") : d;
  };

  // ---- read_file ----
  function read(c) {
    const a = args(c);
    const res = result(c);
    const out = { icon: "file", blocks: [] };
    const path = pathOf(a);
    const name = base(path) || "a file";
    const f = folder(path, true);
    out.title = [c.failed ? "Could not read " : verb(c, "Read ", "Reading "), { code: name }];
    if (f) out.sub = { parts: f, dim: true, mono: true };
    const text = typeof res.content === "string" ? res.content : c.out;
    const body = text.replace(/\n+$/, "");
    const nums = body.split("\n").map((l) => /^\s*(\d+)\|/.exec(l)).filter(Boolean).map((m) => +m[1]);
    const offset = typeof a.offset === "number" && a.offset > 0 ? a.offset : 1;
    const shown = body ? (nums.length ? nums.length : lines(body)) : 0;
    const start = nums.length ? nums[0] : offset;
    const end = nums.length ? nums[nums.length - 1] : start + shown - 1;
    const total = typeof res.total_lines === "number" ? res.total_lines : 0;
    if (!c.done) {
      if (typeof a.offset === "number" && typeof a.limit === "number" && a.limit > 0) {
        out.status = "Lines " + num(a.offset) + " to " + num(a.offset + a.limit - 1);
        out.keepRunStatus = true;
      }
      return out;
    }
    if (c.failed) {
      const e = errorText(res) || str(c.error);
      if (res.not_found || noPath(e || c.out)) out.status = "File not found";
      else if (/secret|refus|not allowed|blocked|protected/i.test(e)) out.status = "Refused: secret file";
      else if (e) out.status = cut(e.replace(/\s+/g, " "), 80);
      if (out.status) out.ownFailure = true;
      if (Array.isArray(res.similar_files) && res.similar_files.length) {
        out.blocks.push({ label: "Similar files", kind: "list", items: names(res.similar_files).map((p) => ({ parts: [p], mono: true })) });
      }
      return out;
    }
    const sz = size(res.file_size);
    const tailParts = [];
    if (res.is_image || res.is_binary) {
      out.status = (res.is_image ? "Image" : "Binary file") + (sz ? ", " + sz : "") + ", not shown";
      out.tone = "warn";
      return out;
    }
    if (!body) {
      out.status = "Empty file";
    } else if (start === 1 && total && end >= total) {
      out.status = "All " + num(total) + " " + (total === 1 ? "line" : "lines");
    } else {
      out.status = "Lines " + num(start) + " to " + num(end) + (total ? " of " + num(total) : "");
    }
    if (sz) tailParts.push(sz);
    if (body && (res.truncated === true || (total && end < total))) tailParts.push("more below");
    if (tailParts.length) out.more = tailParts.join(" · ");
    if (body) out.blocks.push({ label: "File text", text: body, kind: "pre" });
    return out;
  }

  // ---- write_file and patch ----
  function counts(diff) {
    let add = 0;
    let del = 0;
    let hunks = 0;
    for (const l of stripAnsi(diff).split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) add++;
      else if (l.startsWith("-") && !l.startsWith("---")) del++;
      else if (l.startsWith("@@")) hunks++;
    }
    return { add, del, hunks };
  }

  // fileDiff builds a unified diff of one replacement from the call.
  function attempt(path, a) {
    const old = str(a.old_string).replace(/\n$/, "");
    const neu = str(a.new_string).replace(/\n$/, "");
    return ["--- " + path, "+++ " + path].concat(old ? old.split("\n").map((l) => "-" + l) : [], neu ? neu.split("\n").map((l) => "+" + l) : []).join("\n");
  }

  // splitDiff cuts a diff with several file headers into { path, text }.
  function splitDiff(diff) {
    const ls = stripAnsi(diff).split("\n");
    const parts = [];
    let cur = null;
    ls.forEach((l, i) => {
      if (l.startsWith("--- ") && (ls[i + 1] || "").startsWith("+++ ")) {
        cur = { path: "", lines: [] };
        parts.push(cur);
      }
      if (!cur) {
        cur = { path: "", lines: [] };
        parts.push(cur);
      }
      if (l.startsWith("+++ ") && !cur.path) cur.path = l.slice(4).trim().replace(/^[ab]\//, "").replace(/\t.*$/, "");
      cur.lines.push(l);
    });
    return parts.map((p) => ({ path: p.path, text: p.lines.join("\n").replace(/\n+$/, "") })).filter((p) => p.text);
  }

  function write(c) {
    const a = args(c);
    const res = result(c);
    const out = { icon: "filenew", blocks: [] };
    const path = pathOf(a);
    out.title = [c.failed ? "Could not write " : verb(c, "Wrote ", "Writing "), { code: base(path) || "a file" }];
    const f = folder(path, false);
    if (f) out.sub = { parts: f, dim: true, mono: true };
    const content = str(a.content);
    const n = lines(content);
    if (!c.done) {
      if (typeof a.content === "string" && n) out.status = "Writing " + plural(n, "line");
      out.keepRunStatus = !!out.status;
      return out;
    }
    if (c.failed) return out;
    const diff = c.diff || str(res.diff);
    const bytes = typeof res.bytes_written === "number" ? res.bytes_written : typeof a.content === "string" ? bytesOf(content) : null;
    if (!n && typeof a.content === "string") out.status = "Empty file";
    else {
      const bits = [];
      if (n) bits.push(plural(n, "line"));
      const sz = size(bytes);
      if (sz) bits.push(sz);
      out.status = bits.join(", ");
    }
    const more = [];
    if (diff) {
      const k = counts(diff);
      more.push({ tone: "add", text: "+" + k.add }, " ", { tone: "del", text: "-" + k.del });
    }
    if (res.dirs_created) more.push((more.length ? " · " : "") + "created folder");
    out.more = more;
    if (diff) out.blocks.push({ label: "Diff", text: diff, kind: "diff" });
    else if (content) out.blocks.push({ label: "Content", text: content, kind: "pre" });
    return out;
  }

  function patchFiles(a) {
    const out = [];
    if (typeof a.patch === "string") {
      const re = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;
      let m;
      while ((m = re.exec(a.patch))) out.push(m[2].trim());
    }
    return out;
  }

  function patch(c) {
    const a = args(c);
    const res = result(c);
    const out = { icon: "edit", blocks: [] };
    const files = patchFiles(a);
    const path = pathOf(a) || files[0] || "";
    const diff = c.diff || str(res.diff);
    const parts = diff ? splitDiff(diff) : [];
    const many = Math.max(files.length, parts.length) > 1 && !pathOf(a);
    const verbW = c.done ? "Edited " : "Editing ";
    if (many) out.title = verbW + plural(Math.max(files.length, parts.length), "file");
    else {
      const t = [verbW, { code: base(path) || "a file" }];
      const d = tail(path);
      if (d) t.push(" ", { code: d });
      out.title = t;
    }
    const hasOld = typeof a.old_string === "string";
    if (!c.done) return out;
    if (c.failed) {
      if (hasOld && a.old_string) {
        const looked = cut(str(a.old_string).replace(/\s+/g, " ").trim(), 60);
        out.lines = [{ parts: ["Looked for ", { code: looked }], dim: true }];
        out.blocks.push({ label: "Not applied", text: attempt(path, a), kind: "diff" });
      }
      return out;
    }
    let add = 0;
    let del = 0;
    let hunks = 0;
    if (diff) ({ add, del, hunks } = counts(diff));
    else if (hasOld || typeof a.new_string === "string") {
      add = lines(str(a.new_string));
      del = lines(str(a.old_string));
      hunks = 1;
    } else {
      if (typeof a.patch !== "string") return out;
      const k = counts(a.patch.split("\n").filter((l) => !l.startsWith("***")).join("\n"));
      out.status = "+" + k.add + " -" + k.del;
      out.blocks.push({ label: "Patch", text: a.patch, kind: "pre" });
      return out;
    }
    out.status = add || del ? "+" + add + " -" + del : "No change";
    const bits = [];
    if (a.replace_all === true) {
      const n = [res.replacements, res.replacement_count, res.count].find((x) => typeof x === "number");
      bits.push("every match" + (n ? " (" + n + ")" : ""));
    } else if (hunks > 1) bits.push(hunks + " places");
    if (bits.length) out.more = bits.join(" · ");
    if (diff) {
      if (parts.length > 1) for (const p of parts) out.blocks.push({ label: p.path || path, text: p.text, kind: "diff" });
      else out.blocks.push({ label: path || undefined, text: diff, kind: "diff" });
    } else if (hasOld) out.blocks.push({ label: path || undefined, text: attempt(path, a), kind: "diff" });
    return out;
  }

  // ---- search_files ----
  // parseText reads the path-grouped text of Hermes: a path on a line of
  // its own, then its rows as "  42: text". A flat "path:42:text" row also works.
  function parseText(t) {
    const rows = [];
    let cur = "";
    for (const l of str(t).split("\n")) {
      if (!l.trim()) continue;
      const m = /^\s+(\d+)[:-]\s?(.*)$/.exec(l);
      if (m && cur) rows.push({ path: cur, line: +m[1], content: m[2] });
      else if (!/^\s/.test(l)) {
        const f = /^(.+?):(\d+):(.*)$/.exec(l);
        if (f) rows.push({ path: f[1], line: +f[2], content: f[3].trim() });
        else cur = l.replace(/:$/, "").trim();
      }
    }
    return rows;
  }

  function highlight(text, pattern) {
    let re = null;
    try {
      re = pattern ? new RegExp(pattern, "gi") : null;
    } catch (_) {
      re = null;
    }
    if (!re) return [text];
    const parts = [];
    let at = 0;
    let m;
    while ((m = re.exec(text)) && parts.length < 40) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      if (m.index > at) parts.push(text.slice(at, m.index));
      parts.push({ tone: "add", text: m[0] });
      at = m.index + m[0].length;
    }
    if (at < text.length) parts.push(text.slice(at));
    return parts;
  }

  function search(c) {
    const a = args(c);
    const res = result(c);
    const out = { icon: "search", blocks: [] };
    const files = a.target === "files" || a.target === "file";
    const pat = str(a.pattern);
    const where = str(a.path);
    const placeFull = where && where !== "." ? " in " + where : "";
    const place = where && where !== "." ? " in " + base(where) : "";
    if (c.failed) {
      out.title = "Search failed" + placeFull;
      const e = errorText(res) || str(c.error);
      if (noPath(e) && /path|director|folder/i.test(e + " path")) out.status = /regex|pattern|invalid/i.test(e) ? cut(e, 80) : "Path not found";
      else if (e) out.status = cut(e.replace(/\s+/g, " "), 80);
      if (out.status) out.ownFailure = true;
      return out;
    }
    out.title = [verb(c, "Searched for ", "Searching for "), ...(files ? ["files named "] : []), { code: short(pat) || "files" }, place];
    if (!c.done) return out;
    let rows = [];
    let list = null;
    let countMap = null;
    if (Array.isArray(res.matches)) rows = res.matches.map((m) => (isObj(m) ? { path: str(m.path || m.file), line: m.line, content: str(m.content || m.text) } : { path: str(m), line: 0, content: "" }));
    else if (typeof res.matches_text === "string") rows = parseText(res.matches_text);
    else if (typeof c.out === "string" && !isObj(c.res) && c.out) rows = parseText(c.out);
    if (Array.isArray(res.files)) list = names(res.files);
    else if (files && Array.isArray(res.matches)) list = names(res.matches);
    if (isObj(res.counts)) countMap = res.counts;
    const total = typeof res.total_count === "number" ? res.total_count : null;
    const truncated = res.truncated === true || res.total_count_is_lower_bound === true;
    const known = rows.length || list || countMap || total !== null || Array.isArray(res.matches);
    if (files || (list && !rows.length)) {
      const n = list ? list.length : total || 0;
      out.status = n ? (truncated ? "At least " : "") + plural(typeof total === "number" && total > n ? total : n, "file") : "None found";
      if (!n) out.tone = "warn";
      if (list && list.length) {
        out.lines = [{ parts: list.slice(0, 2).join(", "), dim: true, mono: true }];
        out.blocks.push({ label: "Results", kind: "list", items: list.slice(0, 300).map((p) => ({ parts: [p], mono: true })) });
      }
    } else if (countMap) {
      const ks = Object.keys(countMap);
      const n = ks.reduce((s, k) => s + (+countMap[k] || 0), 0);
      out.status = n ? (truncated ? "At least " : "") + plural(n, "match", "matches") + " in " + plural(ks.length, "file") : "None found";
      if (!n) out.tone = "warn";
      out.blocks.push({ label: "Results", kind: "list", items: ks.slice(0, 300).map((k) => ({ parts: [k + "  " + countMap[k]], mono: true })) });
    } else {
      const paths = new Set(rows.map((r) => r.path).filter(Boolean));
      const n = total !== null ? total : rows.length;
      out.status = n ? (truncated ? "At least " : "") + plural(n, "match", "matches") + (paths.size ? " in " + plural(paths.size, "file") : "") : "None found";
      if (!n) out.tone = "warn";
      if (rows.length) {
        const r = rows[0];
        out.lines = [{ parts: r.path + (r.line ? ":" + r.line : "") + (r.content ? "  " + r.content.trim() : ""), dim: true, mono: true }];
        const items = [];
        let last = null;
        for (const r2 of rows.slice(0, 300)) {
          if (r2.path !== last) {
            items.push({ parts: [r2.path], mono: true });
            last = r2.path;
          }
          items.push({ parts: r2.line ? ["  " + r2.line + ": ", ...highlight(r2.content.trim(), pat)] : [], mono: true });
        }
        out.blocks.push({ label: "Results", kind: "list", items: items.filter((i) => i.parts.length) });
      }
    }
    const chips = [];
    if (str(a.file_glob)) chips.push(str(a.file_glob));
    if (a.output_mode === "count") chips.push("counts");
    else if (a.output_mode === "files_only") chips.push("names only");
    if (truncated) chips.push("more available");
    out.chips = chips;
    const warn = [];
    if (typeof res.warning === "string" && res.warning.trim()) warn.push(res.warning.trim());
    const om = Array.isArray(res._omitted) ? res._omitted.length : typeof res._omitted === "number" ? res._omitted : 0;
    if (om) warn.push(plural(om, "result") + " left out");
    if (warn.length) out.lines = (out.lines || []).concat([{ parts: [{ tone: "warn", text: upperFirst(warn.join("; ")) }], dim: true }]);
    const kv = [];
    if (where) kv.push({ k: "Looking in", v: where, mono: true });
    kv.push({ k: "Matching", v: files ? "File names" : "File contents" });
    const shown = (list ? list.length : rows.length) || 0;
    const off = typeof a.offset === "number" ? a.offset : 0;
    if (shown) {
      const all = total !== null ? total : shown;
      kv.push({ k: "Shown", v: num(off + 1) + " to " + num(off + shown) + " of " + (truncated ? "at least " : "") + num(Math.max(all, off + shown)) });
    }
    out.blocks.unshift({ kind: "kv", rows: kv });
    if (!known && isObj(c.res)) out.raw = rawOf(c);
    return out;
  }

  // ---- send_file ----
  function sent(c) {
    const a = args(c);
    const res = result(c);
    const offer = isObj(res.file_offer) ? res.file_offer : {};
    const out = { icon: "file", blocks: [] };
    const path = str(offer.path) || str(a.path);
    const real = base(path) || str(offer.name) || str(a.name) || "a file";
    const refused = res.status === "refused" || offer.secret === true && !!offer.reason;
    out.title = [c.failed ? (refused ? "Not sent " : "Could not send ") : verb(c, "Sent ", "Sending "), { code: real }];
    const d = dir(path);
    const note = str(offer.note) || str(a.note);
    const ln = [];
    if (d) ln.push({ code: d });
    if (note) ln.push((ln.length ? " · " : "") + note);
    if (ln.length) out.lines = [{ parts: ln, dim: true }];
    if (!c.done) return out;
    if (c.failed) {
      if (refused) {
        out.status = upperFirst(str(offer.reason) || errorText(res)) || "Not sent";
        out.tone = "warn";
        out.ownFailure = true;
      } else {
        const e = errorText(res) || str(c.error);
        if (e) {
          out.status = /not found|no such/i.test(e) && e.length > 40 ? "File not found" : cut(e.replace(/\s+/g, " "), 80);
          out.ownFailure = true;
        }
      }
      return out;
    }
    out.status = "Offered";
    const bits = [size(offer.size), str(offer.type_label)].filter(Boolean);
    if (bits.length) out.more = bits.join(" · ");
    if (offer.requested && offer.secret) out.chips = ["Sent at your request"];
    const kv = [];
    const shown = str(offer.name) || str(a.name);
    if (shown && shown !== real) kv.push({ k: "Shown as", v: shown });
    const t = +offer.mtime;
    if (t > 0) {
      const when = new Date(t < 1e12 ? t * 1000 : t);
      kv.push({ k: "Modified", v: when.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) });
    }
    if (kv.length) out.blocks.push({ kind: "kv", rows: kv });
    return out;
  }

  // ---- page_publish ----
  // A finished call that made a page names it in page ({ path, title }), so
  // the card can show the page itself.
  function pagePublish(c) {
    const a = args(c);
    const res = result(c);
    const out = { icon: "file", blocks: [] };
    const src = pathOf(a);
    const name = base(src);
    const title = short(str(res.title));
    out.title = c.failed ? "Could not publish a page" : c.done && title ? title : verb(c, "Published", "Publishing") + " a page";
    const ln = [];
    if (name) ln.push({ code: name });
    else if (c.done && !c.failed) ln.push("Written in the reply");
    const sz = size(res.bytes);
    if (sz && !c.failed) ln.push((ln.length ? " · " : "") + sz);
    if (ln.length) out.lines = [{ parts: ln, dim: true }];
    if (src) out.blocks.push({ kind: "kv", rows: [{ k: "Source", v: src, mono: true }] });
    if (!c.done) return out;
    if (c.failed) {
      const e = errorText(res) || str(c.error);
      if (e) {
        out.status = cut(upperFirst(e.split(": ")[0].replace(/\s+/g, " ")), 80);
        out.ownFailure = true;
      }
      return out;
    }
    out.status = "";
    const p = str(res.path);
    if (c.done && res.ok !== false && p[0] === "/" && /\.html?$/i.test(p)) out.page = { path: p, title };
    return out;
  }

  H.register({ read_file: read, write_file: write, patch, search_files: search, send_file: sent, page_publish: pagePublish });
})();
