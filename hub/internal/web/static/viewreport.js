"use strict";
// HubViewReport tells the hub when the page shows a chat away from its
// newest message and the reader did nothing to put it there, at any time
// and not only after an open: no wheel, touch, key or press in the last
// 1.5 s, and none before the report goes out. It is for finding what
// moves the view in a browser the tests do not catch. At most one report
// every 30 s. A report carries a hash of the chat id (never its text),
// the log's last moves, the stack that noticed the move, how long the page
// and the chat have been open, whether the page loaded or its event
// stream came back in the last 60 s, and the page's visibility.
//
// The watch (below) catches what that misses: it keeps the last 60 s of the
// log's moves, with what caused each (the reader's gesture on the log, a
// script's write of scrollTop and where it came from, rows put in or taken
// out above the reader, a resize), and reports any move of the reading
// place by more than one screen that no scroll gesture on the log made,
// from any place in the chat, a chat that opens away from its newest
// message, and a change of more than a screen above the reader. Taps,
// keys and presses elsewhere excuse nothing. capture() sends the same
// record by hand (Alt+J, or a long press on the chat's title). No report
// holds any text of the chat: only sizes, places, row numbers, event kinds
// and the page's own file:line call sites.
//
// loaded() tells the hub once that the page loaded and with which release,
// so a reload after a restart shows in the hub's log.
//
// o.view() is the open chat ({backend, session, loaded, openedAt, kinds})
// or null; o.stick has pinned(), hearing() (true while a scroll counts as
// the reader's) and trail(); o.log is the log element; o.csrf() is the
// token; o.probe(log) is the first item in view ({n, off}) or null.
// o.fetch, o.beacon, o.now, o.every and o.settle are for tests; o.watch
// false leaves the watch out.
window.HubViewReport = (o) => {
  const now = o.now || Date.now;
  const every = o.every || 30000;
  const settle = o.settle || 300;
  const send = o.fetch || ((url, init) => fetch(url, init));
  const beacon = o.beacon || ((url, blob) => (navigator.sendBeacon ? navigator.sendBeacon(url, blob) : false));
  const url = "/api/view-report";
  const born = now();
  let lastInput = -Infinity;
  let sentAt = -Infinity;
  let wasPinned = true;
  let excused = 0;
  let reconnectAt = -Infinity;
  let reconnects = 0;
  let pending = 0;
  let version = "";

  const input = () => { lastInput = now(); };
  for (const type of ["wheel", "touchstart", "touchmove", "touchend", "keydown", "pointerdown", "mousedown", "click"]) {
    window.addEventListener(type, input, { capture: true, passive: true });
  }

  // hash is FNV-1a over the chat's backend and id: enough to tell chats
  // apart in the hub's log without naming one.
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  // post sends body with fetch and keepalive, and with a beacon when the
  // fetch fails or is not there. A beacon cannot set the CSRF header, so
  // the token goes in the body, and the hub takes it from there. done(ok)
  // runs once it is known whether it went.
  function post(body, done) {
    let text = JSON.stringify(body);
    // The hub takes at most 160 KiB: a long ring loses its oldest moves.
    while (text.length > 120000 && Array.isArray(body.ring) && body.ring.length > 10) {
      body = { ...body, ring: body.ring.slice(Math.floor(body.ring.length / 3)), cut: true };
      text = JSON.stringify(body);
    }
    const fin = (ok) => { if (done) { try { done(ok); } catch (_) { /* only a report */ } done = null; } };
    const fallback = () => {
      let ok = false;
      try { ok = !!beacon(url, new Blob([JSON.stringify({ ...body, csrf: o.csrf() })], { type: "application/json" })); } catch (_) { /* only a report */ }
      fin(ok);
    };
    try {
      // keepalive bodies are capped at 64 KiB in all; a large one goes
      // without it.
      const r = send(url, { method: "POST", keepalive: text.length < 60000, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": o.csrf() }, body: text });
      if (r && r.then) r.then((resp) => { if (resp && resp.status >= 500) fallback(); else fin(!!resp && resp.status < 400); }, fallback);
      else fin(true);
    } catch (_) {
      fallback();
    }
  }

  function nav() {
    try {
      const e = performance.getEntriesByType("navigation")[0];
      return e ? e.type : "";
    } catch (_) {
      return "";
    }
  }

  // excuse says the page moved the view for the reader (a search result, a
  // place kept over a reload), for ms. why ("search" or "restore") names it
  // for the watch, which excuses only those two.
  function excuse(ms, why) {
    excused = now() + ms;
    if (watch) watch.note(why || "excuse", ms);
  }

  // reconnected says the event stream came back after a failure.
  function reconnected() {
    reconnectAt = now();
    reconnects++;
    if (watch) watch.note("reconnect");
  }

  // changed is for each time the log's state may have changed.
  function changed() {
    const pinned = o.stick.pinned();
    const was = wasPinned;
    wasPinned = pinned;
    if (watch) watch.dirty();
    if (pinned || !was || pending) return;
    const v = o.view();
    if (!v || !v.loaded) return;
    const t = now();
    if (t < excused || o.stick.hearing() || t - lastInput < 1500) return;
    const stack = String(new Error().stack || "").split("\n").slice(1, 9).join(" | ").slice(0, 800);
    pending = setTimeout(() => {
      pending = 0;
      const t2 = now();
      // Gone, back at the end, or the reader did something since.
      if (o.view() !== v || o.stick.pinned() || lastInput >= t) return;
      if (t2 - sentAt < every) return;
      sentAt = t2;
      const log = o.log;
      post({
        kind: "left", chat: hash(v.backend + "\n" + v.session), ms: t2 - v.openedAt,
        up: Math.round(t2 - born), nav: nav(), vis: document.visibilityState,
        loaded60: t2 - born < 60000, reconnect60: t2 - reconnectAt < 60000, reconnects,
        gap: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight), top: Math.round(log.scrollTop),
        h: log.scrollHeight, c: log.clientHeight,
        trail: o.stick.trail(), events: (v.kinds || []).slice(-20), stack,
      });
    }, settle);
  }

  // loaded tells the hub this page loaded, with the release it runs.
  function loaded(v) {
    version = String(v || "");
    post({ kind: "loaded", version, nav: nav(), vis: document.visibilityState });
  }

  // site names where the page called from: the first frames of the stack
  // outside this file, as fn@file:line. Only the page's own code, never
  // what a message holds.
  function site() {
    const lines = String(new Error().stack || "").split("\n");
    const out = [];
    for (const ln of lines) {
      const m = /^\s*(?:at\s+(?:async\s+)?([^\s(]+)(?:\s+\[as [^\]]+\])?\s+\()?(?:([^\s@(]*)@)?.*?\/([\w.-]+\.js)(?:\?[^:\s)]*)?:(\d+)/.exec(ln);
      if (!m || m[3] === "viewreport.js") continue;
      out.push((m[1] || m[2] || "") + "@" + m[3] + ":" + m[4]);
      if (out.length >= 4) break;
    }
    return out.join("<");
  }

  // HubJumpWatch is the watch: a ring of the log's last 60 s and the
  // reports of a reading place that moved on its own.
  function makeWatch() {
    const log = o.log;
    const probe = o.probe || (() => null);
    const keepMs = 60000;
    const ringMax = 300;
    const ring = [];
    const autoEvery = o.watchEvery || 20000;
    const autoMax = 30;
    let autos = 0;
    const lastAuto = {};
    let manualAt = -Infinity;
    // The reader's scroll gestures on the log, and until when each counts.
    let gestureUntil = 0;
    let gestureKind = "";
    let lastGesture = -Infinity;
    let touching = false;
    let pressing = false;
    // What happened since the last look.
    let writes = [];
    let muts = { add: 0, rem: 0, above: 0, text: 0 };
    let tags = [];
    let resized = false;
    let scrolledN = 0;
    let looked = false;
    // The place the reader saw at the last look.
    let base = null;
    let chatOf = null;
    let openAt = 0;
    let openChecks = [];
    let actedSinceOpen = false;
    let searchUntil = 0;
    let pillUntil = 0;
    let lastAny = -Infinity;
    let queued = false;
    const t0 = () => Math.round(now() - born);

    const push = (e) => {
      ring.push(e);
      const cut = now() - born - keepMs;
      while (ring.length > ringMax || (ring.length && ring[0][0] < cut)) ring.shift();
    };

    // note puts a tag the page announces (a snapshot, a search jump, the
    // Jump to latest button) in the ring, for the next look.
    function note(what, ms) {
      tags.push(what);
      if (what === "search" || what === "restore") searchUntil = now() + (ms || 3000);
      if (what === "pill") pillUntil = now() + 1500;
      push([t0(), "n", what]);
      dirty();
    }

    function gesture(kind, ms) {
      const t = now();
      gestureUntil = Math.max(gestureUntil, t + ms);
      gestureKind = kind;
      lastGesture = t;
      actedSinceOpen = true;
    }
    const inLog = (e) => {
      const r = log.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    log.addEventListener("wheel", (e) => { if (inLog(e)) { gesture("w", 600); push([t0(), "i", "w", Math.round(e.deltaY)]); } }, { passive: true });
    log.addEventListener("touchstart", () => { touching = true; gesture("t", 8000); push([t0(), "i", "ts"]); }, { passive: true });
    const lift = () => { touching = false; gestureUntil = now() + 1500; push([t0(), "i", "te"]); };
    log.addEventListener("touchend", lift, { passive: true });
    log.addEventListener("touchcancel", lift, { passive: true });
    log.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      pressing = true;
      gesture("p", 8000);
      push([t0(), "i", "p"]);
    }, { passive: true });
    for (const up of ["pointerup", "pointercancel"]) {
      window.addEventListener(up, () => { if (pressing) { pressing = false; gestureUntil = now() + 400; } }, { passive: true });
    }
    document.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || (e.target && e.target.isContentEditable);
      if (!typing && ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
        gesture("k", 1200);
        push([t0(), "i", "k", e.key]);
      } else push([t0(), "i", typing ? "kt" : "kx"]);
      // Find in page moves the log to what it finds: the reader's own.
      if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "g")) gesture("f", 30000);
    }, { capture: true, passive: true });
    // Presses elsewhere go in the ring, and excuse only a move to the
    // newest message (a send, a button that goes there).
    window.addEventListener("keydown", () => { lastAny = now(); }, { capture: true, passive: true });
    window.addEventListener("pointerdown", (e) => {
      lastAny = now();
      if (log.contains(e.target)) return;
      const n = e.target && e.target.closest && e.target.closest("[id], button, a");
      push([t0(), "i", "x", n ? (n.id || n.tagName.toLowerCase()) : ""]);
    }, { capture: true, passive: true });
    log.addEventListener("scroll", () => {
      scrolledN++;
      // A fling's scroll events go on after the finger lifts.
      if (!touching && now() < gestureUntil && gestureKind === "t") gestureUntil = Math.max(gestureUntil, now() + 200);
      dirty();
    }, { passive: true });
    log.addEventListener("focusin", (e) => { push([t0(), "i", "fo", e.target && e.target.tagName]); }, true);

    // Scripts that move the log: each write of scrollTop, scrollTo,
    // scrollBy and scrollIntoView of something in it, with its call site.
    try {
      const d = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
      if (d && d.set && d.get) {
        Object.defineProperty(log, "scrollTop", {
          configurable: true,
          get() { return d.get.call(this); },
          set(v) {
            d.set.call(this, v);
            if (writes.length < 6) writes.push(site() + "=" + Math.round(v));
            dirty();
          },
        });
      }
      for (const fn of ["scrollTo", "scrollBy"]) {
        const f0 = log[fn];
        if (typeof f0 !== "function") continue;
        log[fn] = function () {
          if (writes.length < 6) writes.push(site() + ":" + fn);
          dirty();
          return f0.apply(this, arguments);
        };
      }
      const siv = Element.prototype.scrollIntoView;
      if (typeof siv === "function") {
        Element.prototype.scrollIntoView = function () {
          if (this !== log && log.contains(this)) {
            if (writes.length < 6) writes.push(site() + ":siv");
            dirty();
          }
          return siv.apply(this, arguments);
        };
      }
    } catch (_) { /* no watch of writes */ }

    // Rows that go in or out above the reader, by document order (no
    // layout needed): before the element the reader looked at last.
    const before = (n) => {
      const a = base && base.el;
      if (!a || !a.isConnected || !n || n === a) return false;
      if (n.contains && n.contains(a)) return false;
      return !!(n.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") { muts.text++; continue; }
        muts.add += m.addedNodes.length;
        muts.rem += m.removedNodes.length;
        if (m.addedNodes.length) {
          for (const n of m.addedNodes) if (n.nodeType === 1 && before(n)) { muts.above++; break; }
        }
        if (m.removedNodes.length) {
          const next = m.nextSibling;
          if (next ? before(next) : before(m.target) && m.target !== log) muts.above++;
          else if (!next && m.target === log && base && base.el && !base.el.isConnected) muts.above++;
        }
      }
      dirty();
    }).observe(log, { childList: true, subtree: true, characterData: true });
    const resize = () => { resized = true; dirty(); };
    window.addEventListener("resize", resize, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", resize, { passive: true });
    try { new ResizeObserver(resize).observe(log); } catch (_) { /* no ResizeObserver */ }
    document.addEventListener("visibilitychange", () => { push([t0(), "n", "vis:" + document.visibilityState]); dirty(); });

    function dirty() {
      if (queued) return;
      queued = true;
      const run = () => { queued = false; try { look(); } catch (_) { /* only a report */ } };
      if (typeof requestAnimationFrame === "function" && document.visibilityState !== "hidden") requestAnimationFrame(run);
      else setTimeout(run, 50);
    }

    // rowEl is the element with the server's row number that holds n, is
    // in it, or comes nearest before it: a snapshot draws the same rows
    // again under the same numbers.
    const rowEl = (n) => {
      const up = n.closest && n.closest("[data-row]");
      if (up) return up;
      for (let x = n, i = 0; x && i < 8; x = x.previousElementSibling, i++) {
        if (x.dataset && x.dataset.row) return x;
        const r = x.querySelectorAll && x.querySelectorAll("[data-row]");
        if (r && r.length) return r[r.length - 1];
      }
      return null;
    };

    // where finds the reader's place now: what is in view and how far
    // from the log's top, the log's sizes, and whether it is at the end.
    function where() {
      const top = log.scrollTop;
      const h = log.scrollHeight;
      const c = log.clientHeight;
      const p = probe(log);
      const r = p ? rowEl(p.n) : null;
      const rowOff = r ? r.getBoundingClientRect().top - log.getBoundingClientRect().top : 0;
      return { top, h, c, end: h - top - c < 24, pin: o.stick.pinned(), el: p ? p.n : null, off: p ? p.off : 0, row: r ? r.dataset.row : "", rowOff };
    }

    // shift is how far the reader's place moved since base: positive when
    // what they read went down the screen (they now see older rows).
    function shift(b, logTop) {
      if (!b || !b.el) return null;
      if (b.el.isConnected && log.contains(b.el)) return { d: b.el.getBoundingClientRect().top - logTop - b.off, same: true };
      const n = b.row ? log.querySelector('[data-row="' + CSS.escape(b.row) + '"]') : null;
      if (!n) return null;
      return { d: n.getBoundingClientRect().top - logTop - b.rowOff, same: false };
    }

    function look() {
      if (log.hidden) { base = null; return; }
      const v = o.view();
      const t = now();
      if (!v || v !== chatOf) {
        chatOf = v || null;
        base = null;
        openAt = 0;
        openChecks = [];
        actedSinceOpen = false;
        push([t0(), "v", v ? hash(v.backend + "\n" + v.session) : ""]);
      }
      if (v && v.loaded && !openAt) {
        openAt = t;
        openChecks = [1500, 4000];
        for (const ms of openChecks) setTimeout(dirty, ms + 20);
      }
      const logTop = log.getBoundingClientRect().top;
      const sh = shift(base, logTop);
      const w = where();
      const g = t < gestureUntil || touching || pressing;
      const ws = writes;
      const ms = muts;
      const tg = tags;
      const rs = resized;
      const sn = scrolledN;
      writes = [];
      muts = { add: 0, rem: 0, above: 0, text: 0 };
      tags = [];
      resized = false;
      scrolledN = 0;
      const d = sh ? Math.round(sh.d) : null;
      const moved = !base || Math.abs(w.top - base.top) >= 1 || w.c !== base.c || (d !== null && Math.abs(d) >= 1) || ms.above || ws.length || rs;
      if (moved || Math.abs(w.h - (base ? base.h : 0)) > 200) {
        const e = [t0(), g ? "g" + gestureKind : "s", Math.round(w.top), w.h, w.c, d, w.end ? 1 : 0];
        const x = {};
        if (ws.length) x.w = ws;
        if (ms.add || ms.rem) x.m = [ms.add, ms.rem, ms.above];
        if (rs) x.r = [window.innerWidth, window.innerHeight, window.visualViewport ? Math.round(window.visualViewport.height) : 0];
        if (tg.length) x.n = tg;
        if (sh && !sh.same) x.re = 1;
        if (base && !sh) x.lost = 1;
        if (sn) x.sc = sn;
        if (w.row) x.row = w.row;
        if (Object.keys(x).length) e.push(x);
        push(e);
      }
      const prev = base;
      if (v && v.loaded) base = w;
      if (!v || !v.loaded || !prev) return;
      // A move the reader did not make: more than a screen of what they
      // read went past, and not a log that stays at its end as it grows.
      const screen = Math.max(200, w.c);
      // The newest message stays in view: at the end, or held there by
      // the stick while the log changes size (a hidden tab, a keyboard),
      // and it is at the end now.
      const atEnds = (prev.end || prev.pin) && w.end;
      const jumped = d !== null ? Math.abs(d) > screen : Math.abs(w.top - prev.top) > screen && !atEnds;
      if (jumped && !atEnds) {
        const excusedNow = t < searchUntil || (w.end && (t < pillUntil || t - lastAny < 1500));
        if (!g && !excusedNow) auto("jump", { d, from: place(prev), to: place(w), lost: !sh });
        // A scroll gesture moves a screen or so a frame, never four: the
        // rest is the page's.
        else if (g && gestureKind !== "k" && gestureKind !== "p" && gestureKind !== "f" && d !== null && Math.abs(d) > 4 * screen) auto("gesture", { d, from: place(prev), to: place(w), during: gestureKind });
      } else if (!g && t - lastGesture > 3000 && d !== null && Math.abs(d) < 2 && !atEnds && Math.abs(w.top - prev.top) > screen) {
        // The log kept the reader in place, but more than a screen went in
        // or out above them.
        auto("above", { dt: Math.round(w.top - prev.top), from: place(prev), to: place(w) });
      }
      // A chat that opened away from its newest message, the reader not
      // having scrolled it, nor a search or a reload put it there.
      if (openAt && openChecks.length && t - openAt >= openChecks[0]) {
        while (openChecks.length && t - openAt >= openChecks[0]) openChecks.shift();
        if (!actedSinceOpen && !w.end && t >= searchUntil && w.h - w.top - w.c > screen / 2) auto("open", { at: Math.round(t - openAt), to: place(w) });
      }
    }
    const place = (w) => ({ top: Math.round(w.top), h: w.h, c: w.c, end: w.end, row: w.row });

    function state(v) {
      const vv = window.visualViewport;
      return {
        chat: v ? hash(v.backend + "\n" + v.session) : "", ms: v ? now() - v.openedAt : 0, loadedChat: !!(v && v.loaded),
        up: t0(), version, nav: nav(), vis: document.visibilityState,
        loaded60: now() - born < 60000, reconnect60: now() - reconnectAt < 60000, reconnects,
        top: Math.round(log.scrollTop), h: log.scrollHeight, c: log.clientHeight,
        gap: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
        pinned: o.stick.pinned(), hearing: o.stick.hearing(), gesture: now() < gestureUntil || touching,
        win: [window.innerWidth, window.innerHeight, Math.round((vv && vv.height) || 0), window.devicePixelRatio || 1],
        trail: o.stick.trail(), events: v ? (v.kinds || []).slice(-30) : [],
        ring: ring.slice(),
      };
    }

    // auto reports a move nobody made, 400 ms later, with where the log
    // is then: back says the page put the reader back (a flash) or not.
    function auto(why, extra) {
      const t = now();
      if (autos >= autoMax || t - (lastAuto[why] || -Infinity) < autoEvery) return;
      lastAuto[why] = t;
      autos++;
      push([t0(), "R", why]);
      const v = o.view();
      const from = extra.from;
      const at = site();
      setTimeout(() => {
        let after = null;
        try { after = place(where()); } catch (_) { /* gone */ }
        const back = !!(after && from && (from.end ? after.end : Math.abs(after.top - from.top) < 50));
        post({ kind: "jump", why, ...extra, after, back, site: at, same: o.view() === v, ...state(v) });
      }, 400);
    }

    // capture sends the record by hand, at once; done(ok) after.
    function capture(done) {
      const t = now();
      if (t - manualAt < 3000) { if (done) done(true); return; }
      manualAt = t;
      try { look(); } catch (_) { /* send what there is */ }
      push([t0(), "R", "manual"]);
      post({ kind: "manual", ...state(o.view()) }, done);
    }

    dirty();
    return { note, dirty, capture, ring: () => ring.slice() };
  }

  const watch = o.watch === false || !o.log ? null : makeWatch();

  function note(what) { if (watch) watch.note(what); }
  function capture(done) { if (watch) watch.capture(done); else if (done) done(false); }

  // send posts a report the caller made (HubPerfWatch's timings).
  const sendReport = (body) => post(body);

  return { changed, excuse, reconnected, loaded, note, capture, send: sendReport, ring: () => (watch ? watch.ring() : []) };
};
