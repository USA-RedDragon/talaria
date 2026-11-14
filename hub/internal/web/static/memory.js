"use strict";
// HubMemory builds the Memory page: Hermes's notes (MEMORY.md), its profile
// of the user (USER.md) and what Honcho learned from the user's chats. ctx
// gives it the app's api and el helpers, the latest chat list and a way to
// open a chat.
window.HubMemory = (ctx) => {
  const { api, el } = ctx;
  const root = document.getElementById("memory");
  const nav = document.getElementById("memnav");
  const count = document.getElementById("memcount");
  const fmt = (n) => Number(n || 0).toLocaleString("en-US");
  const tabs = [
    { id: "notes", target: "memory", label: "Notes" },
    { id: "you", target: "user", label: "About you" },
    { id: "learned", label: "Learned" },
  ];
  const copy = {
    notes: "Talaria reads these notes at the start of every chat. Keep them short. Changes apply to new chats.",
    skills: "Skills that belong to this project. Talaria loads them only in chats bound to this project and in their subagents. They win over a global skill of the same name here.",
    project: "The index is what Talaria reads at the start of every chat in this project: one short line per note. Detail lives in topics; the agent reads a topic when a task calls for it. Changes apply to new chats.",
    topics: "Topics hold the detail behind the index: any number, any length. Every chat gets the list of topic names; the agent reads a topic when a task calls for it. A topic no index line points to is still listed.",
    paths: "Path notes are rules for part of the project. Talaria reads one the first time a chat opens or edits a file that matches its patterns, so they cost nothing in chats that never go there.",
    you: "What Talaria has stored about you as a person. It reads this in every chat, on every device and in Telegram. Changes apply to new chats.",
    learned: "Facts Talaria picked up from your chats over time. It looks these up when they seem relevant. Delete anything wrong or out of date.",
    help: "Talaria keeps two short files that it reads at the start of every chat: its own notes and what it has stored about you. It also learns facts from your chats over time and looks them up when they seem relevant. Here you can read, fix and delete all of it. Chats that are already open keep what they started with; changes apply to new chats.",
    full: "Almost full. Shorten or remove a line before Talaria needs room for a new one.",
    off: "This file is turned off in the agent's memory settings, so Talaria does not read it and it cannot be changed here.",
  };

  let backends = [];
  let backend = "";
  let tab = "notes";
  let shown = false;
  let notes = null;
  let notesErr = "";
  let projects = null;
  let projectsErr = "";
  let project = "";
  // psub is the part of a project in view: its index ("notes"), topics,
  // path notes ("paths") or skills.
  let psub = "notes";
  const psubs = ["notes", "topics", "paths", "skills"];
  let skills = null;
  let skillsErr = "";
  let skillsFor = "";
  let ui = { edit: null, adding: false, raw: false, confirm: null, more: null, help: false, busy: false, note: "", bad: false };
  let learned = null;

  function freshLearned() {
    return { q: "", view: "all", oldest: false, all: false, items: [], page: 0, pages: 0, total: 0, hidden: 0, partial: false, loading: false, err: "",
      sel: new Set(), confirm: false, info: null, infoErr: "", card: false, adding: false, gen: 0, armed: "" };
  }

  function setBadge() {
    const n = backends.reduce((a, b) => a + (b.pending || 0), 0);
    nav.hidden = !backends.length;
    count.hidden = !n;
    count.textContent = n ? String(n) : "";
    nav.classList.toggle("on", shown);
  }

  async function refresh() {
    try {
      backends = await api("GET", "/api/memory");
    } catch (_) {
      return;
    }
    setBadge();
  }

  function setHash() {
    let h = "#/memory/" + encodeURIComponent(backend) + "/" + tab;
    if (tab === "notes" && project) h += "/" + encodeURIComponent(project) + (psub !== "notes" ? "/" + psub : "");
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  async function show(rest) {
    shown = true;
    root.hidden = false;
    nav.classList.add("on");
    const [b, t, pr, sub] = (rest || "").split("/").map((x) => decodeURIComponent(x || ""));
    await refresh();
    if (!shown) return;
    const pick = backends.find((x) => x.id === b) || backends.find((x) => x.id === backend) ||
      backends.find((x) => x.id === ctx.defaultBackend()) || backends[0];
    if (pick && pick.id !== backend) { backend = pick.id; notes = null; learned = null; project = ""; }
    projects = null;
    tab = tabs.some((x) => x.id === t) ? t : tab;
    if (t === "notes" && (pr || "") !== project) { project = pr || ""; notes = null; skills = null; }
    psub = t === "notes" && project && psubs.includes(sub) ? sub : "notes";
    if (!tabOK(tab)) tab = tabs.find((x) => tabOK(x.id)).id;
    resetUI();
    if (backend) setHash();
    draw();
    load();
  }

  function hide() {
    shown = false;
    root.hidden = true;
    nav.classList.remove("on");
  }

  function current() { return backends.find((x) => x.id === backend); }
  function tabOK(id) {
    const b = current();
    if (!b) return id !== "learned";
    return id === "learned" ? b.learned : (b.notes || !b.learned);
  }
  function resetUI() { ui = { edit: null, adding: false, raw: false, confirm: null, more: null, help: ui.help, busy: false, note: "", bad: false }; }
  function path(p) { return "/api/memory/" + encodeURIComponent(backend) + p; }
  // scope is the path part of the notes in view: a project's, or the
  // backend's own.
  function scope() { return project ? "/projects/" + encodeURIComponent(project) : ""; }
  function projectView() { return tab === "notes" && !!project; }
  function skillsView() { return projectView() && psub === "skills"; }
  function docsView() { return projectView() && (psub === "topics" || psub === "paths"); }
  function docsPath(kind, name) { return path(scope() + "/docs/" + kind + (name ? "/" + encodeURIComponent(name) : "")); }

  async function load() {
    if (!backend) return;
    if (tab === "learned") {
      if (!learned) { learned = freshLearned(); loadFacts(true); loadInfo(); }
      return;
    }
    if (tab === "notes" && !projects) loadProjects();
    if (skillsView()) { loadSkills(); return; }
    await loadNotes();
    if (docsView() && psub === "paths") loadPathTexts();
  }

  async function loadNotes() {
    const b = backend;
    const pr = tab === "notes" ? project : "";
    try {
      const n = await api("GET", path((pr ? scope() : "") + "/notes"));
      if (b !== backend || pr !== (tab === "notes" ? project : "")) return;
      notes = n;
      notesErr = "";
      countPending();
    } catch (e) {
      if (b !== backend || pr !== (tab === "notes" ? project : "")) return;
      notesErr = e.message;
    }
    if (shown) draw();
  }

  // loadProjects lists the backend's projects. A Hermes without the
  // project-memory plugin answers 404, and the picker stays hidden.
  async function loadProjects() {
    const b = backend;
    projects = [];
    projectsErr = "";
    try {
      const l = await api("GET", path("/projects"));
      if (b !== backend) return;
      projects = l;
    } catch (e) {
      if (b !== backend) return;
      if (e.status !== 404) projectsErr = e.message;
    }
    if (project && !projectsErr && !projects.some((x) => x.id === project)) {
      project = "";
      psub = "notes";
      skills = null;
      notes = null;
      resetUI();
      if (tab === "notes") { setHash(); loadNotes(); }
    }
    if (shown) draw();
  }

  function countPending() {
    const b = current();
    if (b && notes && !notes.project) { b.pending = notes.pending.length; setBadge(); }
  }

  // change runs one change and redraws with the answer, or shows why not.
  async function change(method, p, body, after) {
    if (ui.busy) return;
    ui.busy = true;
    ui.note = "";
    draw();
    const at = backend + "/" + project;
    try {
      const n = await api(method, path((notes && notes.project ? scope() : "") + p), body);
      if (at !== backend + "/" + project) return;
      notes = n;
      if (n.project && projects) projects = projects.map((x) => (x.id === n.project.id ? n.project : x));
      countPending();
      if (after) after();
      if (n.message) { ui.note = n.message; ui.bad = false; }
    } catch (e) {
      ui.note = e.message;
      ui.bad = true;
    } finally {
      ui.busy = false;
    }
    draw();
  }

  function btn(cls, text, onclick, label) {
    const b = el("button", cls, text);
    b.type = "button";
    if (label) b.setAttribute("aria-label", label);
    b.onclick = onclick;
    b.disabled = ui.busy;
    return b;
  }

  function draw() {
    if (!shown) return;
    const head = el("div", "mem-head");
    if (backends.length > 1) {
      const sel = el("select", "mem-backend");
      sel.setAttribute("aria-label", "Agent server");
      for (const b of backends) {
        const o = el("option", "", b.name);
        o.value = b.id;
        o.selected = b.id === backend;
        sel.append(o);
      }
      sel.onchange = () => { backend = sel.value; notes = null; learned = null; projects = null; project = ""; skills = null; psub = "notes"; resetUI(); if (!tabOK(tab)) tab = tabs.find((x) => tabOK(x.id)).id; setHash(); draw(); load(); };
      head.append(sel);
    }
    head.append(el("span", "grow"));
    head.append(btn("ghost", "What is this?", () => { ui.help = !ui.help; draw(); }));
    const bar = el("div", "mem-tabs");
    bar.setAttribute("role", "tablist");
    for (const x of tabs) {
      if (!tabOK(x.id)) continue;
      const b = el("button", "mem-tab", x.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", x.id === tab ? "true" : "false");
      if (x.id === "learned" && learned && learned.info) b.append(" ", el("span", "mem-n", "(" + fmt(learned.info.total) + ")"));
      b.onclick = () => { if (tab === x.id) return; if (project && (tab === "notes" || x.id === "notes")) { notes = null; skills = null; } tab = x.id; resetUI(); setHash(); draw(); load(); };
      bar.append(b);
    }
    const body = el("div", "mem-body");
    body.setAttribute("role", "tabpanel");
    if (ui.help) body.append(el("p", "mem-hint", copy.help));
    if (!backend) {
      body.append(el("p", "mem-hint", "None of your agent servers has memory the hub can show."));
    } else if (tab === "learned") {
      drawLearned(body);
    } else {
      drawNotes(body, tabs.find((x) => x.id === tab));
    }
    const scroll = root.querySelector(".mem-body");
    const top = scroll ? scroll.scrollTop : 0;
    const act = document.activeElement;
    const key = act && root.contains(act) ? act.dataset.k : "";
    const range = key && "selectionStart" in act ? [act.selectionStart, act.selectionEnd] : null;
    root.replaceChildren(head, bar, body);
    body.scrollTop = top;
    const again = key && root.querySelector('[data-k="' + key + '"]');
    if (again) {
      again.focus({ preventScroll: true });
      if (range) { try { again.setSelectionRange(range[0], range[1]); } catch (_) { /* not a text field */ } }
    }
  }

  function status(body) {
    if (ui.note) {
      const p = el("p", ui.bad ? "mem-note bad" : "mem-note", ui.note);
      p.setAttribute("role", ui.bad ? "alert" : "status");
      body.append(p);
    }
  }

  function meter(store, label, warnAt) {
    label = label || "Space used";
    const pct = store.limit > 0 ? Math.min(100, Math.round((store.used / store.limit) * 100)) : 0;
    const m = el("div", pct >= (warnAt || 85) ? "mem-meter warn" : "mem-meter");
    const row = el("div", "row");
    row.append(el("span", "", label), el("span", "", fmt(store.used) + " / " + fmt(store.limit) + " characters"));
    const track = el("div", "track");
    const fill = el("div", "fill");
    fill.style.width = pct + "%";
    track.append(fill);
    track.setAttribute("role", "meter");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(store.limit));
    track.setAttribute("aria-valuenow", String(store.used));
    track.setAttribute("aria-label", label);
    m.append(row, track);
    return { m, pct };
  }

  function drawNotes(body, t) {
    if (t.id === "notes") projectPicker(body);
    if (skillsView()) { drawSkills(body); return; }
    if (docsView()) { drawDocs(body); return; }
    const inProject = projectView();
    body.append(el("p", "mem-hint", copy[inProject ? "project" : t.id]));
    if (!notes) {
      body.append(el("p", notesErr ? "mem-note bad" : "mem-hint", notesErr ? "Could not load memory: " + notesErr : "Loading."));
      return;
    }
    const store = notes.targets[t.target];
    if (!store.enabled) body.append(el("p", "mem-note", copy.off));
    const { m, pct } = inProject ? meter(store, "Index space", 80) : meter(store);
    body.append(m);
    if (inProject) indexNotes(body, store, pct);
    status(body);
    const list = el("div", "mem-entries");
    for (const p of notes.pending.filter((x) => x.target === t.target)) list.append(pendingRow(p));
    if (!store.enabled) {
      store.entries.forEach((text) => { const row = el("div", "mem-entry"); row.append(el("div", "mem-text", text)); list.append(row); });
    } else if (ui.raw) {
      list.append(rawEditor(t, store));
    } else {
      store.entries.forEach((text) => list.append(entryRow(t, store, text)));
      if (ui.adding) list.append(editor(t, store, "", null));
      if (!store.entries.length && !ui.adding && !notes.pending.some((x) => x.target === t.target)) {
        list.append(el("p", "mem-hint", t.id === "you" ? "Nothing is stored about you yet." : inProject ? "Talaria has no notes for this project yet." : "Talaria has no notes yet."));
      }
    }
    body.append(list);
    if (store.enabled && !ui.raw && !ui.adding) {
      const acts = el("div", "mem-acts");
      acts.append(btn("", t.id === "you" || inProject ? "Add a line" : "Add a note", () => { ui.adding = true; ui.edit = null; ui.note = ""; draw(); focusEditor(); }));
      body.append(acts);
    }
    if (store.enabled && pct >= 90 && !inProject) body.append(el("p", "mem-hint", copy.full));
    if (store.enabled) body.append(advancedNotes(t, store));
  }

  // projectPicker shows the project select on the Notes tab, and what the
  // chosen project is known as and where Talaria saw it.
  function projectPicker(body) {
    if (projectsErr) body.append(el("p", "mem-note bad", "Could not load the projects: " + projectsErr));
    if (!projects || (!projects.length && !project)) return;
    const box = el("div", "mem-proj");
    const sel = el("select");
    sel.setAttribute("aria-label", "Project");
    sel.dataset.k = "project";
    sel.disabled = ui.busy;
    const g = el("option", "", "Global notes");
    g.value = "";
    sel.append(g);
    for (const x of projects) {
      const o = el("option", "", x.name && x.name !== x.identity ? x.name + " (" + x.identity + ")" : x.identity);
      o.value = x.id;
      sel.append(o);
    }
    sel.value = project;
    sel.onchange = () => { project = sel.value; notes = null; notesErr = ""; skills = null; psub = "notes"; resetUI(); setHash(); draw(); loadNotes(); };
    box.append(sel);
    const cur = projects.find((x) => x.id === project);
    if (cur) {
      const dl = el("dl");
      const add = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
      add("Project", cur.identity);
      const many = (k, lines) => {
        if (!lines.length) return;
        const dd = el("dd");
        for (const l of lines) dd.append(el("div", "", l));
        dl.append(el("dt", "", k), dd);
      };
      many("Also known as", cur.aliases);
      many("Seen in", cur.folders.map((f) => {
        const when = f.seen_at ? day(f.seen_at * 1000) : "";
        return (f.device || f.device_id) + ": " + f.dir + (when ? " (" + when + ")" : "");
      }));
      box.append(dl);
      box.append(subTabs(cur));
    }
    body.append(box);
  }

  // subTabs switches a project between its notes and its skills.
  function subTabs(cur) {
    const bar = el("div", "mem-subtabs");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Part of the project");
    const nSkills = skills && skillsFor === backend + "/" + project ? skills.length : cur.skills || 0;
    const mine = notes && notes.project && notes.project.id === project;
    const nNotes = mine ? notes.targets.memory.entries.length : cur.count || 0;
    const nTopics = mine ? (notes.topics || []).length : cur.topics || 0;
    const nPaths = mine ? (notes.path_notes || []).length : cur.path_notes || 0;
    for (const [id, label, n] of [["notes", "Index", nNotes], ["topics", "Topics", nTopics], ["paths", "Path notes", nPaths], ["skills", "Skills", nSkills]]) {
      const b = el("button", "mem-subtab", label);
      b.type = "button";
      b.dataset.k = "sub-" + id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", psub === id ? "true" : "false");
      b.append(" ", el("span", "mem-n", "(" + fmt(n) + ")"));
      b.onclick = () => {
        if (psub === id) return;
        psub = id;
        resetUI();
        setHash();
        draw();
        if (id === "skills") loadSkills();
        else if (!notes) load();
        else if (id === "paths") loadPathTexts();
      };
      bar.append(b);
    }
    return bar;
  }

  // pointerOf splits an index line that points to a topic, as the plugin
  // writes it ("<summary> -> topic: <name>"), into its text and the topic.
  function pointerOf(text) {
    const m = /^([\s\S]*?)\s*->\s*topic:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/.exec(text);
    return m ? { line: m[1], topic: m[2] } : null;
  }

  function openTopic(name) {
    psub = "topics";
    resetUI();
    ui.open = name;
    setHash();
    draw();
    viewDoc("topics", name, true);
  }

  // indexNotes shows, under the index's meter, the size of the whole
  // project, the 80% warning and how many notes wait in the inbox topic.
  function indexNotes(body, store, pct) {
    const p = notes.project || {};
    const nt = (notes.topics || []).length, np = (notes.path_notes || []).length;
    const total = p.total || store.used;
    body.append(el("div", "mem-total", "Whole project: " + fmt(total) + " characters across the index, " + fmt(nt) + (nt === 1 ? " topic" : " topics") +
      " and " + fmt(np) + (np === 1 ? " path note" : " path notes") + ". Only the index has a limit."));
    if (pct >= 80) body.append(el("p", "mem-note", "The index is " + pct + "% full. When it fills, Talaria keeps saving: it moves the detail into a topic and leaves a one-line pointer here."));
    if (notes.inbox) body.append(el("p", "mem-note", "The inbox topic holds " + fmt(notes.inbox) + (notes.inbox === 1 ? " note" : " notes") + " saved while the index was full. Sort them into topics."));
  }

  // Topics and path notes. ui.open is the topic shown in place, ui.docEdit
  // the one in the editor ("" for a new one), ui.docs their texts by kind/name.
  function docList(kind) { return (kind === "topics" ? notes.topics : notes.path_notes) || []; }

  function setDocList(kind, list) {
    if (kind === "topics") notes.topics = list; else notes.path_notes = list;
    if (projects) projects = projects.map((x) => (x.id === project ? { ...x, [kind === "topics" ? "topics" : "path_notes"]: list.length } : x));
  }

  async function viewDoc(kind, name, keep) {
    ui.docs = ui.docs || {};
    const key = kind + "/" + name;
    if (keep && ui.docs[key] && !ui.docs[key].err) return ui.docs[key];
    const at = backend + "/" + project;
    const docs = ui.docs;
    try {
      docs[key] = await api("GET", docsPath(kind, name));
    } catch (e) {
      docs[key] = { err: e.message };
    }
    if (at === backend + "/" + project && shown) draw();
    return docs[key];
  }

  // loadPathTexts reads the text of every path note, which the list shows.
  async function loadPathTexts() {
    if (!notes || !notes.project) return;
    ui.docs = ui.docs || {};
    const missing = (notes.path_notes || []).filter((d) => !ui.docs["paths/" + d.name]).slice(0, 50);
    await Promise.all(missing.map((d) => viewDoc("paths", d.name, true)));
  }

  function drawDocs(body) {
    const kind = psub;
    body.append(el("p", "mem-hint", copy[kind]));
    if (!notes) {
      body.append(el("p", notesErr ? "mem-note bad" : "mem-hint", notesErr ? "Could not load memory: " + notesErr : "Loading."));
      return;
    }
    status(body);
    const acts = el("div", "mem-acts");
    if (kind === "topics") {
      const s = el("input");
      s.type = "search";
      s.placeholder = "Search topics";
      s.setAttribute("aria-label", "Search topics");
      s.dataset.k = "topic-search";
      s.value = ui.q || "";
      s.oninput = () => { ui.q = s.value; draw(); };
      acts.append(s);
    }
    acts.append(btn("", kind === "topics" ? "New topic" : "New path note", () => { ui.docEdit = ""; ui.confirm = null; ui.note = ""; draw(); focusDoc(); }));
    body.append(acts);
    const list = el("div", "mem-skills");
    if (ui.docEdit === "") list.append(docForm(kind, null));
    const q = (ui.q || "").trim().toLowerCase();
    const items = docList(kind).filter((d) => kind !== "topics" || !q || (d.name + " " + d.description).toLowerCase().includes(q));
    for (const d of items) list.append(ui.docEdit === d.name ? docForm(kind, d) : docRow(kind, d));
    if (!items.length && ui.docEdit !== "") {
      list.append(el("p", "mem-hint", q ? "No topic matches." : kind === "topics" ? "This project has no topics yet." : "This project has no path notes yet."));
    }
    body.append(list);
  }

  function docRow(kind, d) {
    const key = kind + "/" + d.name;
    const open = kind === "paths" || ui.open === d.name;
    const row = el("div", "mem-skill" + (open ? " open" : ""));
    row.dataset.doc = d.name;
    const top = el("div", "mem-skill-top doc");
    top.append(el("span", "mem-skill-name", d.name));
    if (kind === "topics") {
      if (d.name === "inbox") top.append(el("span", "mem-pill warn", "unsorted"));
      else if (!d.in_index) top.append(el("span", "mem-pill", "not in the index"));
    }
    top.append(el("span", "grow"));
    const acts = el("span", "mem-skill-acts");
    if (ui.confirm === key) {
      top.classList.add("asking");
      acts.append(el("span", "mem-ask", kind === "topics" ? "Delete this topic? Index lines that point to it stay." : "Delete this path note?"),
        btn("ghost", "Cancel", () => { ui.confirm = null; draw(); }), btn("danger", "Delete", () => deleteDoc(kind, d.name)));
    } else {
      if (kind === "topics") {
        const v = btn("", open ? "Hide" : "Open", () => { ui.open = open ? null : d.name; draw(); if (!open) viewDoc(kind, d.name, true); });
        v.setAttribute("aria-expanded", open ? "true" : "false");
        acts.append(v);
      }
      acts.append(btn("", "Edit", () => editDoc(kind, d.name)), btn("ghost danger-text", "Delete", () => { ui.confirm = key; draw(); }));
    }
    top.append(acts);
    row.append(top);
    if (kind === "topics" && d.description) row.append(el("div", "mem-skill-desc", d.description));
    const meta = el("div", "mem-skill-meta");
    for (const g of d.paths || []) meta.append(el("span", "mem-pill glob", g));
    meta.append(el("span", "", fmt(d.size) + " characters"));
    if (d.modified) meta.append(el("span", "", "changed " + day(d.modified + "T12:00:00")));
    row.append(meta);
    const doc = ui.docs && ui.docs[key];
    if (kind === "paths") {
      if (doc && !doc.err) row.append(el("div", "mem-skill-desc", doc.content));
      else if (doc && doc.err) row.append(el("p", "mem-note bad", "Could not read it: " + doc.err));
    } else if (open) {
      if (!doc) row.append(el("p", "mem-hint", "Loading."));
      else if (doc.err) row.append(el("p", "mem-note bad", "Could not read the topic: " + doc.err));
      else {
        const pre = el("pre", "mem-skill-text", doc.content);
        pre.tabIndex = 0;
        pre.setAttribute("aria-label", "Topic " + d.name);
        row.append(pre);
        if (doc.truncated) row.append(el("p", "mem-hint", "The text is cut here. The topic is longer."));
      }
    }
    return row;
  }

  async function editDoc(kind, name) {
    ui.docEdit = name;
    ui.confirm = null;
    ui.note = "";
    ui.draftDoc = null;
    draw();
    const d = await viewDoc(kind, name, false);
    if (d && d.err) { ui.docEdit = null; ui.note = d.err; ui.bad = true; }
    draw();
    focusDoc();
  }

  function focusDoc() {
    const f = root.querySelector('.mem-form [data-k="doc-text"]');
    if (f && !f.disabled) f.focus({ preventScroll: true });
  }

  // docForm edits a topic (name, description, text) or a path note (name,
  // patterns, text). d is null for a new one.
  function docForm(kind, d) {
    const row = el("div", "mem-skill open");
    row.append(el("div", "mem-skill-name", d ? "Edit " + d.name : kind === "topics" ? "New topic" : "New path note"));
    const doc = d ? ui.docs && ui.docs[kind + "/" + d.name] : { content: "", description: "", paths: [] };
    const f = el("div", "mem-form");
    if (!doc) { f.append(el("p", "mem-hint", "Loading.")); row.append(f); return row; }
    const draft = ui.draftDoc && ui.draftDoc.for === kind + "/" + (d ? d.name : "") ? ui.draftDoc : null;
    const field = (label, input) => { const l = el("label", "", label); l.append(input); f.append(l); return input; };
    const n = el("input");
    n.value = draft ? draft.name : d ? d.name : "";
    n.placeholder = "a-short-name";
    n.dataset.k = "doc-name";
    field("Name", n);
    let desc = null, pats = null;
    if (kind === "topics") {
      desc = el("input");
      desc.value = draft ? draft.desc : doc.description || "";
      desc.placeholder = "One line: what is in it";
      desc.dataset.k = "doc-desc";
      field("Description", desc);
    } else {
      pats = el("input");
      pats.value = draft ? draft.pats : (doc.paths || []).join(", ");
      pats.placeholder = "src/ppu/**, *.sql";
      pats.dataset.k = "doc-paths";
      field("Files it applies to (patterns relative to the repository, comma separated)", pats);
    }
    const ta = el("textarea", kind === "paths" ? "short" : "");
    ta.value = draft ? draft.text : doc.content || "";
    ta.placeholder = "Markdown. No length limit.";
    ta.dataset.k = "doc-text";
    field("Text", ta);
    const keep = () => { ui.draftDoc = { for: kind + "/" + (d ? d.name : ""), name: n.value, desc: desc ? desc.value : "", pats: pats ? pats.value : "", text: ta.value }; };
    for (const x of [n, desc, pats, ta]) if (x) x.oninput = keep;
    const done = () => { ui.docEdit = null; ui.draftDoc = null; };
    const save = () => saveDoc(kind, d, doc, n.value.trim(), desc ? desc.value : null, pats ? pats.value : null, ta.value, done);
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.stopPropagation(); done(); draw(); }
    };
    const er = el("div", "mem-editrow");
    er.append(el("span", "", d ? fmt(d.size) + " characters" : "Ctrl+Enter saves"), btn("ghost", "Cancel", () => { done(); draw(); }), btn("primary", "Save", save));
    f.append(er);
    row.append(f);
    return row;
  }

  async function saveDoc(kind, d, doc, name, desc, pats, text, done) {
    if (ui.busy) return;
    if (!name || !text.trim()) { ui.note = !name ? "Give it a name." : "The text is empty."; ui.bad = true; draw(); return; }
    const body = { content: text };
    if (desc !== null) body.description = desc;
    if (pats !== null) body.paths = pats.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    let target = name;
    if (d) { target = d.name; body.base = doc.content; if (name !== d.name) body.name = name; } else body.create = true;
    ui.busy = true;
    ui.note = "";
    draw();
    const at = backend + "/" + project;
    try {
      const out = await api("PUT", docsPath(kind, target), body);
      if (at !== backend + "/" + project) return;
      setDocList(kind, out.list || docList(kind));
      ui.docs = ui.docs || {};
      if (d) delete ui.docs[kind + "/" + d.name];
      ui.docs[kind + "/" + out.name] = out;
      if (kind === "topics") ui.open = out.name;
      done();
      ui.note = (kind === "topics" ? "Topic " : "Path note ") + out.name + " is saved. Changes apply to new chats.";
      ui.bad = false;
    } catch (e) {
      ui.note = e.message;
      ui.bad = true;
    } finally {
      ui.busy = false;
    }
    draw();
  }

  async function deleteDoc(kind, name) {
    if (ui.busy) return;
    ui.busy = true;
    ui.note = "";
    draw();
    const at = backend + "/" + project;
    try {
      const out = await api("DELETE", docsPath(kind, name));
      if (at !== backend + "/" + project) return;
      setDocList(kind, out.items);
      if (kind === "topics") notes.inbox = out.inbox;
      ui.confirm = null;
      if (ui.open === name) ui.open = null;
      if (ui.docs) delete ui.docs[kind + "/" + name];
      ui.note = name + " is deleted.";
      ui.bad = false;
    } catch (e) {
      ui.note = e.message;
      ui.bad = true;
    } finally {
      ui.busy = false;
    }
    draw();
  }

  // loadSkills reads the skills of the project in view.
  async function loadSkills() {
    const at = backend + "/" + project;
    if (!project || (skills && skillsFor === at)) return;
    skills = null;
    skillsErr = "";
    try {
      const l = await api("GET", path("/projects/" + encodeURIComponent(project) + "/skills"));
      if (at !== backend + "/" + project) return;
      skills = l.skills;
      skillsFor = at;
      syncSkillCount();
    } catch (e) {
      if (at !== backend + "/" + project) return;
      skillsErr = e.message;
    }
    if (shown) draw();
  }

  // syncSkillCount keeps the project list's count in step with the skills read.
  function syncSkillCount() {
    if (projects) projects = projects.map((x) => (x.id === project ? { ...x, skills: skills.length } : x));
  }

  // drawSkills lists the project's skills: name, where it lives, what it is
  // for, and View and Delete. View reads the SKILL.md in place; Delete asks first.
  function drawSkills(body) {
    body.append(el("p", "mem-hint", copy.skills));
    status(body);
    if (!skills || skillsFor !== backend + "/" + project) {
      body.append(el("p", skillsErr ? "mem-note bad" : "mem-hint", skillsErr ? "Could not load the skills: " + skillsErr : "Loading."));
      return;
    }
    const list = el("div", "mem-skills");
    for (const s of skills) list.append(skillRow(s));
    if (!skills.length) list.append(el("p", "mem-hint", "This project has no skills yet."));
    body.append(list);
  }

  function skillRow(s) {
    const row = el("div", "mem-skill");
    row.dataset.skill = s.name;
    const top = el("div", "mem-skill-top");
    top.append(el("span", "mem-skill-name", s.name), el("span", "mem-pill proj", "project"));
    if (!s.enabled) top.append(el("span", "mem-pill", "off"));
    top.append(el("span", "grow"));
    const acts = el("span", "mem-skill-acts");
    if (ui.confirm === s.name) {
      top.classList.add("asking");
      acts.append(el("span", "mem-ask", "Delete this skill?"), btn("ghost", "Cancel", () => { ui.confirm = null; draw(); }),
        btn("danger", "Delete", () => deleteSkill(s)));
    } else {
      const open = ui.viewing === s.name;
      const v = btn("", open ? "Hide" : "View", () => viewSkill(s));
      v.setAttribute("aria-expanded", open ? "true" : "false");
      acts.append(v, btn("ghost danger-text", "Delete", () => { ui.confirm = s.name; draw(); }));
    }
    top.append(acts);
    row.append(top);
    if (s.description) row.append(el("div", "mem-skill-desc", s.description));
    if (ui.viewing === s.name) row.append(skillDoc(s));
    return row;
  }

  function skillDoc(s) {
    const box = el("div", "mem-skill-doc");
    const d = ui.docs && ui.docs[s.name];
    if (!d) {
      box.append(el("p", "mem-hint", "Loading."));
    } else if (d.err) {
      box.append(el("p", "mem-note bad", "Could not read the skill: " + d.err));
    } else {
      const pre = el("pre", "mem-skill-text", d.content);
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "SKILL.md of " + s.name);
      box.append(pre);
      if (d.truncated) box.append(el("p", "mem-hint", "The text is cut here. The skill is longer."));
      if (d.files && d.files.length) box.append(el("p", "mem-hint", "Also in its folder: " + d.files.join(", ")));
    }
    return box;
  }

  async function viewSkill(s) {
    if (ui.viewing === s.name) { ui.viewing = null; draw(); return; }
    ui.viewing = s.name;
    ui.docs = ui.docs || {};
    draw();
    if (ui.docs[s.name] && !ui.docs[s.name].err) return;
    const at = backend + "/" + project;
    const docs = ui.docs;
    try {
      docs[s.name] = await api("GET", path("/projects/" + encodeURIComponent(project) + "/skills/" + encodeURIComponent(s.name)));
    } catch (e) {
      docs[s.name] = { err: e.message };
    }
    if (at === backend + "/" + project && shown) draw();
  }

  async function deleteSkill(s) {
    if (ui.busy) return;
    ui.busy = true;
    ui.note = "";
    draw();
    const at = backend + "/" + project;
    try {
      const l = await api("DELETE", path("/projects/" + encodeURIComponent(project) + "/skills/" + encodeURIComponent(s.name)));
      if (at !== backend + "/" + project) return;
      skills = l.skills;
      skillsFor = at;
      syncSkillCount();
      ui.confirm = null;
      if (ui.viewing === s.name) ui.viewing = null;
      ui.note = s.name + " is deleted. Chats that are already open lose it from their next message.";
      ui.bad = false;
    } catch (e) {
      ui.note = e.message;
      ui.bad = true;
    } finally {
      ui.busy = false;
    }
    draw();
  }

  function changeWord(c) {
    return { add: "add", replace: "replace", patch: "change", remove: "delete" }[c.action] || c.action;
  }

  function pendingRow(p) {
    const row = el("div", "mem-entry pending");
    const text = el("div", "mem-text");
    if (p.project) text.append(el("div", "who", "In the notes of project " + p.project));
    for (const c of p.changes) {
      text.append(el("div", "who", "Pending change: " + changeWord(c)));
      if (c.action === "remove") {
        text.append(el("div", "", c.entry || c.old_text));
      } else if (c.action === "add") {
        text.append(el("div", "", c.content));
      } else {
        if (c.entry) text.append(el("div", "was", c.entry));
        text.append(el("div", "", c.action === "patch" ? "“" + c.old_text + "” becomes “" + c.content + "”" : c.content));
      }
    }
    if (!p.changes.length) text.append(el("div", "", p.summary));
    const acts = el("div", "mem-entry-acts");
    acts.append(btn("", "Reject", () => change("POST", "/pending/" + encodeURIComponent(p.id) + "/reject")),
      btn("primary", "Approve", () => change("POST", "/pending/" + encodeURIComponent(p.id) + "/approve")));
    row.append(text, acts);
    return row;
  }

  function entryRow(t, store, text) {
    if (ui.edit === text) return editor(t, store, text, text);
    const row = el("div", "mem-entry");
    if (ui.more === text) row.classList.add("open");
    const ptr = notes.project ? pointerOf(text) : null;
    const txt = el("div", "mem-text", ptr ? ptr.line + " " : text);
    if (ptr) {
      const a = el("a", "mem-link", "Topic: " + ptr.topic);
      a.href = "#/memory/" + encodeURIComponent(backend) + "/notes/" + encodeURIComponent(project) + "/topics";
      a.onclick = (e) => { e.preventDefault(); openTopic(ptr.topic); };
      txt.append(a);
    }
    row.append(txt);
    const acts = el("div", "mem-entry-acts");
    if (ui.confirm === text) {
      acts.append(el("span", "mem-ask", notes.project ? "Delete this line?" : "Delete this note?"), btn("ghost", "Cancel", () => { ui.confirm = null; draw(); }),
        btn("danger", "Delete", () => change("POST", "/notes/" + t.target + "/remove", { entry: text }, () => { ui.confirm = null; })));
    } else {
      acts.append(btn("ghost mem-more", "⋯", () => { ui.more = ui.more === text ? null : text; draw(); }, "More"),
        btn("ghost wide", "Edit", () => { ui.edit = text; ui.adding = false; ui.note = ""; draw(); focusEditor(); }),
        btn("ghost danger-text wide", "Delete", () => { ui.confirm = text; draw(); }));
    }
    row.append(acts);
    return row;
  }

  function focusEditor() {
    const ta = root.querySelector(".mem-entry.editing textarea");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function editor(t, store, initial, entry) {
    const row = el("div", "mem-entry editing");
    const ta = el("textarea");
    ta.value = ui.draft !== undefined && ui.draftFor === entry ? ui.draft : initial;
    ta.setAttribute("aria-label", entry === null ? "New note" : "Edit note");
    ta.dataset.k = "note";
    const n = el("span", "", "");
    const room = () => store.limit - store.used + (entry !== null ? entry.length : store.entries.length ? -3 : 0);
    const tell = () => {
      if (notes.project) {
        // A project's index never refuses a line: when it is full, the detail moves into a topic.
        n.textContent = fmt(ta.value.trim().length) + " characters. Keep index lines short; put detail in a topic.";
        return;
      }
      const left = room() - ta.value.trim().length;
      n.textContent = fmt(ta.value.trim().length) + " characters" + (left < 0 ? ", " + fmt(-left) + " over the limit" : "");
      n.classList.toggle("bad", left < 0);
    };
    ta.oninput = () => { ui.draft = ta.value; ui.draftFor = entry; tell(); };
    tell();
    const done = () => { ui.edit = null; ui.adding = false; ui.draft = undefined; };
    const save = () => {
      const v = ta.value.trim();
      if (!v) return;
      if (entry === null) change("POST", "/notes/" + t.target + "/add", { content: v }, done);
      else change("POST", "/notes/" + t.target + "/edit", { entry, content: v }, done);
    };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
      if (e.key === "Escape") { e.stopPropagation(); done(); draw(); }
    };
    const er = el("div", "mem-editrow");
    er.append(n, btn("ghost", "Cancel", () => { done(); draw(); }), btn("primary", "Save", save));
    row.append(ta, er);
    return row;
  }

  function rawEditor(t, store) {
    const row = el("div", "mem-entry editing raw");
    const ta = el("textarea");
    const base = ui.rawBase || store.entries.slice();
    ta.value = ui.draft !== undefined && ui.draftFor === "raw" ? ui.draft : base.join("\n§\n");
    ta.setAttribute("aria-label", "Edit " + (t.target === "user" ? "USER.md" : "MEMORY.md"));
    ta.dataset.k = "raw";
    ta.rows = Math.min(24, Math.max(8, store.entries.length * 3));
    ta.oninput = () => { ui.draft = ta.value; ui.draftFor = "raw"; };
    const er = el("div", "mem-editrow");
    const done = () => { ui.raw = false; ui.rawBase = null; ui.draft = undefined; };
    er.append(el("span", "", "Put a line with only § between notes."), btn("ghost", "Cancel", () => { done(); draw(); }),
      btn("primary", "Save", () => change("POST", "/notes/" + t.target + "/replace", { content: ta.value, base }, done)));
    row.append(ta, er);
    return row;
  }

  function advancedNotes(t, store) {
    const d = el("details", "mem-adv");
    d.open = !!ui.advOpen;
    d.ontoggle = () => { ui.advOpen = d.open; };
    d.append(el("summary", "", "Advanced"));
    const dl = el("dl");
    const add = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
    const inProject = !!notes.project;
    add("File", store.file);
    if (!inProject) add("Ask before Talaria saves", (notes.approval ? "On" : "Off"));
    add("Limit", fmt(store.limit) + " characters");
    d.append(dl);
    const acts = el("div", "mem-acts");
    if (!ui.raw) acts.append(btn("", "Edit as one text file", () => { ui.raw = true; ui.rawBase = store.entries.slice(); ui.edit = null; ui.adding = false; ui.note = ""; draw(); }));
    if (!inProject) {
      acts.append(btn("", notes.approval ? "Turn off approval" : "Turn on approval",
        () => change("POST", "/approval", { enabled: !notes.approval })));
    }
    d.append(acts);
    if (!inProject && notes.approval) d.append(el("p", "mem-hint", "Talaria asks before it saves a note. Its proposed notes wait here, and the sidebar shows a count."));
    return d;
  }

  // Learned facts. kinds names each Honcho level for the page.
  const kinds = {
    explicit: ["From one message", "Taken straight from one message."],
    deductive: ["Deduced", "Honcho worked this out from other facts."],
    inductive: ["Pattern", "Honcho saw this pattern across several facts."],
    contradiction: ["Conflict", "Honcho found facts that disagree."],
  };

  function day(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    const o = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) o.year = "numeric";
    return d.toLocaleDateString("en-US", o);
  }

  function chatTitle(sid) {
    const l = ctx.sessions();
    const s = l && l.sessions.find((x) => x.backend_id === backend && x.id === sid);
    return s ? (s.title || "Untitled chat") : "";
  }

  async function loadFacts(reset) {
    const L = learned;
    if (reset) { L.items = []; L.page = 0; L.pages = 0; L.sel.clear(); L.confirm = false; L.armed = ""; }
    const gen = ++L.gen;
    L.loading = true;
    L.err = "";
    draw();
    const q = new URLSearchParams({ view: L.view, page: String(L.page + 1), order: L.oldest ? "oldest" : "newest" });
    if (L.q.trim()) q.set("q", L.q.trim());
    if (L.all) q.set("show", "all");
    try {
      const p = await api("GET", path("/learned?" + q));
      if (gen !== L.gen || L !== learned) return;
      let items = p.items;
      if (L.q.trim() && !L.oldest) items = items.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const have = new Set(L.items.map((c) => c.id));
      L.items = L.items.concat(items.filter((c) => !have.has(c.id)));
      L.page = p.page;
      L.pages = p.pages;
      L.total = p.total;
      L.hidden = p.hidden;
      L.partial = !!p.partial;
    } catch (e) {
      if (gen !== L.gen || L !== learned) return;
      L.err = e.message;
    }
    L.loading = false;
    draw();
  }

  async function loadInfo() {
    const L = learned;
    try {
      const info = await api("GET", path("/learned/info"));
      if (L !== learned) return;
      L.info = info;
      L.infoErr = "";
    } catch (e) {
      if (L !== learned) return;
      L.infoErr = e.message;
    }
    draw();
  }

  let searchTimer = 0;
  function drawLearned(body) {
    body.append(el("p", "mem-hint", copy.learned));
    const L = learned;
    if (!L) {
      body.append(el("p", "mem-hint", "Loading."));
      return;
    }
    const f = el("div", "mem-filters");
    const s = el("input");
    s.type = "search";
    s.dataset.k = "search";
    s.placeholder = "Search what Talaria learned";
    s.setAttribute("aria-label", "Search learned facts");
    s.value = L.q;
    s.oninput = () => {
      L.q = s.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (L === learned) loadFacts(true); }, 400);
    };
    const chip = (text, on, onclick) => {
      const c = el("button", on ? "mem-chip on" : "mem-chip", text);
      c.type = "button";
      c.setAttribute("aria-pressed", on ? "true" : "false");
      c.onclick = onclick;
      return c;
    };
    f.append(s,
      chip("Newest first", !L.oldest, () => { L.oldest = !L.oldest; loadFacts(true); }),
      chip("Talaria's view", L.view === "hermes", () => { L.view = L.view === "hermes" ? "all" : "hermes"; loadFacts(true); }),
      chip("Your own words", L.view === "self", () => { L.view = L.view === "self" ? "all" : "self"; loadFacts(true); }),
      chip("Show all", L.all, () => { L.all = !L.all; loadFacts(true); }));
    body.append(f);
    if (!L.all && L.hidden && !L.q.trim()) {
      body.append(el("p", "mem-hint", fmt(L.hidden) + (L.hidden === 1 ? " fact taken from a single message is" : " facts taken from single messages are") + " hidden. Show all brings them back."));
    }
    if (L.partial) body.append(el("p", "mem-hint", "Honcho stores more than 10,000 copies. Only the newest 10,000 show here."));
    status(body);
    if (L.sel.size) body.append(selBar(L));
    if (L.err) body.append(el("p", "mem-note bad", "Could not load what Talaria learned: " + L.err));
    if (L.items.length) {
      const list = el("div", "mem-facts");
      for (const c of L.items) list.append(factRow(L, c));
      body.append(list);
    } else if (!L.loading && !L.err) {
      if (L.q.trim()) {
        body.append(el("p", "mem-hint", L.all ? "Nothing matches that search." : "Nothing condensed matches that search. Show all searches facts from single messages too."));
      } else if (!L.all && L.hidden) {
        body.append(el("p", "mem-hint", L.view === "all" ? "Honcho has not condensed any facts yet. It does that from time to time in the background." : "No condensed facts in this view yet."));
        const a = el("div", "mem-acts");
        a.append(btn("", "Show all " + fmt(L.hidden) + (L.hidden === 1 ? " fact" : " facts"), () => { L.all = true; loadFacts(true); }));
        body.append(a);
      } else {
        body.append(el("p", "mem-hint", "Talaria has not learned anything here yet."));
      }
    }
    if (L.loading) body.append(el("p", "mem-hint", "Loading."));
    else if (!L.q.trim() && L.page < L.pages) {
      const a = el("div", "mem-acts");
      a.append(btn("", "Show more", () => loadFacts(false)));
      body.append(a);
    }
    body.append(advancedLearned(L));
  }

  // copies lists the stored copies of the facts with these ids.
  function copies(L, ids) {
    const want = new Set(ids);
    return [...new Set(L.items.filter((c) => want.has(c.id)).flatMap((c) => c.ids && c.ids.length ? c.ids : [c.id]))];
  }

  function selBar(L) {
    const bar = el("div", "mem-selbar");
    const n = L.sel.size;
    const word = n === 1 ? "fact" : "facts";
    if (L.confirm) {
      const m = copies(L, [...L.sel]).length;
      bar.append(el("span", "", "Delete " + fmt(n) + " " + word + (m > n ? " (" + fmt(m) + " stored copies)" : "") + " for good? This cannot be undone."),
        btn("", "Cancel", () => { L.confirm = false; draw(); }),
        btn("danger", "Delete " + fmt(n) + " " + word, () => deleteFacts(L, [...L.sel])));
    } else {
      bar.append(el("span", "", fmt(n) + " selected"), btn("", "Clear", () => { L.sel.clear(); draw(); }),
        btn("danger", "Delete " + fmt(n) + " " + word, () => { L.confirm = true; draw(); }));
    }
    return bar;
  }

  // deleteFacts deletes every stored copy of the facts with these ids, at
  // most 100 copies a request.
  async function deleteFacts(L, factIDs) {
    const ids = copies(L, factIDs);
    if (ui.busy || !ids.length) return;
    ui.busy = true;
    ui.note = "";
    draw();
    let deleted = 0;
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const r = await api("POST", path("/learned/delete"), { ids: ids.slice(i, i + 100) });
        deleted += r.deleted;
      }
      const n = factIDs.length;
      ui.note = "Deleted " + fmt(n) + " " + (n === 1 ? "fact" : "facts") + (deleted > n ? " (" + fmt(deleted) + " stored copies)." : ".");
      ui.bad = false;
    } catch (e) {
      ui.note = "Could not delete every fact: " + e.message;
      ui.bad = true;
    } finally {
      ui.busy = false;
    }
    if (L !== learned) return;
    L.confirm = false;
    L.armed = "";
    L.sel.clear();
    loadFacts(true);
    loadInfo();
  }

  function factRow(L, c) {
    const row = el("div", L.sel.has(c.id) ? "mem-fact sel" : "mem-fact");
    const box = el("input");
    box.type = "checkbox";
    box.checked = L.sel.has(c.id);
    box.setAttribute("aria-label", "Select this fact");
    box.onchange = () => { if (box.checked) L.sel.add(c.id); else L.sel.delete(c.id); L.confirm = false; L.armed = ""; draw(); };
    const txt = el("div", "txt", c.content);
    txt.onclick = () => { box.checked = !box.checked; box.onchange(); };
    const meta = el("div", "meta");
    meta.append(el("span", "", day(c.created_at)));
    meta.append(el("span", "", c.view === "self" ? "Your own words" : c.view === "hermes" ? "Talaria's view" : ""));
    if (c.view === "both") {
      const t = el("span", "mem-tag", "Both views");
      t.title = "Stored twice: once as Talaria's view and once in your own words. Delete removes both.";
      meta.append(t);
    }
    const k = kinds[c.level] || kinds.explicit;
    const lv = el("span", c.level && c.level !== "explicit" ? "mem-tag kind" : "", k[0]);
    lv.title = k[1];
    meta.append(lv);
    const title = c.session_id ? chatTitle(c.session_id) : "";
    if (title) {
      const a = el("a", "", "from “" + title + "”");
      a.href = ctx.chatHash(backend, c.session_id);
      meta.append(a);
    }
    const x = btn("danger-text x", L.armed === c.id ? "Delete for good" : "Delete", () => {
      if (L.armed !== c.id) { L.armed = c.id; draw(); return; }
      deleteFacts(L, [c.id]);
    });
    row.append(box, txt, meta, x);
    return row;
  }

  function advancedLearned(L) {
    const d = el("details", "mem-adv");
    d.open = !!ui.advOpen;
    d.ontoggle = () => { ui.advOpen = d.open; };
    d.append(el("summary", "", "Advanced"));
    if (L.infoErr) d.append(el("p", "mem-note bad", "Could not load the details: " + L.infoErr));
    if (L.info) {
      const dl = el("dl");
      const add = (k, v) => dl.append(el("dt", "", k), el("dd", "", v));
      add("Stored in", "Honcho, workspace “" + L.info.workspace + "”");
      add("Facts", fmt(L.info.total) + " (" + fmt(L.info.copies) + " stored " + (L.info.copies === 1 ? "copy" : "copies") + ")");
      add("Views", "Talaria's view " + fmt(L.info.hermes) + ", your own words " + fmt(L.info.self) + ", both " + fmt(L.info.both));
      add("Kinds", "Condensed " + fmt(L.info.condensed) + ", from one message " + fmt(L.info.raw));
      if (L.info.partial) add("Counted", "The newest 10,000 stored copies");
      add("Profile card", fmt(L.info.card.length) + (L.info.card.length === 1 ? " line" : " lines"));
      d.append(dl);
    }
    if (L.adding) d.append(factEditor(L));
    if (L.card && L.info) {
      const ul = el("ul", "mem-card");
      for (const line of L.info.card) ul.append(el("li", "", line));
      if (!L.info.card.length) ul.append(el("li", "", "The profile card is empty."));
      d.append(ul);
    }
    const acts = el("div", "mem-acts");
    if (!L.adding) acts.append(btn("", "Add a fact", () => { L.adding = true; draw(); const i = root.querySelector(".mem-addfact textarea"); if (i) i.focus(); }));
    acts.append(btn("", L.card ? "Hide profile card" : "View profile card", () => { L.card = !L.card; draw(); }));
    const a = el("a", "mem-button", "Export as JSON");
    a.href = path("/learned/export");
    a.download = "talaria-learned-" + backend + ".json";
    acts.append(a);
    d.append(acts);
    return d;
  }

  function factEditor(L) {
    const row = el("div", "mem-entry editing mem-addfact");
    const ta = el("textarea");
    ta.setAttribute("aria-label", "New fact");
    ta.dataset.k = "fact";
    ta.value = L.draft || "";
    ta.oninput = () => { L.draft = ta.value; };
    ta.placeholder = "A fact about you, such as: Prefers short answers.";
    const er = el("div", "mem-editrow");
    er.append(el("span", "", "Saved as Talaria's view of you."), btn("ghost", "Cancel", () => { L.adding = false; draw(); }),
      btn("primary", "Save", async () => {
        const v = ta.value.trim();
        if (!v || ui.busy) return;
        ui.busy = true;
        try {
          await api("POST", path("/learned"), { content: v });
          L.adding = false;
          L.draft = "";
          L.all = true;
          ui.note = "Saved. Show all is on so you can see it.";
          ui.bad = false;
        } catch (e) {
          ui.note = "Could not save the fact: " + e.message;
          ui.bad = true;
        } finally {
          ui.busy = false;
        }
        if (L === learned) { loadFacts(true); loadInfo(); }
      }));
    row.append(ta, er);
    return row;
  }

  nav.onclick = () => ctx.closeSide();
  return { refresh, show, hide, shown: () => shown };
};
