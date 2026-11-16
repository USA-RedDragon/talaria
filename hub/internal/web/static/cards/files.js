"use strict";
// Cards of files: read, write, edit, search, send, publish a page.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  function counts(diff) {
    let add = 0;
    let del = 0;
    for (const l of stripAnsi(diff).split("\n")) {
      if (l.startsWith("+") && !l.startsWith("+++")) add++;
      else if (l.startsWith("-") && !l.startsWith("---")) del++;
    }
    return "+" + add + " -" + del;
  }

  function edit(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    let path = str(a.path) || str(a.file_path);
    if (!path && typeof a.patch === "string") {
      const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(a.patch);
      if (m) path = m[1].trim();
    }
    const wrote = c.name === "write_file";
    const out = { icon: wrote ? "filenew" : "edit", blocks: [] };
    out.title = (wrote ? verb(c, "Wrote", "Writing") : verb(c, "Edited", "Editing")) + " " + (path || "a file");
    const diff = c.diff || str(res.diff);
    if (diff) out.status = counts(diff);
    else if (wrote) out.status = "+" + lines(str(a.content)) + " -0";
    else if (typeof a.old_string === "string" || typeof a.new_string === "string") out.status = "+" + lines(str(a.new_string)) + " -" + lines(str(a.old_string));
    else out.status = "Done";
    if (diff) out.blocks.push({ label: "Diff", text: diff, kind: "diff" });
    else if (wrote && a.content) out.blocks.push({ label: "Content", text: str(a.content), pre: true });
    else if (typeof a.old_string === "string") {
      out.blocks.push({ label: "Diff", text: stripAnsi(["--- " + path, "+++ " + path].concat(str(a.old_string).split("\n").map((l) => "-" + l), str(a.new_string).split("\n").map((l) => "+" + l)).join("\n")), kind: "diff" });
    } else if (typeof a.patch === "string") out.blocks.push({ label: "Patch", text: a.patch, pre: true });
    if (c.out && !diff) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function search(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "search", blocks: [] };
    const where = str(a.path);
    out.title = verb(c, "Searched", "Searching") + " files for " + (short(str(a.pattern)) || "files") + (where ? " in " + where : "");
    const list = Array.isArray(res.matches) ? res.matches : Array.isArray(res.files) ? res.files : null;
    if (list) {
      const paths = new Set(list.map((m) => (isObj(m) ? str(m.path || m.file) : str(m))).filter(Boolean));
      const n = typeof res.total_count === "number" ? res.total_count : list.length;
      out.status = Array.isArray(res.matches) ? n + (n === 1 ? " match" : " matches") + " in " + plural(paths.size, "file") : plural(n, "file");
    } else if (typeof res.total_count === "number") {
      out.status = plural(res.total_count, "match", "matches");
    } else {
      out.status = "Done";
    }
    out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Matches", text: c.out, pre: true });
    return out;
  }

  function read(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "file", blocks: [] };
    const path = str(a.path) || str(a.file_path);
    out.title = verb(c, "Read", "Reading") + " " + (base(path) || "a file");
    const n = c.partial && c.partial.lines ? c.partial.lines : typeof res.content === "string" ? lines(res.content) : lines(c.out);
    out.status = plural(n, "line");
    out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: typeof res.content === "string" ? res.content : c.out, pre: true });
    return out;
  }

  // pagePublish is page_publish, which writes an HTML page for the user. A
  // finished call that made a page names it in page ({ path, title }), so
  // the card can show the page itself; the call and its output stay as
  // blocks for a card that cannot.
  function pagePublish(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "file", blocks: [] };
    out.title = c.failed ? "Could not publish a page" : verb(c, "Published", "Publishing") + " a page";
    out.status = "Done";
    const p = str(res.path);
    if (c.done && !c.failed && res.ok !== false && p[0] === "/" && /\.html?$/i.test(p)) out.page = { path: p, title: short(str(res.title)) };
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }


  H.register({ read_file: read, write_file: edit, patch: edit, search_files: search, page_publish: pagePublish });
})();
