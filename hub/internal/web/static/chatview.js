"use strict";
// HubChatView is the one chat view of the page: it turns a chat's rows and
// events into the log's bubbles, notice cards, thinking blocks, tool cards
// (toolcard.js) and tool groups (toolgroup.js), and keeps the reader's
// place in the log with its jump to the latest message (stick.js). The
// chat (app.js Chat) and a subagent's steps in Activity (minichat.js) both
// draw through it: the same row or event is the same DOM in both. They
// differ only in their container: the chat's log fills the page and has
// the composer under it; a subagent's log sits in its Activity row.
//
// new ChatView(log, env, o) draws into log. env is the page's: el(tag,
// cls, text), toast, t(word), render(node, raw, local, inc) (Markdown),
// media (directives, hidePending, markdownMedia, pageCard, mediaRow,
// attachmentRow, split), agentCard(view, box, id). o: ui (HubUIState of
// the log), scroll (scroller below), base (the chat's API path), shown()
// (the view is the one on screen), cards() (the context tool cards get).
//
// scroller(log, jump, o) wires a log and its jump button to HubStick.
window.HubChatView = (() => {
  // probe finds the first message in view, through the boxes that hold
  // older messages, and how far below the top of the log it starts.
  function probe(l) {
    const top = l.getBoundingClientRect().top;
    let box = l;
    for (;;) {
      const n = Array.from(box.children).find((c) => !c.classList.contains("acts") && c.getBoundingClientRect().bottom > top);
      if (!n) return null;
      if (n.classList.contains("older") || n.classList.contains("part")) { box = n; continue; }
      return { n, off: n.getBoundingClientRect().top - top };
    }
  }

  // scroller keeps the log at its end while the reader is at the end, and
  // on the same message while the reader is above it (HubStick); jump is
  // the button that goes back to the latest and counts the messages that
  // came while the reader was away. o: ui (HubUIState of the log), t(word)
  // for the button's words, page (true: the page's navigation keys move
  // this log; else only keys pressed inside it), hide() (also hide the
  // button), changed(), pill() (the button was pressed).
  function scroller(log, jump, o) {
    let unseen = 0;
    const place = (n, l) => (n.isConnected ? n.getBoundingClientRect().top - l.getBoundingClientRect().top : null);
    const s = window.HubStick(log, {
      probe: o.probe || probe,
      place,
      changed: () => {
        if (s.pinned()) unseen = 0;
        if (o.changed) o.changed();
        const hide = s.pinned() || log.hidden || !!(o.hide && o.hide());
        if (jump.hidden !== hide) jump.hidden = hide;
        const label = unseen ? (unseen === 1 ? o.t("newone") : o.t("newmany").replace("%d", unseen)) : o.t("tobottom");
        // Written only when it changes: a write each streamed frame would
        // dirty the style the next read has to settle.
        if (jump.title !== label) {
          jump.querySelector(".lbl").textContent = label;
          jump.title = label;
        }
      },
    });
    const ui = o.ui;
    let queued = false;
    const soon = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; s.sync(); });
    };
    // dispose drops what the log listens to outside itself.
    const ac = new AbortController();
    const away = { passive: true, signal: ac.signal };
    const ro = new ResizeObserver(() => s.sync());
    ro.observe(log);
    for (const n of log.children) ro.observe(n);
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) if (n.nodeType === 1) ui.apply(n);
        if (m.target === log) {
          for (const n of m.removedNodes) if (n.nodeType === 1) ro.unobserve(n);
          for (const n of m.addedNodes) if (n.nodeType === 1) ro.observe(n);
        }
      }
      soon();
    });
    mo.observe(log, { childList: true, subtree: true, characterData: true });
    log.addEventListener("scroll", () => s.scrollSoon(), { passive: true });
    let swiped = false;
    log.addEventListener("wheel", (e) => {
      // Firefox sends the rest of a wheel gesture where it began, also once
      // the pointer has left for the chat list: that is not the reader in
      // this log.
      const r = log.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      s.heard(400);
      if (e.deltaY < 0 && s.pinned()) s.release();
    }, { passive: true });
    log.addEventListener("touchstart", () => { swiped = false; s.drag(true); }, { passive: true });
    // A touch only says the reader may scroll; whether the reader left the
    // end is for the scroll events to tell (a tap or a long press that
    // moves a pixel is not a scroll).
    log.addEventListener("touchmove", () => { swiped = true; s.heard(8000); }, { passive: true });
    const lifted = () => { s.heard(swiped ? 3000 : 1); s.drag(false); };
    log.addEventListener("touchend", lifted, { passive: true });
    log.addEventListener("touchcancel", lifted, { passive: true });
    let down = false;
    log.addEventListener("pointerdown", () => { down = true; s.heard(8000); }, { passive: true });
    for (const up of ["pointerup", "pointercancel", "mouseup"]) {
      window.addEventListener(up, () => { if (down) { down = false; s.heard(300); } }, away);
    }
    document.addEventListener("keydown", (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      // A log in a panel moves only with the keys pressed in it.
      if (!o.page && !(e.target && log.contains(e.target))) return;
      if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) {
        s.heard(800);
        if (["PageUp", "Home", "ArrowUp"].includes(e.key) && s.pinned()) s.release();
      }
    }, { capture: true, passive: true, signal: ac.signal });
    log.addEventListener("click", (e) => ui.record(e), true);
    log.addEventListener("load", soon, true);
    log.addEventListener("click", (e) => {
      if (!ui.busy() && s.pinned() && e.target.closest && e.target.closest("summary, [aria-expanded], .notice-more")) s.release();
      soon();
    }, true);
    log.addEventListener("toggle", soon, true);
    window.addEventListener("resize", soon, away);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", soon, away);
    jump.addEventListener("click", () => { if (o.pill) o.pill(); s.pin(); });
    s.saw = () => { unseen++; };
    s.clearUnseen = () => { unseen = 0; };
    s.dispose = () => {
      ac.abort();
      ro.disconnect();
      mo.disconnect();
    };
    return s;
  }

  // jumpButton is the button that goes back to the latest message, in the
  // box that holds it under the log.
  function jumpButton(el, t) {
    const hold = el("div", "tbhold");
    const b = el("button", "tobottom");
    b.type = "button";
    b.hidden = true;
    b.title = t("tobottom");
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
    b.append(el("span", "lbl", t("tobottom")));
    hold.append(b);
    return { hold, button: b };
  }

  class ChatView {
    constructor(log, env, o) {
      this.log = log;
      this.env = env;
      this.ui = o.ui;
      this.scroll = o.scroll;
      this.base = o.base || "";
      this.opts = o;
      this.tools = new Map();
      this.wraps = new Map();
      this.pending = [];
      this.failed = [];
      this.urls = [];
      this.at = 0;
    }

    // reset empties the log and forgets what was drawn in it.
    reset() {
      this.log.replaceChildren();
      this.sink = null;
      this.turn = null;
      this.tools = new Map();
      this.wraps = new Map();
      this.pending = [];
      this.begun = undefined;
      this.failed = [];
      this.at = 0;
      this.status = null;
      this.calls = new Map();
      this.agentWaiting = new Map();
      for (const u of this.urls || []) if (!this.keep || !this.keep.has(u)) URL.revokeObjectURL(u);
      this.urls = [];
    }

    shown() { return this.opts.shown ? this.opts.shown(this) : true; }

    // cardContext is what the tool cards of this view may use.
    cardContext() { return this.opts.cards ? this.opts.cards() : null; }

    // stick tells whether a change should scroll the log to its end. Not
    // while a snapshot fills the log: scrolling reads the log's height,
    // which lays it out again, so a scroll per row made a long chat's
    // load quadratic. The snapshot scrolls once at the end.
    stick() { return this.scroll.pinned() && !this.filling; }

    bottom() { this.scroll.pin(); }

    add(node) {
      if (this.sink) return this.sink.appendChild(node);
      const follow = this.stick();
      if (this.status && this.status.parentNode === this.log) this.log.insertBefore(node, this.status);
      else this.log.append(node);
      if (follow) this.scroll.pinSoon();
      else if (!this.filling && this.shown()) {
        if (node.classList.contains("msg")) this.scroll.saw();
        this.scroll.refresh();
      }
      return node;
    }

    follow(fn) {
      const follow = this.stick();
      fn();
      if (follow) this.scroll.pinSoon();
    }

    // when puts the time ms under a message, after the buttons that sit
    // there; a message shows its time once, and a time that is not known
    // shows nothing.
    when(node, ms) {
      if (!window.HubTimes.valid(ms)) return;
      if (node.whenLine && node.whenLine.dataset.at) return;
      if (!node.whenLine) {
        node.whenLine = this.env.el("div", "when" + (node.classList.contains("user") ? " mine" : ""));
        let ref = node;
        while (ref.nextElementSibling && ["queued", "lost", "acts"].some((c) => ref.nextElementSibling.classList.contains(c))) ref = ref.nextElementSibling;
        ref.after(node.whenLine);
      }
      window.HubTimes.stamp(node.whenLine, ms);
    }

    ensureTurn() {
      if (this.turn) return this.turn;
      this.turn = { reasoning: null, text: null, raw: "" };
      // A new turn: an image looked at in the last one gets no later answer.
      if (this.answers) this.answers.end();
      return this.turn;
    }

    // reasoning adds to the turn's thinking block. A stored row's thinking
    // (fresh) starts a block of its own when anything came after the last
    // one, so the log keeps the order the steps happened in.
    reasoning(text, fresh) {
      const { el } = this.env;
      const tn = this.ensureTurn();
      if (tn.reasoning && fresh && tn.reasoning !== this.lastNode()) tn.reasoning = null;
      if (!tn.reasoning) {
        const d = el("details", "reasoning");
        d.open = true;
        d.append(el("summary", "", "Thinking"), el("div", "body"));
        tn.reasoning = this.add(d);
        tn.text = null;
      }
      this.follow(() => { tn.reasoning.lastChild.textContent += text; });
      if (this.answers) this.answers.text("think", text, true);
    }

    // lastNode is the last thing drawn, without the status line and the
    // time under a message.
    lastNode() {
      const box = this.sink || this.log;
      let n = box.lastElementChild;
      while (n && (n === this.status || n.classList.contains("when") || n.classList.contains("acts"))) n = n.previousElementSibling;
      return n;
    }

    // assistantText adds to the reply. A streamed delta renders at most
    // once per frame; anything else renders at once.
    assistantText(text, streamed) {
      if (typeof text !== "string") text = "";
      const tn = this.ensureTurn();
      if (!tn.text) {
        tn.text = this.add(this.env.el("div", "msg assistant md"));
        tn.raw = "";
        if (tn.reasoning) this.ui.closeUnlessKept(tn.reasoning);
      }
      tn.raw += text;
      if (this.answers) this.answers.text("say", text, true);
      const node = tn.text;
      node.raw = tn.raw;
      if (!streamed) {
        node.queued = false;
        this.follow(() => this.showText(node, true));
        return;
      }
      if (node.queued) return;
      node.queued = true;
      requestAnimationFrame(() => {
        if (!node.queued) return;
        node.queued = false;
        this.follow(() => this.showText(node, false));
      });
    }

    // showText renders a reply without its page blocks and MEDIA
    // directives. Once the reply is final it shows the pages and the files
    // they name; while it streams it also hides a directive or page that is
    // still being typed.
    showText(node, final) {
      const { el, media } = this.env;
      const pg = window.HubPageBlocks.pageBlocks(node.raw || "", !final);
      const m = media.directives(pg.text);
      // A streamed reply draws only its open last blocks again each frame.
      this.env.render(node, final ? m.text : media.hidePending(m.text), final ? (p, label, image) => media.markdownMedia(this.base, p, label, image) : null, !final);
      // A page whose closing fence has streamed in gets its card at once;
      // only a page still being typed shows the wait note.
      if (pg.pages.length) {
        const row = el("div", "media");
        for (const html of pg.pages) row.append(media.pageCard(this.base, { html }));
        node.append(row);
      }
      if (!final && pg.writing) node.append(el("div", "note page-wait", "Writing a page"));
      const paths = m.paths.filter((p) => !(this.published && this.published.has(p)));
      if (final && paths.length) node.append(media.mediaRow(this.base, paths));
      if (final) this.when(node, this.at);
    }

    // endText shows the files of the reply segment that ends here.
    endText() {
      const tn = this.turn;
      if (!tn || !tn.text) return;
      tn.text.queued = false;
      this.follow(() => this.showText(tn.text, true));
    }

    // originCard shows what HubOrigin.classify said of a user message that
    // the user did not type: nothing for a hidden one, else its card (see
    // notice.js). It returns true when that is all the message shows, and
    // false when the user's bubble with v.text follows. A queued card shows
    // as waiting until its turn starts.
    originCard(v, text, waiting) {
      const done = this.originCard1(v, text, waiting);
      if (done) this.afterCards(v, waiting);
      return done;
    }

    // afterCards shows the cards of the blocks Hermes joined after the user's words (an agent
    // message, a subagent result): their own cards, never inside the user's bubble. Call it after
    // the bubble; originCard does it for a row that is only cards.
    afterCards(v, waiting) {
      for (const a of v.after || []) this.originCard1({ show: "card", notice: a.notice }, a.text, waiting);
    }

    originCard1(v, text, waiting) {
      const { el, toast, t } = this.env;
      if (v.show === "hidden") return true;
      const n = v.notice;
      if (!n) return false;
      if (v.show === "user") {
        this.add(window.HubNotice.card(n, text, { el, toast, at: waiting ? 0 : this.at }));
        return false;
      }
      if (!this.agentWaiting) this.agentWaiting = new Map();
      const key = n.id || "text:" + text;
      const shown = this.agentWaiting.get(key);
      if (shown) {
        this.agentWaiting.delete(key);
        shown.classList.remove("pending");
        if (shown.waitLabel) shown.waitLabel.remove();
        window.HubNotice.stamp(shown, this.at, { el });
        return true;
      }
      const box = window.HubNotice.card(n, text, { el, toast, at: waiting ? 0 : this.at });
      box.dataset.ukey = "n:" + this.ui.hash(text);
      if (n.id) box.title = n.id;
      if (n.kind === "agent" && this.env.agentCard) this.env.agentCard(this, box, n.id);
      this.add(box);
      if (waiting) {
        box.classList.add("pending");
        box.waitLabel = el("div", "queued", t("waiting"));
        box.after(box.waitLabel);
        this.agentWaiting.set(key, box);
      }
      return true;
    }

    // userText adds a user message. atts are the files the page sent with
    // it; without them they come from the lines Hermes keeps in the text.
    userText(text, pending, atts, seen) {
      const { el, media } = this.env;
      const shown = atts ? { text, atts } : media.split(text);
      const from = window.HubPageSend.split(shown.text);
      shown.text = from.text;
      const m = el("div", "msg user" + (pending ? " pending" : ""));
      if (from.page) m.append(el("div", "frompage", "From page: " + from.page));
      if (shown.atts.length) m.append(media.attachmentRow(shown.atts, this.base, seen));
      if (shown.text) {
        // The user's own words render as Markdown, as a reply does.
        const body = el("div", "utext");
        if (window.hubMarkdown && window.hubMarkdown.renderUser) window.hubMarkdown.renderUser(body, shown.text);
        else window.HubLinkify.append(body, shown.text);
        m.append(body);
      }
      m.rawText = shown.text || "";
      if (atts) for (const a of atts) if (a.url) this.urls.push(a.url);
      this.add(m);
      if (pending) this.pending.push({ bubble: m, label: null, text, id: null, at: Date.now() });
      else this.when(m, this.at);
      return m;
    }

    // label replaces the line under a pending message.
    label(p, node) {
      if (p.label) p.label.remove();
      p.label = node;
      p.bubble.after(node);
    }

    toolCard(id, name, args) {
      let card = this.tools.get(id);
      if (card) return card;
      if (!this.known) this.known = window.HubToolCard.memory();
      if (!this.answers) this.answers = window.HubToolCard.answers();
      this.answers.start();
      card = window.HubToolCard.mount(this.cardContext(), { key: id, name: name || "tool", args, startedAt: this.at, mem: this.known });
      this.tools.set(id, card);
      this.endText();
      // A card ends the thinking before it and the reply text: what comes
      // next opens a new block after the card, so the log keeps the order
      // the steps happened in.
      const tn = this.ensureTurn();
      tn.text = null;
      if (tn.reasoning) this.ui.closeUnlessKept(tn.reasoning);
      tn.reasoning = null;
      this.add(card);
      return card;
    }

    tagBatch(card, id) {
      card.batch = id;
      card.call.batch = id;
    }

    // toolCards draws the card of a live tool call. A tool_call of Hermes
    // carries several calls: each gets its own card, as when saved rows
    // load, and they fold with the cards around them.
    toolCards(id, name, args) {
      const w = this.wraps.get(id);
      if (w) return w.cards;
      const list = window.HubToolCard.calls(id, name, args);
      if (!list) return [this.toolCard(id, name, args)];
      const cards = list.map((x) => {
        const c = this.toolCard(x.key, x.name, x.args);
        if (x.batch) this.tagBatch(c, x.batch);
        return c;
      });
      this.wraps.set(id, { cards });
      return cards;
    }

    // toolsDone finishes the card or cards of a live call. Hermes ends a
    // tool_call with one event; when its result is a list with a result
    // for each call, each card gets its own, else each shows the result.
    // A result of one of the calls inside (p.one, as a stored row has it)
    // finishes the first card of its tool that has no result yet, or the
    // first that has none when it names no tool.
    toolsDone(p) {
      const cards = this.toolCards(p.tool_id, p.name, p.args);
      if (!this.wraps.has(p.tool_id)) {
        this.toolDone(cards[0], p);
        return;
      }
      if (p.one) {
        const free = cards.filter((c) => !c.finished);
        const card = free.find((c) => c.toolName === p.name) || (!p.name || p.name === "tool_call" ? free[0] : null);
        if (card) this.toolDone(card, Object.assign({}, p, { args: undefined }));
        return;
      }
      const parts = window.HubToolCard.split(p.result, cards.length);
      cards.forEach((card, i) => {
        const own = parts && parts.length === cards.length ? parts[i] : undefined;
        const one = own === undefined ? p : Object.assign({}, p, { result: own, result_text: undefined });
        this.toolDone(card, one);
      });
    }

    // toolDone shows a finished tool card through the one card component
    // (toolcard.js). at is when it finished: the time of the event or row
    // that says so, 0 for a card that no event closed.
    toolDone(card, p, at = this.at) {
      window.HubToolCard.finish(this.cardContext(), card, { result: p.result, result_text: p.result_text, is_error: p.is_error, error: p.error,
        inline_diff: p.inline_diff, duration: typeof p.duration_s === "number" ? p.duration_s : undefined, endedAt: at || 0, cut: p.cut,
        size: typeof p.size === "number" ? p.size : undefined, args: p.args, seen: seenImages(p.seen_images) });
      if (this.answers) this.answers.tool(card);
    }

    // groupTools folds each run of finished tool cards into one line that
    // opens to show them. keep is a node after which cards stay as they
    // are. A run right after a group joins it.
    groupTools(keep, parent = this.log) {
      window.HubToolGroup.fold(this.env.el, parent, keep, (c) => this.ui.expanded(c), true);
    }

    compacted() {
      if (typeof this.compactions === "number") this.compactions++;
      this.add(this.env.el("div", "note", "Older messages were summarized to make room."));
    }

    setStatus(text) {
      if (!text) {
        if (this.status) this.status.remove();
        this.status = null;
        return;
      }
      if (!this.status) {
        this.status = this.env.el("div", "status");
        this.log.append(this.status);
      }
      this.status.textContent = text;
    }

    // failLine shows a failed turn: Hermes' failure copy around the
    // provider's raw answer, as one plain line with the rest folded.
    failLine(text) {
      const { el } = this.env;
      const f = window.HubPlain.failure(text);
      const note = el("div", "note bad failline", f.line);
      const more = el("details", "faildetails");
      more.append(el("summary", "", "Details"), el("pre", "", f.details));
      note.append(more);
      this.add(note);
    }

    // turnEnd draws the end of a turn: the reply or the failure it ended
    // with, its status when it did not complete, and the finished cards
    // folded into groups.
    turnEnd(p) {
      const { el } = this.env;
      this.setStatus("");
      const tn = this.ensureTurn();
      const failed = p.status === "error" || p.status === "failed";
      let failLine = false;
      if (failed && !tn.text && !tn.raw && typeof p.text === "string" && p.text) {
        this.failLine(p.text);
        failLine = true;
      } else if (!tn.text && !tn.raw && typeof p.text === "string" && p.text) this.assistantText(p.text);
      else this.endText();
      if (tn.reasoning) this.ui.closeUnlessKept(tn.reasoning);
      if (!failLine && p.status && p.status !== "complete" && p.status !== "completed") {
        this.add(el("div", "note" + (failed ? " bad" : ""), "Turn " + p.status + (p.error ? ": " + p.error : "")));
      }
      for (const card of this.tools.values()) if (card.classList.contains("running")) this.toolDone(card, {}, 0);
      this.groupTools(null);
      this.turn = null;
    }

    // row draws one stored row of a chat's history.
    row(m) {
      if (m.display_kind === "hidden") return;
      const { el, toast } = this.env;
      const text = m.text != null ? m.text : (typeof m.content === "string" ? m.content : "");
      const rid = Number.isInteger(m.row_id) ? m.row_id : m._row_id;
      this.at = window.HubTimes.valid(m.timestamp * 1000) ? Math.round(m.timestamp * 1000) : 0;
      if (m.role === "user") {
        this.turn = null;
        const v = window.HubOrigin.classify(m);
        if (this.originCard(v, text)) return;
        const b = this.userText(v.text, false, undefined, seenImages(seenOf(m.display_metadata)));
        if (b && Number.isInteger(rid)) b.dataset.row = rid;
        this.afterCards(v);
        return;
      }
      if (m.role === "assistant") {
        if (this.answers) this.answers.step();
        const sum = m.archived ? window.HubNotice.parse(text) : null;
        if (sum && sum.kind === "compaction") {
          this.add(window.HubNotice.card(sum, text, { el, toast, at: this.at }));
          return;
        }
        for (const c of m.tool_calls || []) {
          const fn = c.function || {};
          let args = fn.arguments;
          if (typeof args === "string") {
            try { args = JSON.parse(args); } catch (_) { args = { arguments: args }; }
          }
          const call = { name: fn.name, args, at: this.at };
          const inner = window.HubToolCard.wrapped(fn.name, args);
          if (inner) {
            call.inner = inner;
            call.batchSize = inner.length;
          }
          if (!this.calls) this.calls = new Map();
          if (c.id) this.calls.set(c.id, call);
          if (c.call_id) this.calls.set(c.call_id, call);
        }
        const r = m.reasoning || m.reasoning_content;
        if (r) { this.reasoning(r, true); this.ui.closeUnlessKept(this.turn.reasoning); }
        if (text) {
          this.assistantText(text);
          if (Number.isInteger(rid) && !this.turn.text.dataset.row) this.turn.text.dataset.row = rid;
          // A reply stored in pieces cut inside a fenced block goes on in
          // the same bubble, so its page block stays whole.
          if (!window.HubPageBlocks.open(this.turn.raw)) this.turn.text = null;
        }
        return;
      }
      if (m.role === "tool") {
        let call = (this.calls && this.calls.get(m.tool_call_id)) || {};
        if (call.inner) {
          const one = window.HubToolCard.take(call.inner, m.name || m.tool_name);
          if (one) call = Object.assign(one, { unwrapped: true, batch: call.batchSize > 1 ? m.tool_call_id || "" : "" });
        }
        // The card starts when the call was asked for (the assistant row's
        // time) and ends at the result's; the row's tool outcome says how
        // long it ran and whether it failed.
        const at = this.at;
        this.at = call.at || 0;
        const card = this.toolCard(m.tool_call_id && !call.unwrapped ? m.tool_call_id : "row" + m.row_id, m.name || m.tool_name || call.name, m.args || call.args);
        if (call.batch) this.tagBatch(card, call.batch);
        this.at = at;
        const cut = m.output_size ? { row: Number.isInteger(m.row_id) ? m.row_id : 0, call: m.tool_call_id || "", size: m.output_size, lines: m.output_lines || 0 } : null;
        const oc = toolOutcome(m.display_metadata);
        this.toolDone(card, { result: m.content != null ? m.content : text, cut, is_error: oc.is_error === true,
          seen_images: seenOf(m.display_metadata),
          duration_s: typeof oc.duration_ms === "number" ? oc.duration_ms / 1000 : undefined });
        return;
      }
      if (text) this.add(el("div", "note", text));
    }

    // draw handles the events that only draw in the log; it returns false
    // for any other.
    draw(kind, p) {
      const { el } = this.env;
      switch (kind) {
        case "reasoning.delta": this.reasoning(p.text || ""); return true;
        case "reasoning.available":
          if (!this.ensureTurn().reasoning) { this.reasoning(p.text || ""); this.ui.closeUnlessKept(this.turn.reasoning); }
          return true;
        case "thinking.delta": this.setStatus(p.text || ""); return true;
        case "status.update":
          if (p.kind === "compacted") { this.setStatus(""); this.compacted(); }
          else if (p.kind === "compacting") this.setStatus("Summarizing older messages to make room...");
          else if (p.text) this.setStatus(p.text);
          return true;
        case "tool.generating": if (this.answers) this.answers.step(); this.setStatus("Preparing " + (p.name || "a tool") + "..."); return true;
        case "tool.start": this.setStatus(""); this.toolCards(p.tool_id, p.name, p.args); return true;
        case "tool.progress": {
          const card = this.toolCards(p.tool_id, p.name)[0];
          const live = card.view.live;
          let bar = live.querySelector("progress");
          if (!bar && p.total) { bar = el("progress"); live.append(bar); }
          if (bar && p.total) { bar.max = p.total; bar.value = p.progress; }
          let msg = live.querySelector(".progress");
          if (p.message) {
            if (!msg) { msg = el("div", "status progress"); live.append(msg); }
            msg.textContent = p.message;
          }
          return true;
        }
        case "tool.complete": this.toolsDone(p); return true;
        case "message.delta": this.setStatus(""); if (typeof p.text === "string" && p.text) this.assistantText(p.text, true); return true;
        case "message.interim":
          if (p.text && !p.already_streamed) {
            this.assistantText(p.text);
            // A piece that ends inside a fenced block: the next one goes on in the same bubble.
            if (!window.HubPageBlocks.open(this.turn.raw)) this.turn.text = null;
          }
          return true;
        case "error": this.add(el("div", "note bad", p.message || "Error")); return true;
        default: return false;
      }
    }
  }

  // seenImages keeps the well-formed records of the copies Hermes stored of
  // the images a call gave the model ({ id, mime, w, h, thumb }).
  function seenImages(list) {
    return Array.isArray(list)
      ? list.filter((x) => x && typeof x === "object" && /^[0-9a-f]{64}$/.test(x.id)).slice(0, 8)
      : [];
  }

  // seenOf is the seen_images of a stored row's display metadata, an object
  // or a JSON string of one.
  function seenOf(md) {
    if (typeof md === "string") {
      try { md = JSON.parse(md); } catch (_) { md = null; }
    }
    return md && typeof md === "object" ? md.seen_images : null;
  }

  // toolOutcome is the tool_outcome of a stored tool row's display metadata
  // ({ duration_ms, is_error }), or {}.
  function toolOutcome(md) {
    if (typeof md === "string") {
      try { md = JSON.parse(md); } catch (_) { md = null; }
    }
    const o = md && typeof md === "object" ? md.tool_outcome : null;
    return o && typeof o === "object" ? o : {};
  }

  return { ChatView, scroller, jumpButton, probe, toolOutcome, seenImages, seenOf };
})();
