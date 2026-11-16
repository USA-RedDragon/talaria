"use strict";
// HubJobRows puts the run chats of one scheduled job in one row of the
// chat list. Which job a chat belongs to is not guessed from its title: the
// hub lists each job's runs (GET /api/scheduled/chats, the same runs as the
// Scheduled page), and a chat is a run of the job that lists it.
//
// HubJobRows.group(chats, jobs, opts) is the grouping alone (no page
// needed): chats are the list's chats in the order the list shows them; the
// answer holds the same chats in that order, where the run chats of one job
// are replaced, at the place of the newest, by one {job, runs, newest,
// unread} entry. A run that needs the user stays its own row: a failed run
// and a chat that waits on an approval or a question.
// opts.skip(chat) is true for a chat that must stay as it is (a pinned one).
(function () {
  const keyOf = (b, s) => b + "\n" + s;

  function runIndex(jobs) {
    const idx = new Map();
    for (const j of (jobs && jobs.jobs) || []) {
      for (const r of j.runs || []) if (r.session_id) idx.set(keyOf(j.backend_id, r.session_id), { job: j, run: r });
    }
    return idx;
  }

  function group(chats, jobs, opts) {
    const skip = (opts && opts.skip) || (() => false);
    const idx = runIndex(jobs);
    const byChat = new Map();
    for (const c of chats) byChat.set(keyOf(c.backend_id, c.id), c);
    const out = [];
    const made = new Map();
    for (const c of chats) {
      const hit = idx.get(keyOf(c.backend_id, c.id));
      if (!hit || skip(c) || hit.run.failed || (c.needs && c.needs !== "none")) {
        out.push({ chat: c });
        continue;
      }
      const k = keyOf(hit.job.backend_id, hit.job.id);
      let g = made.get(k);
      if (!g) {
        g = { job: hit.job, chats: [], newest: c, unread: 0, running: false, key: k, recent: [] };
        made.set(k, g);
        out.push({ group: g });
      }
      g.chats.push(c);
      if (c.unread && !c.running) g.unread++;
      if (c.running) g.running = true;
    }
    // The runs the row lists, newest first, as the job lists them: those
    // whose chat the list has, grouped or not.
    for (const g of made.values()) {
      for (const r of g.job.runs || []) {
        const c = r.session_id && byChat.get(keyOf(g.job.backend_id, r.session_id));
        if (c) g.recent.push({ run: r, chat: c });
        if (g.recent.length >= 5) break;
      }
    }
    return out;
  }

  // word is how a run ended, in the words of the Scheduled page: the
  // result up to its first colon ("Failed: reason" is "Failed").
  const word = (r) => (r.result || "").split(":")[0] || "Finished";

  window.HubJobRows = Object.assign((ctx) => {
    const { api, el, I } = ctx;
    let data = null;
    let at = 0;
    let loading = null;
    const openJobs = new Set();
    try { for (const k of JSON.parse(localStorage.getItem("hub.jobrows.open") || "[]")) openJobs.add(k); } catch (_) { /* none */ }
    const keep = () => { try { localStorage.setItem("hub.jobrows.open", JSON.stringify([...openJobs].slice(-50))); } catch (_) { /* private mode */ } };

    // ensure reads the jobs' runs when the list has run chats it does not
    // know yet, or the answer is a minute old. It resolves when the answer
    // is in (or failed), so the first list is drawn grouped.
    function ensure(chats) {
      if (!ctx.enabled()) return Promise.resolve(false);
      const cron = chats.filter((c) => c.source === "cron");
      if (!cron.length) return Promise.resolve(false);
      const known = runIndex(data);
      const stale = Date.now() - at > 60000;
      if (!cron.some((c) => !known.has(keyOf(c.backend_id, c.id))) && !stale) return Promise.resolve(false);
      // After a miss, wait before asking again: a run chat that is not a
      // job's run (a job deleted since) would ask on every list.
      if (Date.now() - at < 15000 && data) return Promise.resolve(false);
      if (loading) return loading;
      loading = api("GET", "/api/scheduled/chats").then((d) => { data = d; at = Date.now(); return true; })
        .catch(() => { at = Date.now(); return false; })
        .finally(() => { loading = null; });
      return loading;
    }

    const when = (iso) => {
      const d = new Date(iso);
      if (isNaN(d)) return "";
      const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: "short" }) + " " + t;
    };

    // item builds the row of one group and its list of runs. ctx.open(chat)
    // opens a run; ctx.ago(iso) is the age text; ctx.mark(chat) the dot.
    function item(g, many) {
      const isOpen = openJobs.has(g.key);
      const wrap = el("div", "jobgroup");
      const row = el("div", "item jobrow" + (g.unread ? " unread" : ""));
      row.dataset.key = "job\n" + g.key;
      if (g.chats.some((c) => ctx.isCurrent(c))) row.classList.add("active");
      const a = el("a", "go");
      a.href = ctx.hash(g.newest);
      a.draggable = false;
      const m = el("span", "mark" + (g.unread ? " unread" : g.running ? " running" : ""));
      m.setAttribute("aria-hidden", "true");
      a.append(m);
      const col = el("span", "col");
      const top = el("span", "jobtop");
      top.append(el("span", "name", g.job.name));
      col.append(top);
      const where = "Scheduled, " + g.job.schedule + " \u00B7 " + g.job.runs_in + (many ? " \u00B7 " + g.job.backend : "");
      // The count sits at the end of the second line, and the time
      // follows it, so the name keeps the width of the whole line.
      const sub = el("span", "jobsub");
      sub.append(el("span", "where", where));
      if (g.unread) {
        const b = el("span", "badge", g.unread + " new");
        b.title = g.unread + (g.unread === 1 ? " run" : " runs") + " you have not opened";
        sub.append(b);
      }
      const w = el("span", "when", ctx.ago(g.newest.updated_at));
      if (w.textContent) w.title = new Date(g.newest.updated_at).toLocaleString();
      sub.append(w);
      col.append(sub);
      a.append(col);
      a.setAttribute("aria-label", g.job.name + ", scheduled job" + (g.unread ? ", " + g.unread + " new" : ""));
      a.onclick = () => ctx.opened();
      const tog = el("button", "more jobtoggle");
      tog.type = "button";
      tog.append(I.icon("chev"));
      tog.title = isOpen ? "Hide recent runs" : "Show recent runs";
      tog.setAttribute("aria-label", tog.title + " of " + g.job.name);
      tog.setAttribute("aria-expanded", String(isOpen));
      tog.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openJobs.has(g.key)) openJobs.delete(g.key); else openJobs.add(g.key);
        keep();
        ctx.redraw();
      };
      row.append(a, tog);
      wrap.append(row);
      if (isOpen) {
        const runs = el("div", "jobruns");
        for (const { run, chat } of g.recent) {
          const r = el("div", "item jobrun" + (chat.unread && !chat.running ? " unread" : "") + (ctx.isCurrent(chat) ? " active" : ""));
          r.dataset.key = chat.backend_id + "\n" + chat.id;
          const ra = el("a", "go");
          ra.href = ctx.hash(chat);
          ra.draggable = false;
          ra.append(ctx.mark(chat));
          const rc = el("span", "col");
          rc.append(el("span", "name", "Run at " + when(run.started_at || chat.updated_at)), el("span", "where", word(run)));
          ra.append(rc);
          ra.onclick = () => ctx.opened();
          r.append(ra);
          runs.append(r);
        }
        const all = el("a", "jobruns-all", "All runs on the Scheduled page");
        all.href = "#/scheduled/" + encodeURIComponent(g.job.backend_id) + "/" + encodeURIComponent(g.job.id);
        all.onclick = () => ctx.opened();
        runs.append(all);
        wrap.append(runs);
      }
      return wrap;
    }

    return { ensure, item, group: (chats, opts) => group(chats, data, opts) };
  }, { group });
})();
