"use strict";
// Cards of notes: to-do list, memory, project notes, past chats, skills, the
// decision ledger and scheduled jobs. Each renderer turns a call into the card
// model described at the top of toolcard.js and is registered with
// HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, base, verb, failedRes, errorText, upperFirst, num, size } = H.util;

  // Hermes requires approval before it saves some notes. A result that says so, or a
  // call the page marked pending, is waiting for the user.
  const pendingWords = new Set(["pending", "pending_approval", "awaiting_approval", "approval_required", "needs_approval", "waiting_for_approval"]);

  function waiting(c) {
    if (c.pending) return true;
    const res = isObj(c.res) ? c.res : {};
    return pendingWords.has(str(res.status)) || res.pending_approval === true || res.staged === true || res.approval_pending === true || res.requires_approval === true;
  }

  const obj = (v) => (isObj(v) ? v : {});
  const arr = (v) => (Array.isArray(v) ? v : []);
  const dimLine = (parts, extra) => Object.assign({ parts, dim: true }, extra);
  const quote = (s) => "“" + cut(squash(s), 80) + "”";
  const firstLine = (s) => first(str(s));
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // wall reads the date and time of an ISO text as written (its own offset is
  // not applied), so a card reads the same in every time zone.
  function wall(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(str(s));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return { month: months[+m[2] - 1] || "", day: +m[3], dow: days[d.getUTCDay()], hour: m[4] === undefined ? null : +m[4], min: m[5] === undefined ? null : +m[5] };
  }
  function clock(w) {
    if (!w || w.hour === null) return "";
    const h = w.hour % 12 || 12;
    return h + ":" + String(w.min).padStart(2, "0") + " " + (w.hour < 12 ? "AM" : "PM");
  }
  const dateWords = (s) => {
    const w = wall(s);
    return w ? w.month + " " + w.day : str(s);
  };

  // usageWords reads a usage text or object, "62% - 1,364/2,200 chars" or
  // { used, limit }, into { used, limit, pct } (numbers or null).
  function usageOf(u) {
    let used = null;
    let limit = null;
    let pct = null;
    if (isObj(u)) {
      used = typeof u.used === "number" ? u.used : typeof u.chars === "number" ? u.chars : null;
      limit = typeof u.limit === "number" ? u.limit : typeof u.max === "number" ? u.max : null;
      pct = typeof u.percent === "number" ? u.percent : null;
    } else if (typeof u === "string") {
      const m = /([\d,]+)\s*\/\s*([\d,]+)/.exec(u);
      if (m) {
        used = +m[1].replace(/,/g, "");
        limit = +m[2].replace(/,/g, "");
      }
      const p = /(\d+)\s*%/.exec(u);
      if (p) pct = +p[1];
    }
    if (pct === null && used !== null && limit) pct = Math.round((used * 100) / limit);
    return used === null || limit === null ? null : { used, limit, pct };
  }

  const entryText = (e) => (isObj(e) ? str(e.text) || str(e.content) || str(e.note) || str(e.entry) : str(e));
  const entryList = (v) => arr(v).map(entryText).filter(Boolean);
  const moreWord = (n) => (n > 0 ? "… " + n + " more" : "");

  // ---- to-do list ---------------------------------------------------------

  function todoItems(c) {
    const res = obj(c.res);
    const a = obj(c.args);
    const from = Array.isArray(res.todos) ? res.todos : !c.res && Array.isArray(a.todos) && a.merge !== true ? a.todos : null;
    return from ? from.filter(isObj) : null;
  }

  function todoSummary(items, res) {
    const s = obj(res.summary);
    const count = (k) => (typeof s[k] === "number" ? s[k] : items.filter((x) => str(x.status) === k).length);
    return { total: typeof s.total === "number" ? s.total : items.length, done: count("completed"), now: count("in_progress"), pending: count("pending"), dropped: count("cancelled") };
  }

  function todo(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    const write = Array.isArray(a.todos);
    const out = { icon: "checkcircle", blocks: [] };
    out.title = c.done && c.failed ? "Could not " + (write ? "update" : "read") + " the to-do list" : verb(c, write ? "Updated" : "Read", write ? "Updating" : "Reading") + " the to-do list";
    const items = todoItems(c);
    if (!c.done) return out;
    if (c.failed || !items) {
      if (!c.failed && !items && write) out.status = plural(a.todos.length, "item");
      else if (!c.failed) out.status = "Done";
      const e = errorText(c.res) || str(c.error);
      if (c.failed && e.length > 80) out.raw = e;
      return out;
    }
    const sum = todoSummary(items, res);
    if (!sum.total) {
      out.status = "The to-do list is empty";
      return out;
    }
    out.status = sum.done + " of " + sum.total + " done";
    out.tone = "ok";
    const active = items.find((x) => str(x.status) === "in_progress");
    out.lines = active ? [{ parts: ["Now: " + str(active.content)] }] : [];
    // What this call changed: a merge write names the items it finished.
    if (a.merge === true && write) {
      const bits = [];
      const fin = a.todos.filter((x) => isObj(x) && str(x.status) === "completed").map((x) => str(x.content) || str(x.id));
      if (fin.length) bits.push("Finished: " + (fin.length === 1 ? fin[0] : plural(fin.length, "step")));
      const drop = a.todos.filter((x) => isObj(x) && str(x.status) === "cancelled").length;
      if (drop) bits.push("Dropped " + drop);
      if (bits.length) out.lines.push(dimLine([bits.join(" · ")]));
    }
    const depth = (x) => {
      let d = 0;
      let p = x.parent;
      while (p !== undefined && p !== null && p !== "" && d < 3) {
        const up = items.find((y) => str(y.id) === str(p));
        if (!up) break;
        d++;
        p = up.parent;
      }
      return d;
    };
    const rows = items.map((x) => {
      const st = str(x.status);
      const pad = "\u00a0\u00a0\u00a0\u00a0".repeat(depth(x));
      const text = str(x.content);
      if (st === "completed") return { parts: [pad + "✓ " + text], dim: true };
      if (st === "in_progress") return { parts: [pad + "► " + text] };
      if (st === "cancelled") return { parts: [pad + "○ " + text, " ", { chip: "dropped" }], dim: true };
      return { parts: [pad + "○ " + text], dim: true };
    });
    out.blocks.push({ kind: "list", items: rows });
    return out;
  }

  // ---- project notes ------------------------------------------------------

  const noteWord = (n) => (n === 1 ? "a project note" : n + " project notes");

  // projectName is the project in plain words: the name the plugin sends,
  // else the repo or folder name read out of its key. The raw key (root:<sha>,
  // folder:<device>:<path>, host/owner/repo) never reaches a title.
  function projectName(res, c) {
    const fromKey = (k) => {
      k = str(k);
      if (/^root:[0-9a-f]{8,}$/i.test(k)) return "";
      const m = k.match(/^folder:[^:]*:(.*)$/);
      if (m) return base(m[1]);
      return /\/|:/.test(k) ? base(k) : k;
    };
    return short(str(res.project_name) || fromKey(res.project) || str(res.name) || base(str(res.folder) || str(res.path) || str(res.project_path) || str(res.root)) || fromKey(c.project));
  }

  // noteDiff is the text of a diff block: old text removed, new text added.
  // The diff view drops the first line as a header, so the text starts with an empty one.
  const noteDiff = (oldText, text) => "\n" + [oldText ? oldText.split("\n").map((l) => "- " + l).join("\n") : "", text.split("\n").map((l) => "+ " + l).join("\n")].filter(Boolean).join("\n");

  function noteBlocks(ops) {
    const blocks = [];
    for (const o of ops) {
      const act = str(o.action);
      if (act === "add") blocks.push({ label: "Added note", text: str(o.content), pre: true });
      else if (act === "remove") blocks.push({ label: "Removed note", text: str(o.old_text) || str(o.content), pre: true });
      else if (act === "replace" || act === "patch") {
        blocks.push({ label: "Text that changed", text: noteDiff(str(o.old_text), str(o.content)), kind: "diff" });
      }
    }
    return blocks;
  }

  // plainNoteError rewrites the plugin's batch error into a plain sentence.
  function plainNoteError(e) {
    let t = squash(e).replace(/^Operation \d+ \([a-z_]+\):\s*/i, "");
    const m = /^No entry matched '([^']*)'/i.exec(t);
    if (m) t = "no note matched “" + m[1] + "”";
    else t = t.charAt(0).toLowerCase() + t.slice(1);
    return t;
  }

  const usageText = (u) => (u ? num(u.used) + " of " + num(u.limit) + " characters used" : "");

  function projectMemory(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    let ops = arr(a.operations).filter(isObj);
    if (!ops.length && ["add", "patch", "replace", "remove"].concat(Object.keys(opVerbs)).includes(str(a.action))) ops = [a];
    const out = { icon: "database", blocks: [], lines: [] };
    const name = projectName(res, c);
    const failed = c.done && c.failed;
    const count = (...k) => ops.filter((o) => k.includes(str(o.action))).length;
    const added = count("add");
    const edited = count("replace", "patch");
    const removed = count("remove");
    const kinds = [added, edited, removed].filter(Boolean).length;
    const topicOps = ops.filter((o) => /^topic_/.test(str(o.action)));
    const pathOps = ops.filter((o) => /^path_/.test(str(o.action)));
    const usage = usageOf(res.usage);
    const moved = Array.isArray(res.moved_to_topics) ? res.moved_to_topics.length : isObj(res.moved_to_topics) ? Object.keys(res.moved_to_topics).length : typeof res.moved_to_topics === "number" ? res.moved_to_topics : res.moved_to_topics ? 1 : 0;
    const more = [];
    const note = (parts) => out.lines.push(dimLine(parts));
    const preview = (list) => {
      const t = list.map(firstLine).filter(Boolean);
      if (!t.length) return;
      note([cut(t[0], 80) + (t.length > 1 ? ", and " + (t.length - 1) + " more" : "")]);
    };

    if (!ops.length) {
      const topic = str(a.topic);
      const pnote = str(a.path_note);
      const query = str(a.query);
      const where = name || "this project";
      if (topic) out.title = [verb(c, "Read", "Reading") + " the topic ", { code: topic }, " of " + where];
      else if (pnote) out.title = [verb(c, "Read", "Reading") + " the path note ", { code: pnote }, " of " + where];
      else if (query) out.title = [verb(c, "Searched", "Searching") + " the notes of " + where + " for ", { code: query }];
      else out.title = verb(c, "Read", "Reading") + " the notes of " + where;
      const list = entryList(res.entries || res.notes);
      const matches = Array.isArray(res.matches) ? res.matches : null;
      if (query) {
        if (matches) {
          out.status = matches.length ? plural(matches.length, "match", "matches") : "No matches";
          if (!matches.length) out.tone = "warn";
          const t = matches.map((m) => (isObj(m) ? entryText(m) || str(m.name) || str(m.topic) : str(m))).filter(Boolean);
          if (t.length) note([cut(t[0], 80)]);
          if (t.length) out.blocks.push({ label: "Matches", kind: "list", items: t.map((x) => ({ parts: [x] })) });
        } else out.status = "Done";
      } else if (topic || pnote) {
        out.status = "Done";
        const text = str(res.content) || str(res.text);
        if (str(res.description)) note([str(res.description)]);
        if (text) out.blocks.push({ label: topic ? "Topic text" : "Path note", text, pre: true });
      } else if (Array.isArray(res.entries) || Array.isArray(res.notes)) {
        out.status = list.length ? plural(list.length, "note") + (usage ? ", " + usageText(usage) : "") : "No notes yet";
        if (list.length) {
          note([cut(firstLine(list[0]), 80) + (list.length > 1 ? ", and " + (list.length - 1) + " more" : "")]);
          out.blocks.push({ label: "Notes", kind: "list", items: list.map((x) => ({ parts: [x] })) });
        }
        const topics = arr(res.topics).map((t) => (isObj(t) ? str(t.name) || str(t.topic) : str(t))).filter(Boolean);
        if (topics.length) out.blocks.push({ label: "Topics", kind: "list", items: topics.map((x) => ({ parts: [{ code: x }] })) });
        const paths = arr(res.path_notes).map((t) => (isObj(t) ? str(t.name) || str(t.path_note) : str(t))).filter(Boolean);
        if (paths.length) out.blocks.push({ label: "Path notes", kind: "list", items: paths.map((x) => ({ parts: [{ code: x }] })) });
      } else out.status = "Done";
    } else if (!added && !edited && !removed && (topicOps.length || pathOps.length)) {
      // Topics and path notes: the detail behind the index, and the rules for
      // one folder or file type.
      const o = topicOps[0] || pathOps[0];
      const what = topicOps.length ? "the topic " : "the path note ";
      const id = short(str(o.topic) || str(o.path_note));
      const verbs = opVerbs[str(o.action)] || ["Changed", "Changing", "change"];
      const where = name ? " in " + name : "";
      if (topicOps.length + pathOps.length === 1 && id) out.title = failed ? ["Could not " + verbs[2] + " " + what, { code: id }, where] : [verb(c, verbs[0], verbs[1]) + " " + what, { code: id }, where];
      else out.title = (failed ? "Could not change " : verb(c, "Changed ", "Changing ")) + plural(topicOps.length + pathOps.length, "topic or path note", "topics and path notes") + where;
      out.status = "Saved";
      for (const x of topicOps.concat(pathOps)) {
        const k = str(x.action);
        const label = { topic_write: "Topic written: ", topic_append: "Added to topic: ", topic_patch: "Changed topic: ", topic_remove: "Removed topic: ", path_write: "Path note: ", path_remove: "Removed path note: " }[k] || "Changed: ";
        const nm = str(x.topic) || str(x.path_note);
        const paths = Array.isArray(x.paths) ? " (" + x.paths.map(str).join(", ") + ")" : "";
        if (k === "topic_patch") out.blocks.push({ label: "Text that changed", text: noteDiff(str(x.old_text), str(x.content)), kind: "diff" });
        else out.blocks.push({ label: label + nm + paths, text: str(x.content) || str(x.description) || nm, pre: true });
      }
      const d = topicOps.map((x) => str(x.description)).find(Boolean);
      const t = str(o.description) || d || (o.content ? firstLine(o.content) : "");
      if (t && !/remove/.test(str(o.action))) note([cut(t, 80)]);
    } else {
      let head;
      if (kinds > 1) head = verb(c, "Changed ", "Changing ") + noteWord(ops.length) + (name ? " in " + name : "");
      else if (added) head = verb(c, "Added ", "Adding ") + noteWord(added) + (name ? " to " + name : "");
      else if (edited) head = verb(c, "Edited ", "Editing ") + noteWord(edited) + (name ? " in " + name : "");
      else head = verb(c, "Removed ", "Removing ") + noteWord(removed) + (name ? " from " + name : "");
      if (failed) head = head.replace(/^Added /, "Could not add ").replace(/^Edited /, "Could not edit ").replace(/^Removed /, "Could not remove ").replace(/^Changed /, "Could not change ");
      out.title = head;
      out.status = "Saved";
      out.blocks.push(...noteBlocks(ops));
      if (removed && !added && !edited) preview(ops.map((o) => str(o.old_text)));
      else preview(ops.filter((o) => ["add", "replace", "patch"].includes(str(o.action))).map((o) => str(o.content)));
    }

    if (ops.length) {
      if (usage) more.push(usageText(usage));
      if (moved) more.push(moved === 1 ? "note moved out of the index" : moved + " notes moved out of the index");
      out.more = more;
    }
    if (waiting(c)) {
      out.status = "Waiting for approval";
      out.tone = "warn";
      out.waiting = true;
      out.more = [];
    }
    if (c.failed) {
      const e = errorText(c.res) || str(c.error) || first(c.out);
      out.ownFailure = true;
      out.status = "Failed: " + (plainNoteError(e) || "the call did not work");
      const closest = entryList(res.closest_entries || res.closest);
      out.blocks = out.blocks.filter((b) => b.label !== "Removed note");
      if (closest.length) {
        out.lines = [dimLine(["Closest: " + cut(firstLine(closest[0]), 80)])];
        out.blocks.push({ label: "Closest notes", text: closest.join("\n"), pre: true });
      } else out.lines = [];
      if (!errorText(c.res) && c.out) out.raw = c.out;
    }
    return out;
  }
  const opVerbs = { topic_write: ["Wrote", "Writing", "write"], topic_append: ["Added to", "Adding to", "add to"], topic_patch: ["Changed", "Changing", "change"],
    topic_remove: ["Removed", "Removing", "remove"], path_write: ["Wrote", "Writing", "write"], path_remove: ["Removed", "Removing", "remove"] };

  // ---- memory -------------------------------------------------------------

  function memoryTool(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    let ops = arr(a.operations).filter(isObj);
    if (!ops.length && str(a.action)) ops = [a];
    const target = (o) => (str(o.target) || str(a.target)) === "user" ? "user" : "memory";
    const stores = new Set(ops.map(target));
    const user = stores.size === 1 && stores.has("user");
    const what = user ? "your profile" : "memory";
    const out = { icon: "database", blocks: [], lines: [] };
    const failed = c.done && c.failed;
    const of = (...k) => ops.filter((o) => k.includes(str(o.action)));
    const adds = of("add");
    const removes = of("remove");
    const edits = of("patch", "replace");
    if (ops.length <= 1) {
      const act = str(ops[0] && ops[0].action);
      if (act === "add") out.title = failed ? "Could not save a note to " + what : verb(c, "Saved a note to ", "Saving a note to ") + what;
      else if (act === "remove") out.title = failed ? "Could not remove a note from " + what : verb(c, "Removed a note from ", "Removing a note from ") + what;
      else if (act === "replace" || act === "patch") out.title = failed ? "Could not update a note in " + what : verb(c, "Updated a note in ", "Updating a note in ") + what;
      else out.title = verb(c, "Used ", "Using ") + what;
    } else {
      const bits = [];
      if (adds.length) bits.push((bits.length ? "saved " : "Saved ") + plural(adds.length, "note"));
      if (removes.length) bits.push((bits.length ? "removed " : "Removed ") + (bits.length ? String(removes.length) : plural(removes.length, "note")));
      if (edits.length) bits.push((bits.length ? "updated " : "Updated ") + (bits.length ? String(edits.length) : plural(edits.length, "note")));
      out.title = failed ? "Could not change " + plural(ops.length, "note") + " in " + what : (c.done ? bits.join(", ") : "Saving " + plural(ops.length, "note")) + " in " + what;
    }
    out.status = ops.length ? "Saved" : "Done";

    // The note itself, then how full the store is.
    const quoted = (o) => quote(str(o.content) || str(o.old_text));
    if (ops.length === 1) {
      const o = ops[0];
      if (str(o.action) === "remove") out.lines.push({ parts: [{ tone: "del", text: quote(str(o.old_text) || str(o.content)) }] });
      else out.lines.push({ parts: [quote(str(o.content))] });
    } else if (ops.length > 1) {
      const parts = [];
      const a1 = adds[0] || edits[0];
      if (a1) parts.push({ tone: "add", text: "+" }, " " + quoted(a1).replace(/^“?/, "“"));
      if (removes[0]) {
        if (parts.length) parts.push(" · ");
        parts.push({ tone: "del", text: "− " + quote(str(removes[0].old_text) || str(removes[0].content)) });
      }
      out.lines.push({ parts });
    }
    const usage = usageOf(res.usage);
    const count = typeof res.entry_count === "number" ? res.entry_count : null;
    const dup = /already|duplicate/i.test(str(res.message)) && !c.failed;
    const store = user ? "Profile" : "Memory";
    const facts = [];
    if (dup) facts.push("Already saved, no duplicate added");
    if (usage) facts.push(store + " " + usage.pct + "% full (" + num(usage.used) + " of " + num(usage.limit) + " characters)" + (count !== null ? " · " + plural(count, "note") : ""));
    else if (count !== null) facts.push(store + " " + plural(count, "note"));
    const factText = facts.join(" · ").replace(/^Already saved, no duplicate added · /, "Already saved, no duplicate added · ").replace(/ · Memory /, " · Memory ");
    if (factText) out.lines.push(dimLine([dup && usage ? "Already saved, no duplicate added · " + store + " " + usage.pct + "% full (" + num(usage.used) + " of " + num(usage.limit) + " characters)" + (count !== null ? " · " + plural(count, "note") : "") : factText], { wrap: true }));

    for (const o of ops) {
      const act = str(o.action);
      if (act === "add") out.blocks.push({ label: failed ? "Note" : "Added note", text: str(o.content), pre: true });
      else if (act === "remove") out.blocks.push({ label: failed ? "Note to remove" : "Removed note", text: str(o.old_text), pre: true });
      else if (act === "patch" || act === "replace") {
        if (failed) out.blocks.push({ label: "Note", text: str(o.content), pre: true });
        else out.blocks.push({ label: "Added note", text: str(o.content), pre: true }, { label: "Removed note", text: str(o.old_text), pre: true });
      }
    }
    if (!failed && (usage || count !== null)) {
      const rows = [];
      if (usage) rows.push({ k: "Used", v: num(usage.used) + " of " + num(usage.limit) + " characters" });
      if (count !== null) rows.push({ k: "Notes", v: String(count) });
      out.blocks.push({ label: store, kind: "kv", rows });
    }
    if (failed) {
      const cur = entryList(res.current_entries);
      if (cur.length) {
        const shown = cur.slice(0, 5);
        out.blocks.push({ label: "Current notes", text: shown.join("\n") + (cur.length > shown.length ? "\n" + moreWord(cur.length - shown.length) : ""), pre: true });
      }
      if (!errorText(c.res) && c.out) out.raw = c.out;
      if (usage && !out.lines.some((l) => l.dim)) out.lines.push(dimLine([store + " " + usage.pct + "% full (" + num(usage.used) + " of " + num(usage.limit) + " characters)" + (count !== null ? " · " + plural(count, "note") : "")]));
    }
    if (waiting(c)) {
      out.status = "Waiting for approval";
      out.tone = "warn";
      out.waiting = true;
    }
    return out;
  }

  // ---- past chats ---------------------------------------------------------

  const roleWords = { user: "You", assistant: "assistant", tool: "tools", system: "system" };

  // since reads the after/before arguments into a short chip.
  function dateRange(a) {
    const rel = /^(\d+)\s*([dhw])$/i.exec(str(a.after).trim());
    const unit = { d: "day", h: "hour", w: "week" };
    let after = "";
    if (rel) after = "last " + plural(+rel[1], unit[rel[2].toLowerCase()]);
    else if (str(a.after)) after = "since " + dateWords(a.after);
    const before = str(a.before) ? "until " + dateWords(a.before) : "";
    return { chip: after || before, rows: [after, before].filter(Boolean) };
  }

  // messageText is the words of one message of a read or scroll result: its
  // text, else the tools it called (a turn of only tool calls has no text).
  function messageText(m) {
    const text = str(m.content).trim();
    if (text) return text;
    let calls = m.tool_calls;
    if (typeof calls === "string") {
      try {
        calls = JSON.parse(calls);
      } catch (e) {
        calls = null;
      }
    }
    const names = arr(calls).map((t) => str(obj(t.function).name) || str(obj(t).name)).filter(Boolean);
    return names.length ? "Called " + names.join(", ") : "No text";
  }

  function messageLabel(m) {
    const role = str(m.role);
    if (role === "tool") return str(m.tool_name) ? "Tool: " + m.tool_name : "Tool result";
    if (role === "user") return "You";
    if (role === "assistant") return "Agent";
    return upperFirst(role || "message");
  }

  // pastMessages draws the messages a read or scroll returned: one block each,
  // short ones in full, long ones (and tool output) folded under their first
  // words; a gap between the first and last messages of a long read says how
  // many were not read.
  function pastMessages(res, msgs) {
    const blocks = [];
    const gap = res.truncated === true && typeof res.head_count === "number" && typeof res.message_count === "number" ? res.message_count - msgs.length : 0;
    msgs.forEach((m, i) => {
      if (gap > 0 && i === res.head_count) blocks.push({ plain: true, copy: false, text: "… " + plural(gap, "message") + " in between not read" });
      const text = messageText(m);
      const label = messageLabel(m) + (m.anchor === true ? " (starting point)" : "");
      const long = text.length > 600 || text.split("\n").length > 8 || str(m.role) === "tool";
      const note = m.content_truncated === true ? "\n… (cut short)" : "";
      if (long) blocks.push({ label: label + ": " + cut(first(text), 70), text: text + note, fold: true, plain: true });
      else blocks.push({ label, text, plain: true, copy: false });
    });
    return blocks;
  }

  function sessionSearch(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    const out = { icon: "search", blocks: [], lines: [] };
    const sid = str(a.session_id);
    const mode = str(res.mode) || (sid ? (a.around_message_id !== undefined && a.around_message_id !== null ? "scroll" : "read") : str(a.query) ? "discover" : "browse");
    const q = short(str(a.query));
    const title = short(str(obj(res.session_meta).title) || str(res.title) || str(res.session_title));
    const tail = title ? ": " + title : "";
    const failed = c.done && c.failed;
    if (mode === "read") out.title = verb(c, "Read", "Reading") + " a past chat" + tail;
    else if (mode === "scroll") out.title = verb(c, "Scrolled", "Scrolling") + " a past chat" + tail;
    else if (q) out.title = verb(c, "Searched", "Searching") + " past chats for “" + q + "”";
    else out.title = verb(c, "Browsed", "Browsing") + " recent chats";
    const range = dateRange(a);
    const results = arr(res.results).filter(isObj);
    const msgs = arr(res.messages).filter(isObj);
    const more = [];
    const warn = [];
    if (res.index_rebuild !== undefined && res.index_rebuild !== null) {
      const p = isObj(res.index_rebuild) ? res.index_rebuild.percent : res.index_rebuild;
      if (typeof p === "number") warn.push("search index " + Math.round(p) + "% built, may be incomplete");
    }
    if (results.some((r) => str(r.match) === "any_terms")) warn.push("partial word matches");
    if (typeof res.skipped_live_context === "number" && res.skipped_live_context > 0) warn.push(plural(res.skipped_live_context, "match", "matches") + " in this chat's own history not shown");
    if (mode === "read" || mode === "scroll") {
      const total = typeof res.total_messages === "number" ? res.total_messages : typeof res.message_count === "number" ? res.message_count : null;
      if (mode === "scroll" && typeof res.window_start === "number" && typeof res.window_end === "number") {
        out.status = "Messages " + res.window_start + " to " + res.window_end + (total !== null ? " of " + total : "");
      } else if (mode === "read" && res.truncated === true && typeof res.head_count === "number" && typeof res.tail_count === "number" && total !== null) {
        out.status = "Messages 1 to " + res.head_count + " and " + (total - res.tail_count + 1) + " to " + total + " of " + total;
      } else if (mode === "read" && msgs.length && total !== null) {
        out.status = msgs.length === total ? "All " + plural(total, "message") : plural(msgs.length, "message") + " of " + total;
      } else if (msgs.length) out.status = plural(msgs.length, "message");
      else out.status = "Done";
      if (out.status !== "Done") out.tone = "ok";
      if (res.truncated === true && typeof res.head_count === "number" && typeof res.tail_count === "number" && total !== null) {
        out.lines.push(dimLine(["First " + res.head_count + " and last " + res.tail_count + " shown, " + plural(total - msgs.length, "message") + " in between not read"]));
      }
      if (msgs.some((m) => m.content_truncated === true)) out.lines.push(dimLine(["Long messages are cut short"]));
      if (msgs.length && !out.lines.length) {
        const m = msgs.find((x) => x.anchor === true) || msgs[0];
        out.lines.push(dimLine([messageLabel(m) + ": " + cut(squash(messageText(m)), 120)]));
      }
      out.blocks.push(...pastMessages(res, msgs));
    } else if (Array.isArray(res.results) || typeof res.count === "number") {
      const n = typeof res.count === "number" ? res.count : arr(res.results).length;
      const searched = typeof res.sessions_searched === "number" ? " of " + res.sessions_searched + " searched" : "";
      if (n) {
        out.status = mode === "browse" ? plural(n, "recent chat") : plural(n, "chat") + " found" + searched;
        out.tone = "ok";
      } else {
        out.status = q ? "No matches" : "No chats";
        out.tone = "warn";
      }
      if (range.chip) more.push({ chip: range.chip });
      if (!n) more.push(...warn.map((w) => ({ tone: "warn", text: w })));
      else if (warn.length) out.lines.push({ parts: [{ tone: "warn", text: warn.join(" · ") }] });
      if (n && results.length) {
        const top = results[0];
        const t = str(top.title) || str(top.session_title) || (mode === "browse" ? cut(squash(str(top.preview)), 80) : "");
        if (t) out.lines.push({ parts: [(q ? "Best match: " : "") + t] });
        if (results.length > 1) out.lines.push(dimLine(["+" + (results.length - 1) + " more"]));
      }
    } else out.status = "Done";
    out.more = more;

    const rows = [];
    if (range.rows.length) rows.push({ k: "Date range", v: upperFirst(range.rows.join(", ")) });
    const roles = str(a.role_filter).split(",").map((x) => x.trim()).filter(Boolean).map((x) => roleWords[x] || x);
    if (roles.length) rows.push({ k: "Roles", v: roles.length === 2 ? roles.join(" and ") : roles.join(", ") });
    if (str(a.profile)) rows.push({ k: "Profile", v: str(a.profile) });
    if (rows.length) out.blocks.unshift({ kind: "kv", rows });
    if (results.length) {
      const items = [];
      for (const r of results) {
        const t = str(r.title) || str(r.session_title) || "Untitled chat";
        const meta = r.message_count ? plural(+r.message_count, "message") : "";
        items.push({ parts: [t, str(r.source) ? " " : "", ...(str(r.source) ? [{ chip: str(r.source) }] : []), meta ? " " + meta : ""] });
        const sn = str(r.snippet).replace(/>>>|<<</g, "") || str(r.preview);
        if (sn) items.push({ parts: [(str(r.matched_role) && str(r.matched_role) !== "session_title" ? str(r.matched_role) + ": " : "") + cut(squash(sn), 160)], dim: true, mono: true });
      }
      out.blocks.push({ label: mode === "browse" ? "Recent chats" : "Matches", kind: "list", items });
    }
    if (failed && !errorText(c.res) && c.out) out.raw = c.out;
    return out;
  }

  // ---- skills -------------------------------------------------------------

  // scopeChip says where a skill lives, only when the call or the result says so.
  function scopeChip(a, res) {
    const s = str(res.scope) || str(a.scope);
    const p = str(res.project) || str(res.project_name);
    if (s === "project") return { chip: "Project" + (p ? ": " + p : "") };
    if (s === "global") return { chip: "Global" };
    return null;
  }

  // utf8Len is the size of a text in bytes.
  function utf8Len(s) {
    let n = 0;
    for (const ch of s) {
      const p = ch.codePointAt(0);
      n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4;
    }
    return n;
  }

  function sentence(s) {
    const t = squash(s);
    const m = /^(.+?[.!?])(\s|$)/.exec(t);
    return cut(m ? m[1] : t, 160);
  }

  function frontmatter(content, key) {
    const m = new RegExp("^" + key + ":\\s*(.+)$", "m").exec(str(content));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  }

  const manageVerbs = {
    create: ["Created skill ", "Creating skill "], patch: ["Patched skill ", "Patching skill "], edit: ["Rewrote skill ", "Rewriting skill "],
    delete: ["Deleted skill ", "Deleting skill "], archive: ["Archived skill ", "Archiving skill "],
  };

  function skillList(c, a, res, out) {
    const list = arr(res.skills).filter(isObj);
    const cat = str(a.category);
    const n = typeof res.count === "number" ? res.count : list.length;
    out.title = Array.isArray(res.skills) || typeof res.count === "number"
      ? verb(c, "Listed ", "Listing ") + plural(n, "skill") + (cat ? " in " + cat : "")
      : verb(c, "Listed", "Listing") + " skills" + (cat ? " in " + cat : "");
    if (c.done && !c.failed && Array.isArray(res.skills) && !n) {
      out.title = verb(c, "Listed", "Listing") + " skills";
      out.status = cat ? "No skills in category " + cat : "No skills found";
      return;
    }
    out.status = "Done";
    const groups = new Map();
    for (const s of list) {
      const k = str(s.category) || "other";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    let cats = arr(res.categories).map((x) => (isObj(x) ? str(x.name) : str(x))).filter(Boolean);
    if (!cats.length) cats = [...groups.keys()].filter((k) => k !== "other");
    if (cats.length && !cat) out.lines.push({ parts: [cats.slice(0, 3).join(", ") + (cats.length > 3 ? " and " + (cats.length - 3) + " more " + (cats.length - 3 === 1 ? "category" : "categories") : "")] });
    for (const [k, items] of [...groups.entries()].slice(0, 30)) {
      out.blocks.push({ label: k + " (" + items.length + ")", kind: "list", items: items.map((s) => ({ parts: [{ code: str(s.name) }, " " + sentence(s.description)] })) });
    }
  }

  function skillView(c, a, res, out) {
    const name = str(a.name) || str(res.name);
    const file = str(a.file_path);
    out.title = file ? [verb(c, "Read ", "Reading "), { code: file }, " of skill ", { code: name }] : [verb(c, "Read", "Reading") + " skill ", { code: name }];
    if (!name) out.title = verb(c, "Read", "Reading") + " a skill";
    out.status = "Done";
    out.statusLast = true;
    if (c.failed) return;
    const desc = sentence(res.description);
    if (desc) out.lines.push({ parts: [desc] });
    const tags = arr(res.tags).map(str).filter(Boolean);
    let linked = [];
    if (Array.isArray(res.linked_files)) linked = res.linked_files.map(str);
    else if (isObj(res.linked_files)) for (const v of Object.values(res.linked_files)) linked.push(...arr(v).map(str));
    linked = linked.filter(Boolean);
    const content = str(res.content);
    const facts = [];
    const chip = scopeChip(a, res);
    if (tags.length) facts.push(plural(tags.length, "tag"));
    if (linked.length) facts.push(plural(linked.length, "linked file"));
    if (content) facts.push(size(utf8Len(content)));
    if (chip || facts.length) out.lines.push(dimLine([...(chip ? [chip, " "] : []), facts.join(" · ")]));
    const rows = [];
    if (tags.length) rows.push({ k: "Tags", v: tags.join(", ") });
    const rel = arr(res.related_skills).map(str).filter(Boolean);
    if (rel.length) rows.push({ k: "Related", v: rel.join(", ") });
    if (linked.length) rows.push({ k: "Linked files", v: linked.slice(0, 2).join(", ") + (linked.length > 2 ? ", +" + (linked.length - 2) : ""), mono: true });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    if (content) out.blocks.push({ label: "Content", text: content, pre: true });
  }

  function skillManage(c, a, res, out) {
    const ops = arr(a.operations).filter(isObj);
    const list = ops.length ? ops : [a];
    const names = [...new Set(list.map((o) => str(o.name)).filter(Boolean))];
    const failed = c.done && c.failed;
    if (list.length > 1) {
      out.title = verb(c, "Changed ", "Changing ") + plural(names.length || list.length, "skill");
      if (names.length) out.lines.push({ parts: [names.join(", ")] });
    } else {
      const o = list[0];
      const act = str(o.action);
      const nm = str(o.name);
      const t = (word) => [verb(c, word[0], word[1]), { code: nm }];
      if (act === "write_file") out.title = [verb(c, "Added file ", "Adding file "), { code: str(o.file_path) }, " to skill ", { code: nm }];
      else if (act === "remove_file") out.title = [verb(c, "Removed file ", "Removing file "), { code: str(o.file_path) }, " from skill ", { code: nm }];
      else if (act === "patch" && !o.old_string && o.content) out.title = t(manageVerbs.edit);
      else if (manageVerbs[act]) out.title = t(manageVerbs[act]);
      else out.title = [verb(c, "Changed skill ", "Changing skill "), { code: nm }];
      if (!nm) out.title = typeof out.title[0] === "string" ? out.title.filter((p) => !(isObj(p) && !p.code)) : out.title;
    }
    const chip = scopeChip(list[0] || {}, Object.assign({}, res, { scope: str(res.scope) || str(list[0] && list[0].scope) }));
    if (list.length === 1) {
      const o = list[0];
      const act = str(o.action);
      const lead = chip ? [chip, " "] : [];
      if (act === "patch" && o.old_string !== undefined) {
        const del = str(o.old_string) ? str(o.old_string).replace(/\n+$/, "").split("\n").length : 0;
        const add = str(o.new_string) ? str(o.new_string).replace(/\n+$/, "").split("\n").length : 0;
        const rep = /(\d+)\s+replacements?/i.exec(str(res.message));
        out.lines.push({ parts: [...lead, { tone: "add", text: "+" + add }, " ", { tone: "del", text: "-" + del }, " " + (Math.max(add, del) === 1 ? "line" : "lines") + (rep ? " · " + plural(+rep[1], "replacement") + " in " + (str(o.file_path) || "SKILL.md") : "")] });
        if (!failed) out.blocks.push({ label: "Change to " + (str(o.file_path) || "SKILL.md"), text: noteDiff(str(o.old_string), str(o.new_string)), kind: "diff" });
      } else if (act === "create") {
        const desc = sentence(frontmatter(o.content, "description"));
        const cat = str(o.category);
        out.lines.push({ parts: [...lead, desc || (cat ? "Category " + cat : "")] });
        if (str(o.content) && !failed) out.blocks.push({ label: "SKILL.md", text: str(o.content), pre: true });
      } else if (act === "patch" || act === "edit") {
        out.lines.push({ parts: [...lead, "New SKILL.md"] });
        if (str(o.content) && !failed) out.blocks.push({ label: "SKILL.md", text: str(o.content), pre: true });
      } else if (act === "write_file") {
        out.lines.push({ parts: [...lead, base(str(o.file_path))] });
        if (str(o.file_content) && !failed) out.blocks.push({ label: str(o.file_path), text: str(o.file_content), pre: true });
      } else if (act === "delete") {
        out.lines.push({ parts: [...lead, ...(str(o.absorbed_into) ? ["Merged into ", { code: str(o.absorbed_into) }] : [])] });
      } else if (chip) out.lines.push({ parts: [chip] });
    } else {
      const rows = list.map((o, i) => {
        const res1 = arr(res.results)[i];
        const ok = isObj(res1) ? res1.success !== false : !failed;
        return { parts: [str(o.action) + " ", { code: str(o.name) }, " ", { tone: ok ? "ok" : "bad", text: ok ? "Done" : "Failed" }] };
      });
      out.blocks.push({ label: "Operations", kind: "list", items: rows });
    }
    out.status = "Saved";
    out.statusLast = true;
    if (res.staged === true || waiting(c)) {
      out.status = "Waiting for your approval";
      out.tone = "warn";
      out.waiting = true;
      if (str(res.gist)) out.lines = [{ parts: [chip ? chip : "", chip ? " " : "", sentence(res.gist)] }].concat(out.lines.slice(1));
    }
  }

  function skill(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    const out = { icon: "book", blocks: [], lines: [], statusLast: true };
    if (c.name === "skills_list") skillList(c, a, res, out);
    else if (c.name === "skill_view") skillView(c, a, res, out);
    else skillManage(c, a, res, out);
    if (c.failed) {
      const e = errorText(c.res) || str(c.error);
      const sim = arr(res.available_skills).map((x) => (isObj(x) ? str(x.name) : str(x))).filter(Boolean);
      const over = arr(res.matches || res.overlaps || res.similar || res.similar_skills || res.overlap).filter((x) => (isObj(x) ? str(x.name) : str(x)));
      const overNames = over.map((x) => (isObj(x) ? str(x.name) : str(x)));
      out.lines = [];
      if (/overlap|too like|similar to/i.test(e) && overNames.length) {
        out.lines.push(dimLine(["Refused: too like " + overNames.slice(0, 3).join(", ")]));
        out.blocks = [{ label: "Closest matches", kind: "list", items: over.slice(0, 3).map((x) => ({ parts: [{ code: isObj(x) ? str(x.name) : str(x) }, isObj(x) && str(x.description) ? " " + sentence(x.description) : ""] })) }];
      } else if (sim.length && /not found/i.test(e)) out.lines.push(dimLine(["Not found. Similar: " + sim.slice(0, 3).join(", ")]));
            if (!errorText(c.res) && c.out) out.raw = c.out;
    }
    return out;
  }

  // ---- ledger -------------------------------------------------------------

  const ledgerKinds = new Set(["decision", "settled", "question", "dispatch", "release", "note"]);
  const blockedRe = /\b(blocked|denied|refused|reviewer|not approved|no message from you)\b/i;

  // ledgerReason writes the ledger tool's own errors as plain sentences.
  function ledgerReason(e) {
    const t = squash(e);
    if (/^no ledger entry/i.test(t)) return "no entry with that id";
    if (/^add needs text/i.test(t)) return "nothing to add, the text was empty";
    if (/^search needs a query/i.test(t)) return "nothing to search for, the query was empty";
    return t.charAt(0).toLowerCase() + t.slice(1);
  }

  // Only a call that failed shows (toolcard.js quiet): one that worked stays hidden.
  function ledger(c) {
    const a = obj(c.args);
    const act = str(a.action);
    const e = errorText(c.res) || str(c.error) || first(c.out);
    const blocked = blockedRe.test(e);
    const out = { icon: "list", blocks: [], lines: [], statusLast: true, ownFailure: true };
    if (blocked) out.title = c.done ? "Ledger write blocked" : "Writing to the ledger";
    else if (act === "add") out.title = c.done ? "Could not add a ledger note" : "Adding a ledger note";
    else if (act === "close") out.title = c.done ? "Could not close a ledger entry" : "Closing a ledger entry";
    else if (act === "search") out.title = c.done ? "Could not search the ledger" : "Searching the ledger";
    else if (act === "list") out.title = c.done ? "Could not list the ledger" : "Listing the ledger";
    else out.title = c.done ? "Could not use the ledger" : "Using the ledger";
    if (act === "add" || (blocked && str(a.text))) {
      const kind = str(a.kind);
      const text = squash(a.text);
      out.lines.push(dimLine([...(ledgerKinds.has(kind) ? [{ chip: kind }, " "] : []), text || "(empty)"]));
      if (text && (text.length > 160 || str(a.text).includes("\n"))) out.blocks.push({ label: "Text not saved", text: str(a.text), pre: true });
    } else if (act === "close" && str(a.id)) {
      out.lines.push(dimLine(["Entry ", { code: str(a.id) }]));
      if (str(a.note)) out.blocks.push({ label: "Note not saved", text: str(a.note), pre: true });
    } else if (act === "search" && str(a.query)) out.lines.push(dimLine([quote(a.query)]));
    const why = ledgerReason(e);
    out.status = (blocked ? "Blocked: " : "Failed: ") + (blocked ? squash(e).replace(/^(blocked|denied|refused)[:\s]*/i, "") : why || "the call did not work");
    if (!errorText(c.res) && c.out && c.out !== e) out.raw = c.out;
    return out;
  }

  // ---- scheduled jobs -----------------------------------------------------

  // cronWords writes a schedule in words: a cron text of the common shapes,
  // else the text as the job reports it.
  function cronWords(s) {
    const t = squash(s);
    const f = t.split(" ");
    if (f.length !== 5 || /[^\d*/,\-\sA-Za-z]/.test(t)) return t;
    const [m, h, dom, mon, dow] = f;
    const at = /^\d+$/.test(m) && /^\d+$/.test(h) ? clock({ hour: +h, min: +m }) : "";
    const ev = /^\*\/(\d+)$/.exec(m);
    if (ev && h === "*" && dom === "*" && mon === "*" && dow === "*") return "Every " + (+ev[1] === 1 ? "minute" : ev[1] + " minutes");
    if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "Every hour";
    if (!at || mon !== "*") return t;
    if (dom === "*" && dow === "*") return "Every day at " + at;
    if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return "Every weekday at " + at;
    if (dom === "*" && /^[0-7]$/.test(dow)) return "Every " + ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][+dow] + " at " + at;
    if (/^\d+$/.test(dom) && dow === "*") return "Monthly on day " + dom + " at " + at;
    return t;
  }

  function scheduleOf(job, a) {
    let s = job.schedule_display !== undefined ? job.schedule_display : job.schedule;
    if (isObj(s)) s = str(s.display) || str(s.expr) || str(s.cron) || str(s.value) || (s.minutes ? "every " + s.minutes + " minutes" : "");
    const t = str(s) || str(a.schedule);
    return t ? upperFirst(cronWords(t)) : "";
  }

  function repeatChip(job) {
    const r = job.repeat;
    if (r === undefined || r === null) return "";
    if (isObj(r)) {
      if (r.times === null || r.times === undefined) return "Forever";
      return typeof r.times === "number" ? plural(r.times, "run") : "";
    }
    if (typeof r === "number") return plural(r, "run");
    if (/^(forever|always|none)$/i.test(str(r))) return "Forever";
    return /^\d+$/.test(str(r)) ? plural(+str(r), "run") : "";
  }

  function nextRun(job) {
    const w = wall(job.next_run_at);
    return w ? w.dow + " " + clock(w) : "";
  }

  function lastRun(job) {
    if (!job.last_run_at) return "Never run yet";
    // When it last ran is not shown (a card carries no clock time); how it went is.
    const how = str(job.last_status) === "error" || str(job.last_status) === "failed" ? "Last run failed" : str(job.last_status) ? "Last run " + str(job.last_status) : "Ran before";
    return how + (str(job.last_error) ? ": " + cut(squash(job.last_error), 80) : "");
  }

  const cronVerbs = {
    create: ["Scheduled a job", "Scheduling a job", "schedule a job"], list: ["Listed scheduled jobs", "Listing scheduled jobs", "list scheduled jobs"],
    pause: ["Paused a job", "Pausing a job", "pause a job"], resume: ["Resumed a job", "Resuming a job", "resume a job"], update: ["Updated a job", "Updating a job", "update a job"],
    remove: ["Removed a job", "Removing a job", "remove a job"], run: ["Ran a job now", "Running a job now", "run a job"], cancel: ["Stopped a job", "Stopping a job", "stop a job"],
  };

  function cronjob(c) {
    const a = obj(c.args);
    const res = obj(c.res);
    const act = str(a.action) || "list";
    const job = isObj(res.job) ? res.job : isObj(res.removed_job) ? res.removed_job : res;
    const out = { icon: "clock", blocks: [], lines: [] };
    const v = cronVerbs[act] || ["Used the job schedule", "Using the job schedule", "use the job schedule"];
    const name = short(str(a.name) || str(job.name) || str(job.prompt_preview));
    const head = c.done && c.failed ? "Could not " + v[2] : verb(c, v[0], v[1]);
    out.title = act === "list" ? head : name ? head + ": " + name : head;
    const sched = scheduleOf(job, a);
    const when = nextRun(job);
    const state = str(job.state);
    const paused = state === "paused" || job.enabled === false;
    if (act === "list") {
      const jobs = arr(res.jobs).filter(isObj);
      const n = typeof res.count === "number" ? res.count : jobs.length;
      if (Array.isArray(res.jobs) || typeof res.count === "number") {
        const p = jobs.filter((j) => str(j.state) === "paused" || j.enabled === false).length;
        out.status = n ? plural(n, "job") + (p ? ", " + p + " paused" : "") : "No scheduled jobs";
        const names = jobs.map((j) => str(j.name)).filter(Boolean);
        if (names.length) out.lines.push(dimLine([names.slice(0, 2).join(", ") + (names.length > 2 ? ", and " + (names.length - 2) + " more" : "")]));
        if (jobs.length) {
          out.blocks.push({ kind: "list", items: jobs.map((j) => ({ parts: [str(j.name) || "Unnamed job", " · " + (scheduleOf(j, {}) || "no schedule") + (str(j.state) ? " · " + str(j.state) : "") + (nextRun(j) ? " · next " + nextRun(j) : "")] })) });
        }
      } else out.status = "Done";
      return out;
    }
    if (act === "run") {
      out.status = "Running in the background";
      out.tone = "warn";
    } else if (act === "pause") {
      out.status = "Paused";
      out.tone = "warn";
    } else if (act === "resume") out.status = "Resumed";
    else if (act === "remove") out.status = "Removed";
    else if (act === "cancel") out.status = "Stopped";
    else if (act === "update") out.status = sched || "Updated";
    else if (act === "create") {
      out.status = sched || "Done";
      if (paused) {
        out.tone = "warn";
        out.status = "Created paused";
        out.more = sched ? [sched] : [];
      }
    } else out.status = "Done";
    if ((act === "create" || act === "update") && !paused) {
      const chip = repeatChip(job);
      if (chip) out.more = [{ chip }];
      if (sched && act === "create") out.tone = "ok";
    }
    if (act === "remove" && sched) out.lines.push(dimLine([sched]));
    if (when && !paused && act !== "remove" && act !== "cancel") out.lines.push(dimLine(["Next run " + when]));
    for (const k of ["warning", "notice"]) if (str(res[k])) out.lines.push({ parts: [{ tone: "warn", text: squash(res[k]) }] });
    if (act === "create" || act === "update") {
      const rows = [];
      if (str(job.last_run_at) || str(job.last_status) || res.job) rows.push({ k: "Last run", v: lastRun(job) });
      if (str(job.paused_reason)) rows.push({ k: "Paused reason", v: str(job.paused_reason) });
      const wd = str(job.workdir) || str(a.workdir);
      if (wd) rows.push({ k: "Folder", v: [{ code: wd }] });
      const sk = arr(job.skills || a.skills).map(str).filter(Boolean);
      if (sk.length) rows.push({ k: "Skills", v: sk.join(", ") });
      const ts = arr(job.enabled_toolsets || a.enabled_toolsets).map(str).filter(Boolean);
      if (ts.length) rows.push({ k: "Tools allowed", v: ts.join(", ") });
      if (rows.length) out.blocks.push({ kind: "kv", rows });
      const prompt = str(a.prompt) || str(job.prompt) || str(job.prompt_preview);
      if (prompt) out.blocks.push({ label: "Prompt", text: prompt, plain: true });
    }
    if (c.failed) {
      out.lines = [];
      const names = arr(res.available_jobs || res.jobs).map((j) => (isObj(j) ? str(j.name) : str(j))).filter(Boolean);
      if (names.length) out.lines.push(dimLine([names[0]]));
      if (!errorText(c.res) && c.out) out.raw = c.out;
    }
    return out;
  }

  H.register({ memory: memoryTool, project_memory: projectMemory, session_search: sessionSearch, skills_list: skill, skill_view: skill, skill_manage: skill, todo, todo_list: todo, ledger, cronjob, cronjob_manage: cronjob });
})();
