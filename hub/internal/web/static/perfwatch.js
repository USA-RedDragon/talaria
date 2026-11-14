"use strict";
// HubPerfWatch times what the reader waits for in this browser and tells
// the hub, one report each, for the hub's log: every chat open and switch
// (from the click, or from the page's start for a load, to the first rows
// painted and to the log settled), and every scroll up through a chat (its
// frames). A report holds the chat's row and node counts, the frames over
// 50 ms with the page's functions that ran in them, the time spent in the
// page's main steps (span), and the hub's time for each request on the
// way (Server-Timing). It names a chat by a hash of its id, never by text,
// and a request by its path with the chat's ids taken out.
// o.post(body) sends a report; o.log is the log element.
window.HubPerfWatch = (o) => {
  const log = o.log;
  const now = () => performance.now();
  const maxReports = 300;
  let reports = 0;

  // hash is FNV-1a, as the view report's.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  function send(body) {
    if (reports >= maxReports) return;
    reports++;
    try { o.post(body); } catch (_) { /* only a report */ }
  }

  // Spans: the time in each of the page's main steps, while a measure
  // (an open or a scroll) runs. Nested spans count in their own name too.
  const open = new Set();
  let stack = [];
  const recent = [];
  function wrap(name, fn) {
    if (typeof fn !== "function" || fn.perfWrapped) return fn;
    const w = function (...a) {
      if (!open.size) return fn.apply(this, a);
      const t = now();
      stack.push(name);
      try {
        return fn.apply(this, a);
      } finally {
        stack.pop();
        const ms = now() - t;
        for (const m of open) m.spans[name] = (m.spans[name] || 0) + ms;
        if (!stack.length && ms > 2) {
          recent.push({ name, t, ms });
          if (recent.length > 200) recent.splice(0, 100);
        }
      }
    };
    w.perfWrapped = true;
    return w;
  }
  const spansIn = (from, to) => {
    const by = {};
    for (const s of recent) if (s.t + s.ms >= from && s.t <= to) by[s.name] = (by[s.name] || 0) + s.ms;
    return Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, ms]) => n + ":" + Math.round(ms));
  };

  // Long frames: the browser's long animation frames with the scripts in
  // them where it has them (Chrome), else frames whose gap passed 50 ms,
  // with the page's spans that ran in them (Firefox).
  let loaf = false;
  if (typeof PerformanceObserver === "function" && (PerformanceObserver.supportedEntryTypes || []).includes("long-animation-frame")) try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!open.size) continue;
        const fn = (e.scripts || []).filter((s) => s.duration >= 5).sort((a, b) => b.duration - a.duration).slice(0, 4)
          .map((s) => (s.sourceFunctionName || s.invoker || "?") + "@" + String(s.sourceURL || "").replace(/^.*\//, "").replace(/\?.*$/, "") + ":" + Math.round(s.duration));
        const block = Math.round(e.blockingDuration || 0);
        for (const m of open) {
          if (e.startTime + e.duration < m.t0) continue;
          m.long.push({ at: Math.round(e.startTime - m.t0), ms: Math.round(e.duration), block, fn: fn.length ? fn : spansIn(e.startTime, e.startTime + e.duration), style: Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0) });
        }
      }
    });
    po.observe({ type: "long-animation-frame", buffered: false });
    loaf = true;
  } catch (_) { /* no long animation frames: the frame gaps below */ }

  // frames runs while any measure is open: it counts frames and, without
  // long animation frames, finds the long ones by their gaps.
  let framing = false;
  function frames() {
    if (framing) return;
    framing = true;
    let last = now();
    const tick = () => {
      const t = now();
      const gap = t - last;
      last = t;
      for (const m of open) {
        m.frames++;
        if (gap > m.maxFrame) m.maxFrame = gap;
        if (gap > 50) {
          m.slow++;
          if (!loaf && t - gap >= m.t0 - 1) m.long.push({ at: Math.round(t - gap - m.t0), ms: Math.round(gap), fn: spansIn(t - gap, t) });
        }
      }
      if (open.size) requestAnimationFrame(tick);
      else framing = false;
    };
    requestAnimationFrame(tick);
  }

  function measure(t0) {
    const m = { t0, spans: {}, long: [], frames: 0, slow: 0, maxFrame: 0 };
    open.add(m);
    frames();
    return m;
  }
  const close = (m) => open.delete(m);

  // counts are the log's rows and nodes.
  const counts = () => ({ rows: log.querySelectorAll(".msg").length, nodes: log.getElementsByTagName("*").length, doc: document.getElementsByTagName("*").length });

  // res keeps the page's last requests: the browser's own list stops at
  // 250 entries, which a page open for an hour has long passed.
  const res = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (/\/api\//.test(e.name)) res.push(e);
      if (res.length > 300) res.splice(0, 150);
    }).observe({ type: "resource", buffered: true });
  } catch (_) { /* no resource timing */ }

  // srv is the hub's time for each request since t0, from Server-Timing.
  function srv(t0) {
    const list = res;
    return list.filter((e) => e.startTime >= t0 - 5 && /\/api\//.test(e.name)).slice(0, 20).map((e) => {
      const st = {};
      for (const s of e.serverTiming || []) st[s.name] = Math.round(s.duration * 100) / 100;
      return { u: e.name.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "").replace(/(\/sessions\/)[^/]+\/[^/]+/, "$1~").replace(/(\/subagents\/)[^/]+/, "$1~"),
        at: Math.round(e.startTime - t0), ttfb: Math.round((e.responseStart || 0) - (e.requestStart || 0)), end: Math.round(e.responseEnd - t0), st };
    });
  }

  // An open: kind is load, open, switch or back (a chat kept in the page).
  let cur = null;
  function chatOpen(kind, backend, session, t0) {
    if (cur) finish(cur, true);
    cur = { kind, chat: hash(backend + "\n" + session), m: measure(t0), t0, paint: 0, timer: 0, last: 0, mo: null, done: false };
    const c = cur;
    c.cap = setTimeout(() => finish(c, false), 15000);
  }

  // painted is when the chat's first rows are on the screen: the end of
  // the frame that drew them.
  function painted() {
    const c = cur;
    if (!c || c.paint) return;
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        if (c.done || c.paint) return;
        c.paint = now() - c.t0;
        Object.assign(c, { atPaint: counts() });
        // Settled: 600 ms with no change in the log.
        c.last = now();
        // Older history that renders above the reader in idle time is
        // not what the reader waits for.
        c.mo = new MutationObserver((recs) => { if (recs.some((r) => { const n = r.target.closest ? r.target : r.target.parentElement; return !(n && n.closest(".older")); })) c.last = now(); });
        c.mo.observe(log, { childList: true, subtree: true, characterData: true });
        const check = () => {
          if (c.done) return;
          if (now() - c.last >= 600) { c.settled = c.last - c.t0; finish(c, false); return; }
          c.timer = setTimeout(check, 200);
        };
        c.timer = setTimeout(check, 200);
      };
      ch.port2.postMessage(0);
    });
  }

  function finish(c, cut) {
    if (c.done) return;
    c.done = true;
    clearTimeout(c.cap);
    clearTimeout(c.timer);
    if (c.mo) c.mo.disconnect();
    close(c.m);
    if (cur === c) cur = null;
    const n = counts();
    send({ kind: "timing", what: c.kind, chat: c.chat, paint: Math.round(c.paint), settled: Math.round(c.settled || 0), cut: cut || !c.settled || undefined,
      rows: n.rows, nodes: n.nodes, doc: n.doc, paintRows: c.atPaint ? c.atPaint.rows : 0, paintNodes: c.atPaint ? c.atPaint.nodes : 0,
      frames: c.m.frames, slow: c.m.slow, maxFrame: Math.round(c.m.maxFrame),
      long: c.m.long.slice(0, 12), longMs: c.m.long.reduce((s, x) => s + x.ms, 0),
      spans: Object.fromEntries(Object.entries(c.m.spans).filter(([, ms]) => ms >= 1).map(([k, ms]) => [k, Math.round(ms)])),
      srv: srv(c.t0), vis: document.visibilityState, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, mem: navigator.deviceMemory || 0, cpus: navigator.hardwareConcurrency || 0 });
  }

  // Scrolls up: from the first move up to 800 ms after the last move.
  let sc = null;
  let lastTop = log.scrollTop;
  let chatKey = "";
  log.addEventListener("scroll", () => {
    const top = log.scrollTop;
    const up = top < lastTop;
    lastTop = top;
    if (!sc && !up) return;
    if (!sc) {
      const c = counts();
      sc = { m: measure(now()), from: top, min: top, rows0: c.rows, nodes0: c.nodes, chat: chatKey, timer: 0 };
    }
    sc.min = Math.min(sc.min, top);
    clearTimeout(sc.timer);
    const s = sc;
    s.timer = setTimeout(() => {
      sc = null;
      close(s.m);
      const ms = now() - s.m.t0 - 800;
      const dist = s.from - s.min;
      if (ms < 250 || dist < log.clientHeight) return;
      const c = counts();
      send({ kind: "scroll", chat: s.chat, ms: Math.round(ms), px: Math.round(dist), screens: Math.round((dist / log.clientHeight) * 10) / 10,
        frames: s.m.frames, slow: s.m.slow, maxFrame: Math.round(s.m.maxFrame), long: s.m.long.slice(0, 12), longMs: s.m.long.reduce((a, x) => a + x.ms, 0),
        rows: c.rows, nodes: c.nodes, rowsAdded: c.rows - s.rows0, nodesAdded: c.nodes - s.nodes0,
        spans: Object.fromEntries(Object.entries(s.m.spans).filter(([, v]) => v >= 1).map(([k, v]) => [k, Math.round(v)])),
        vis: document.visibilityState, w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
    }, 800);
  }, { passive: true });

  return {
    wrap,
    open(kind, backend, session, t0) { chatKey = hash(backend + "\n" + session); chatOpen(kind, backend, session, t0); },
    painted,
    hash,
  };
};
