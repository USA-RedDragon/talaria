"use strict";
// Cards of notes: to-do list, memory, project notes, past chats, skills.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  // Hermes requires approval before it saves some notes. A result that says so, or a
  // call the page marked pending, is waiting for the user.
  const pendingWords = new Set(["pending", "pending_approval", "awaiting_approval", "approval_required", "needs_approval", "waiting_for_approval"]);

  function waiting(c) {
    if (c.pending) return true;
    const res = isObj(c.res) ? c.res : {};
    return pendingWords.has(str(res.status)) || res.pending_approval === true || res.staged === true || res.approval_pending === true || res.requires_approval === true;
  }

  function noteBlocks(ops) {
    const blocks = [];
    for (const o of ops) {
      const act = str(o.action);
      if (act === "add") blocks.push({ label: "Added note", text: str(o.content), pre: true });
      else if (act === "remove") blocks.push({ label: "Removed note", text: str(o.old_text) || str(o.content), pre: true });
      else if (act === "replace" || act === "patch") {
        blocks.push({ label: "Edited note", text: str(o.content), pre: true });
        if (o.old_text) blocks.push({ label: act === "patch" ? "Text that changed" : "Note it replaced", text: str(o.old_text), pre: true });
      }
    }
    return blocks;
  }

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

  function projectMemory(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    let ops = Array.isArray(a.operations) ? a.operations.filter(isObj) : [];
    if (!ops.length && ["add", "patch", "replace", "remove"].includes(str(a.action))) ops = [a];
    const out = { icon: "database", blocks: [] };
    const name = projectName(res, c);
    const count = (...k) => ops.filter((o) => k.includes(str(o.action))).length;
    const added = count("add");
    const edited = count("replace", "patch");
    const removed = count("remove");
    const kinds = [added, edited, removed].filter(Boolean).length;
    // Topics and path notes: the detail behind the index, and the rules for
    // one folder or file type.
    const topicOps = ops.filter((o) => /^topic_/.test(str(o.action)));
    const pathOps = ops.filter((o) => /^path_/.test(str(o.action)));
    if (ops.length && !added && !edited && !removed && (topicOps.length || pathOps.length)) {
      const o = topicOps[0] || pathOps[0];
      const act = str(o.action);
      const what = topicOps.length ? "the topic " : "the path note ";
      const id = short(str(o.topic) || str(o.path_note));
      const one = topicOps.length + pathOps.length === 1;
      const verbs = { topic_write: ["Wrote", "Writing", "write"], topic_append: ["Added to", "Adding to", "add to"], topic_patch: ["Changed", "Changing", "change"],
        topic_remove: ["Removed", "Removing", "remove"], path_write: ["Wrote", "Writing", "write"], path_remove: ["Removed", "Removing", "remove"] }[act] || ["Changed", "Changing", "change"];
      const where = name ? " in " + name : "";
      if (one && id) out.title = c.done && c.failed ? ["Could not " + verbs[2] + " " + what, { code: id }, where] : [verb(c, verbs[0], verbs[1]) + " " + what, { code: id }, where];
      else out.title = (c.done && c.failed ? "Could not change " : verb(c, "Changed ", "Changing ")) + plural(topicOps.length + pathOps.length, "topic or path note", "topics and path notes") + where;
      out.status = "Saved";
      for (const x of topicOps.concat(pathOps)) {
        const k = str(x.action);
        const label = { topic_write: "Topic written: ", topic_append: "Added to topic: ", topic_patch: "Changed topic: ", topic_remove: "Removed topic: ",
          path_write: "Path note: ", path_remove: "Removed path note: " }[k] || "Changed: ";
        const nm = str(x.topic) || str(x.path_note);
        const paths = Array.isArray(x.paths) ? " (" + x.paths.map(str).join(", ") + ")" : "";
        const text = k === "topic_patch" ? [str(x.old_text) ? "- " + str(x.old_text) : "", "+ " + str(x.content)].filter(Boolean).join("\n") : str(x.content) || str(x.description) || nm;
        out.blocks.push(k === "topic_patch" ? { label: label + nm, text, kind: "diff" } : { label: label + nm + paths, text, pre: true });
      }
      if (waiting(c)) {
        out.status = "Waiting for approval";
        out.waiting = true;
      }
      return out;
    }
    if (!ops.length) {
      out.title = verb(c, "Read", "Reading") + " the notes of " + (name || "this project");
      const list = Array.isArray(res.entries) ? res.entries : Array.isArray(res.notes) ? res.notes : null;
      out.status = list ? plural(list.length, "note") : "Done";
    } else {
      let head;
      if (kinds > 1) head = verb(c, "Changed ", "Changing ") + noteWord(ops.length) + (name ? " in " + name : "");
      else if (added) head = verb(c, "Added ", "Adding ") + noteWord(added) + (name ? " to " + name : "");
      else if (edited) head = verb(c, "Edited ", "Editing ") + noteWord(edited) + (name ? " in " + name : "");
      else head = verb(c, "Removed ", "Removing ") + noteWord(removed) + (name ? " from " + name : "");
      if (c.done && c.failed) head = head.replace(/^Added /, "Could not add ").replace(/^Edited /, "Could not edit ").replace(/^Removed /, "Could not remove ").replace(/^Changed /, "Could not change ").replace(/ (to|from|in) /, (m, w) => " " + w + " ");
      out.title = head;
      out.status = "Saved";
      out.blocks.push(...noteBlocks(ops));
    }
    if (waiting(c)) {
      out.status = "Waiting for approval";
      out.waiting = true;
    }
    if (c.out && (waiting(c) || c.failed || !ops.length)) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function memoryTool(c) {
    const a = isObj(c.args) ? c.args : {};
    const act = str(a.action);
    const user = str(a.target) === "user";
    const what = user ? "your profile" : "memory";
    const out = { icon: "database", blocks: [] };
    if (act === "add") out.title = verb(c, "Saved a note to ", "Saving a note to ") + what;
    else if (act === "remove") out.title = verb(c, "Removed a note from ", "Removing a note from ") + what;
    else if (act === "replace") out.title = verb(c, "Updated a note in ", "Updating a note in ") + what;
    else out.title = verb(c, "Used ", "Using ") + what;
    out.status = act === "add" || act === "remove" || act === "replace" ? "Saved" : "Done";
    out.blocks.push(...noteBlocks(act ? [a] : []));
    if (waiting(c)) {
      out.status = "Waiting for approval";
      out.waiting = true;
    }
    if (!out.blocks.length && Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out && (waiting(c) || c.failed || !out.blocks.length)) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function sessionSearch(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "search", blocks: [] };
    const q = short(str(a.query));
    out.title = q ? verb(c, "Searched", "Searching") + " past chats for " + q : verb(c, "Looked through", "Looking through") + " recent chats";
    const list = Array.isArray(res.results) ? res.results : Array.isArray(res.sessions) ? res.sessions : Array.isArray(res.matches) ? res.matches : null;
    out.status = list ? plural(list.length, "session") : "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function skill(c) {
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "book", blocks: [] };
    const name = str(a.name) || (Array.isArray(a.operations) && isObj(a.operations[0]) ? str(a.operations[0].name) : "");
    if (c.name === "skills_list") out.title = verb(c, "Listed", "Listing") + " skills";
    else if (c.name === "skill_view") out.title = verb(c, "Read", "Reading") + " skill" + (name ? " " + name : "");
    else out.title = verb(c, "Edited", "Editing") + " skill" + (name ? " " + name : "");
    out.status = "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function todo(c) {
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "checkcircle", blocks: [] };
    out.title = verb(c, "Updated", "Updating") + " the to-do list";
    out.status = Array.isArray(a.todos) ? plural(a.todos.length, "item") : "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }


  H.register({ memory: memoryTool, project_memory: projectMemory, session_search: sessionSearch, skills_list: skill, skill_view: skill, skill_manage: skill, todo: todo, todo_list: todo });
})();
