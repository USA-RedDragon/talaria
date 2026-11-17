"use strict";
// Cards of the browser: open, act on and read pages, steps, tabs, sign-in.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register. Reading,
// looking at and running scripts in a page are in look.js.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, host, verb, errorText, keyName, rawOf } = H.util;

  const roleWords = {
    textbox: "Text field", searchbox: "Search field", button: "Button", link: "Link", combobox: "Dropdown", checkbox: "Checkbox", radio: "Radio button",
    menuitem: "Menu item", tab: "Tab", listbox: "List", option: "Option", switch: "Switch", slider: "Slider", heading: "Heading", img: "Image",
  };

  // targetOf is what the device plugin said the call acted on: { role, name }.
  const targetOf = (c) => (isObj(c.res) && isObj(c.res.target) ? c.res.target : null);

  // targetName is the label the page gave the element, else its role. A ref
  // is never shown.
  function targetName(c) {
    const t = targetOf(c);
    if (!t) return "";
    return str(t.name) ? short(t.name) : str(t.role) ? "the " + short(t.role) : "";
  }

  // targetKind is the element in plain words for the expanded card: Text
  // field "Search".
  function targetKind(c) {
    const t = targetOf(c);
    if (!t) return "";
    const role = str(t.role).toLowerCase();
    const word = roleWords[role] || (role ? upper(role) : "");
    const name = str(t.name) ? '"' + short(t.name) + '"' : "";
    return [word, name].filter(Boolean).join(" ");
  }

  const upper = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const hostOfUrl = (u) => (str(u) ? host(str(u)) : "");

  // hostPath is an address without its scheme, query and a lone slash.
  function hostPath(u) {
    return str(u).replace(/^[a-z]+:\/\//i, "").split(/[?#]/)[0].replace(/\/$/, "");
  }

  const pageLine = (title, url) => [short(title), hostPath(url)].filter(Boolean).join(" · ");

  // refusal says a failed call was a refusal, and by whom.
  function refusal(c) {
    const code = isObj(c.res) ? str(c.res.code) : "";
    return code === "declined" ? "declined" : code === "approval" ? "approval" : "";
  }

  // fail gives the status of a failed call: a refusal in warn color, else
  // the error. prefix is put before the error text ("Failed: ").
  function fail(c, out, prefix) {
    if (!c.failed) return false;
    const r = refusal(c);
    out.ownFailure = true;
    if (r === "declined") {
      out.tone = "warn";
      out.status = "Not allowed: you declined this";
    } else if (r === "approval") {
      out.tone = "warn";
      out.status = "Not allowed: it needs your approval";
    } else {
      out.status = (prefix || "") + (cut(squash(errorText(c.res) || str(c.error) || first(c.out)), 100) || "the call did not work");
    }
    return true;
  }

  // opaque is the call and result as JSON for the Raw toggle, only for a
  // failure whose only trace is the JSON.
  function opaque(c) {
    if (!c.failed) return "";
    return errorText(c.res) || str(c.error) ? "" : rawOf(c);
  }

  // The steps of a browser_batch call -------------------------------------

  // batchSteps is the steps of a browser_batch result: their words, state
  // and the outcome shown beside it. A result from a plugin that sends no
  // details falls back to its step lines.
  function batchSteps(res) {
    if (Array.isArray(res.details) && res.details.length) {
      return res.details.filter(isObj).map((d) => ({
        text: short(d.text) || "Step " + str(d.step),
        state: str(d.state) || "done",
        why: short(d.error),
        outcome: d.state === "failed" ? "Failed: " + (short(d.error) || "the step did not work") : d.state === "not_run" ? "Not run" : "Done" + (str(d.approved) ? " · approved " + short(d.approved) : ""),
        form: d.action === "type" || d.action === "select",
      }));
    }
    if (Array.isArray(res.steps)) {
      return res.steps.map((l) => {
        const t = str(l).replace(/^\d+\.\s*/, "");
        const failed = /^Failed:/.test(t);
        const skipped = /^Not run:/.test(t);
        return { text: short(t.replace(/^(Failed|Not run):\s*/, "")), state: failed ? "failed" : skipped ? "not_run" : "done", why: "", outcome: failed ? "Failed" : skipped ? "Not run" : "Done", form: /^(Typed into|Selected)/.test(t) };
      });
    }
    return [];
  }

  // askedStep is one step the agent asked for, in plain words, from the
  // call's arguments: the element's label, else its role, else its ref. What
  // would be typed is never shown.
  function askedStep(x) {
    if (!isObj(x)) return "A step that is not an object";
    const act = str(x.action).toLowerCase();
    const el = str(x.name) ? '"' + short(x.name) + '"' : str(x.role) ? "the " + short(x.role) : str(x.ref) ? "element " + short(x.ref) : "";
    switch (act) {
      case "click": return "Click " + (el || "an element");
      case "hover": return "Hover over " + (el || "an element");
      case "type": case "fill": return "Type into " + (el || "an element");
      case "select": return (str(x.value) ? "Select " + short(x.value) + " in " : "Choose an option in ") + (el || "a list");
      case "press": case "key": return "Press " + (short(x.key) || "a key") + (el ? " on " + el : "");
      case "scroll": return "Scroll " + (str(x.to_text) ? "to " + short(x.to_text) : el ? "to " + el : str(x.direction) ? short(x.direction) : "the page");
      case "wait_for": case "wait": return "Wait for " + (short(x.text) || short(x.selector) || "something on the page");
      case "navigate": case "goto": case "open": return "Open " + (hostOfUrl(x.url) || short(x.url) || "a page");
      default: return act ? "Step: " + short(act) : "A step with no action";
    }
  }

  const stepsText = (items) => items.map((x, i) => (i + 1) + ". " + x.text + " (" + x.outcome + ")").join("\n");

  // batchHints say in plain words what a step's failure code means.
  const batchHints = {
    gone: "The page changed, so the element was not found; the page has to be read again.",
    approval: "This step needs your approval; it has to run on its own.",
    declined: "You said no.",
    timeout: "The steps ran out of time.",
  };

  // batchRefused is the card of a batch that came back with an error and no
  // step results: it never ran (the plugin refused it before the first step,
  // the user declined it, or the browser was not there). The body is the
  // whole error and the steps the agent asked for, each marked not run, the
  // one the error names marked failed.
  function batchRefused(c, a, res) {
    let e = str(res.error) || str(res.message) || str(c.error) || first(c.out);
    e = e.trim();
    const given = Array.isArray(a.steps) ? a.steps : [];
    const m = /\bstep (\d+)\b/i.exec(e);
    const at = m && +m[1] >= 1 && +m[1] <= given.length ? +m[1] : 0;
    const out = { icon: "list", bad: true, ownFailure: true, blocks: [], lines: [] };
    out.title = given.length ? "Browser steps not run: " + given.length : "Browser steps not run";
    if (str(res.code) === "declined") {
      out.status = "You declined; nothing ran";
      out.tone = "warn";
    } else {
      out.status = "Not run";
      if (e) out.lines.push(e);
    }
    out.blocks.push({ label: "Error", plain: true, text: e || "The call did not work." });
    const items = given.map((x, i) => ({ text: askedStep(x), state: i + 1 === at ? "failed" : "not_run", outcome: i + 1 === at ? "Not valid" : "Not run", form: false }));
    if (items.length) out.blocks.push({ label: "Steps asked for", kind: "steps", items, text: stepsText(items) });
    return out;
  }

  function batch_(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    if (c.done && (c.failed || str(res.error)) && !batchSteps(res).length) return batchRefused(c, a, res);
    const out = { icon: "list", blocks: [], lines: [] };
    const given = Array.isArray(a.steps) ? a.steps : [];
    const steps = c.done ? batchSteps(res) : [];
    // Steps the result does not list (the batch ran out of time) were not run.
    if (c.done && steps.length && steps.length < given.length) {
      for (let i = steps.length; i < given.length; i++) steps.push({ text: askedStep(given[i]), state: "not_run", why: "", outcome: "Not run", form: false });
    }
    const total = steps.length || (typeof res.total === "number" ? res.total : given.length);
    const page = isObj(res.page) ? res.page : null;
    const site = hostOfUrl(page && page.url) || hostOfUrl((given.find((x) => isObj(x) && x.url) || {}).url);
    const form = steps.some((x) => x.form) || given.some((x) => isObj(x) && (x.action === "type" || x.action === "fill" || x.action === "select"));
    const done = steps.filter((x) => x.state === "done").length;
    const stopped = steps.findIndex((x) => x.state !== "done");
    const bad = c.done && (res.ok === false || stopped >= 0) && !c.failed;
    const count = bad ? done + " of " + total + " steps" : plural(total, "step");
    const on = site ? " on " + site : "";
    if (!c.done) {
      out.title = (form ? "Filling the form" : "Running " + plural(total || 1, "browser step")) + on;
    } else if (form) {
      out.title = "Filled the form" + on + ": " + count;
    } else if (steps.length && steps.length <= 3 && !bad) {
      out.title = steps.map((x) => x.text).join(", then ");
    } else {
      out.title = "Ran " + (bad ? count : plural(total, "browser step")) + on;
    }
    if (bad) {
      out.bad = true;
      const at = stopped >= 0 ? stopped + 1 : isObj(res.failed) ? res.failed.step : 0;
      out.status = at ? "Stopped at step " + at : "Stopped";
      const f = steps.find((x) => x.state === "failed");
      if (f) out.lines.push(f.text + (f.why ? ": " + f.why : ""));
    } else {
      out.status = "Done";
    }
    const title = page ? short(page.title) : "";
    const ended = [title ? 'Ended on "' + title + '"' : "", res.opened_tab === true ? (title ? "opened a new tab" : "Opened a new tab") : ""].filter(Boolean).join(" · ");
    if (c.done && ended) out.lines.push({ parts: ended, dim: true });
    if (steps.length) out.blocks.push({ label: "Steps", kind: "steps", items: steps, text: stepsText(steps) });
    const hint = bad && isObj(res.failed) ? batchHints[str(res.failed.code)] : "";
    if (hint) out.blocks.push({ plain: true, text: hint });
    if (page && (str(page.snapshot) || str(page.text))) {
      const meta = [str(page.title), site, Number.isFinite(page.element_count) ? plural(page.element_count, "element") : ""].filter(Boolean).join(" · ");
      out.blocks.push({ label: "Page read at the end", kind: "page", meta, text: str(page.snapshot) || str(page.text) });
    } else if (str(res.page_error)) {
      out.blocks.push({ label: "Page read at the end", plain: true, text: str(res.page_error) });
    }
    if (c.done && !steps.length && !Object.keys(res).length) out.raw = opaque(c) || (c.out ? rawOf(c) : "");
    return out;
  }

  // Open a page, go back --------------------------------------------------

  function navigate(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const asked = str(a.url);
    const site = hostOfUrl(asked);
    const out = { icon: "globe", blocks: [], lines: [] };
    if (!c.done) {
      out.title = "Opening" + (site ? " " + site : " a page");
      out.status = "Loading";
      out.keepRunStatus = true;
      return out;
    }
    const gaveUp = c.failed;
    out.title = (gaveUp ? "Could not open " : "Opened ") + (site || "a page");
    if (gaveUp) {
      fail(c, out, "Failed: ");
      if (asked) out.lines.push({ parts: hostPath(asked), dim: true });
      out.raw = opaque(c);
      return out;
    }
    const url = str(res.url);
    const line = str(res.title) ? pageLine(res.title, url) : hostPath(url);
    if (line) out.lines.push(line);
    const landed = hostOfUrl(url);
    if (landed && site && landed !== site) out.lines.push({ parts: "Redirected from " + hostPath(asked), dim: true });
    const chips = [res.reused_tab === true ? "Reused idle tab" : "", a.new_tab === true ? "New tab" : "", a.keep === true ? "Kept open" : ""].filter(Boolean);
    if (chips.length) out.lines.push({ parts: chips.map((x) => ({ chip: x })) });
    const rows = [];
    if (url) rows.push({ k: "Landed on", v: [{ code: url }] });
    if (asked && url && asked !== url && landed !== site) rows.push({ k: "Asked for", v: [{ code: asked }] });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    return out;
  }

  function back(c) {
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "eye", blocks: [], lines: [] };
    if (!c.done) {
      out.title = "Going back a page";
      return out;
    }
    if (c.failed) {
      out.title = "Could not go back a page";
      fail(c, out, "Failed: ");
      out.raw = opaque(c);
      return out;
    }
    out.title = str(res.title) ? "Went back to " + short(res.title) : "Went back a page";
    const where = hostPath(res.url);
    if (where) out.lines.push(where);
    if (str(res.url)) out.blocks.push({ kind: "kv", rows: [{ k: "Landed on", v: [{ code: str(res.url) }] }] });
    return out;
  }

  // Single actions: click, type, press, choose, hover, scroll -------------

  const secretTarget = /pass(word|code)?\b|secret|otp|one[- ]?time|\bcvc\b|\bcvv\b|card number|credit card|\bpin\b|token/i;

  // hiddenText says a typed value must not be shown: the field looks like a
  // password, code or card field. The plugin's secret flag says it for a
  // password field; the name of the target covers the other kinds.
  function hiddenText(c) {
    if (isObj(c.res) && c.res.secret === true) return "password field";
    const t = targetOf(c);
    if (!t) return "";
    const what = str(t.name) + " " + str(t.role);
    if (!secretTarget.test(what)) return "";
    return /pass/i.test(what) ? "password field" : "sensitive field";
  }

  // pressed puts the default action of a key press in words.
  const pressWords = {
    typed: "Typed the character", clicked: "Clicked the element", submitted: "Submitted the form", "focus moved": "Moved focus", focus_moved: "Moved focus",
    scrolled: "Scrolled the page", none: "Nothing happened", "cancelled by the page": "The page cancelled the key", cancelled: "The page cancelled the key",
  };

  function scrollTitle(c, a) {
    const dirn = str(a.direction).toLowerCase();
    const pages = Number(a.pages);
    const t = targetName(c);
    if (str(a.to_text)) return "Scrolled to " + short(a.to_text);
    if (str(a.ref)) return "Scrolled to " + (t || "an element");
    if (dirn === "top") return "Scrolled to the top";
    if (dirn === "bottom") return "Scrolled to the bottom";
    if (dirn === "up" || dirn === "down") return "Scrolled " + dirn + (Number.isFinite(pages) && pages > 0 ? " " + plural(pages, "page") : " the page");
    return "Scrolled the page";
  }

  // act is one of the single actions of the browser.
  function act(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const op = c.name.replace(/^browser_/, "");
    const tn = targetName(c);
    const out = { icon: op === "scroll" ? "eye" : "cursor", blocks: [], lines: [] };
    const hidden = op === "type" ? hiddenText(c) : "";
    const typed = str(a.text);
    const value = str(a.value);
    const choice = tn ? tn + (value ? ": " + short(value) : "") : value ? short(value) : "an option";
    const words = {
      click: ["Clicked " + (tn || "an element"), "Clicking" + (tn ? " " + tn : ""), "Could not click " + (tn || "an element")],
      type: ["Typed into " + (tn || "an element"), "Typing into" + (tn ? " " + tn : ""), "Could not type into " + (tn || "an element")],
      press: ["Pressed " + keyName(a.key) + (tn ? " in " + tn : ""), "Pressing" + (keyName(a.key) ? " " + keyName(a.key) : ""), "Could not press " + (keyName(a.key) || "the key")],
      select: ["Chose " + choice, "Choosing" + (tn ? " in " + tn : ""), "Could not choose in " + (tn || "the list")],
      hover: ["Hovered over " + (tn || "an element"), "Hovering over" + (tn ? " " + tn : ""), "Could not hover over " + (tn || "an element")],
      scroll: [scrollTitle(c, a), "Scrolling the page", "Could not scroll the page"],
    }[op] || ["Used the browser", "Using the browser", "Could not use the browser"];
    if (op === "press" && !keyName(a.key)) words[0] = "Pressed a key" + (tn ? " in " + tn : "");
    out.title = !c.done ? words[1] : c.failed ? words[2] : words[0];
    if (!c.done) return out;
    if (fail(c, out, "")) {
      out.raw = opaque(c);
      return out;
    }
    out.status = "Done";
    const url = str(res.url);
    if (op === "type") {
      const sub = a.submit === true;
      if (hidden) out.lines.push({ parts: "Text hidden (" + hidden + ")" + (sub ? " and submitted" : ""), dim: true });
      else if (typed) out.lines.push([{ code: cut(squash(typed), 80) }, sub ? " and submitted" : ""]);
    } else if (op === "press") {
      const d = str(res.default_action);
      if (d) out.lines.push(pressWords[d] || upper(short(d)));
    } else if (op === "scroll") {
      const dirn = str(a.direction).toLowerCase();
      if (res.found === false) {
        out.status = "Text not found on the page";
        out.tone = "warn";
      } else if (res.at_bottom === true && (dirn === "down" || dirn === "bottom")) out.lines.push("Reached the bottom of the page");
      else if (res.at_top === true && (dirn === "up" || dirn === "top")) out.lines.push("Reached the top of the page");
      else if (res.at_bottom === false && dirn === "down") out.lines.push({ parts: "Not at the end yet", dim: true });
    }
    // The page changed because of the action (the plugin says so with navigated).
    if (res.navigated === true && op !== "scroll" && op !== "hover") {
      const now = pageLine(res.title, url);
      if (now) out.lines.push("Page now: " + now);
    }
    const rows = [];
    const kind = targetKind(c);
    if (kind) rows.push({ k: "Element", v: kind });
    if (op === "type" && typed && !hidden) rows.push({ k: "Typed", v: [{ code: typed.length > 400 ? typed.slice(0, 400) + "…" : typed }, " (" + plural(Array.from(typed).length, "character") + ")"] });
    if (op === "select" && value) rows.push({ k: "Chose", v: short(value) });
    if (op === "press" && keyName(a.key)) rows.push({ k: "Key", v: keyName(a.key) });
    if (str(res.title)) rows.push({ k: "Page now", v: short(res.title) });
    if (url) rows.push({ k: "Address", v: [{ code: url }] });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    return out;
  }

  // Sign-in, saved logins and the sign-in check ----------------------------

  const secretKey = /pass|secret|token|code|cvc|card|number|otp|key/i;

  function scrub(v) {
    if (Array.isArray(v)) return v.map(scrub);
    if (!isObj(v)) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = secretKey.test(k) && typeof x !== "boolean" ? "(hidden)" : scrub(x);
    return o;
  }

  function vault(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "key", blocks: [] };
    const where = host(str(a.url) || str(a.host) || str(a.domain) || str(res.host) || str(res.url));
    const looking = !str(a.action) || str(a.action) === "list";
    out.title = (looking ? verb(c, "Looked for", "Looking for") : verb(c, "Used", "Using")) + " a saved login" + (where ? " on " + where : "");
    const list = Array.isArray(res.logins) ? res.logins : Array.isArray(res.entries) ? res.entries : Array.isArray(res.items) ? res.items : null;
    out.status = list ? (list.length ? plural(list.length, "login") : "No saved login") : "Done";
    // Never show what the vault returned: it may hold a secret. Its call is
    // shown only when it holds more than the action and the address.
    const extra = Object.keys(a).filter((k) => !["action", "url", "host", "domain"].includes(k));
    if (extra.length) out.blocks.push({ label: "Call", text: JSON.stringify(scrub(a), null, 2), pre: true });
    return out;
  }

  function login(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const site = hostOfUrl(a.url) || (c.done ? hostOfUrl(res.landed_host) || str(res.landed_host) : "");
    const on = site ? " on " + site : " on the open tab";
    const out = { icon: "key", blocks: [], lines: [] };
    if (!c.done) {
      out.title = "Signing in" + on;
      out.status = "Waiting for the page to fill";
      out.keepRunStatus = true;
      return out;
    }
    const err = errorText(res) || str(c.error);
    if (c.failed) {
      const r = refusal(c);
      const blocked = /not allowed|not on|sign-in list|blocked|autologin/i.test(err);
      out.title = blocked ? "Sign-in not allowed" + (site ? " on " + site : "") : "Could not sign in" + on;
      out.ownFailure = true;
      if (r === "declined") {
        out.tone = "warn";
        out.status = "You declined";
      } else if (blocked) {
        out.status = "Blocked";
        out.more = [cut(squash(err), 100)];
      } else {
        out.status = "Failed: " + (cut(squash(err), 100) || "the call did not work");
      }
      out.raw = opaque(c);
      return out;
    }
    const landed = str(res.landed_host);
    const seen = Array.isArray(res.methods_seen) ? res.methods_seen.filter((x) => typeof x === "string" && x) : [];
    const rows = [{ k: "Filled", v: res.filled === true ? "Yes" : "No" }, { k: "Submitted", v: res.submitted === true ? "Yes" : "No" }];
    if (landed) rows.push({ k: "Landed on", v: landed });
    if (str(res.method)) rows.push({ k: "Method clicked", v: str(res.method) });
    if (res.submitted !== true && str(res.reason)) rows.push({ k: "Why not", v: str(res.reason) });
    if (seen.length) rows.push({ k: "Choices seen", v: seen.join(", ") });
    out.blocks.push({ kind: "kv", rows });
    if (res.submitted === true) {
      out.title = "Signed in" + on;
      out.status = "Signed in";
      out.more = [landed && landed !== site ? "landed on " + landed : "", str(res.method) ? "via " + str(res.method) : ""].filter(Boolean);
      return out;
    }
    out.bad = true;
    out.ownFailure = true;
    out.title = "Could not sign in" + on;
    out.status = "Not signed in";
    out.more = [str(res.reason) ? cut(squash(res.reason), 100) : ""].filter(Boolean);
    if (seen.length) out.lines.push({ parts: "Choices on the page: " + seen.join(", "), dim: true });
    return out;
  }

  // check is browser_check: why saved logins may not fill.
  function check(c) {
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "key", blocks: [], lines: [] };
    out.title = c.done ? (c.failed ? "Could not check saved logins" : "Checked why saved logins may not fill") : "Checking the browser";
    if (!c.done) return out;
    if (fail(c, out, "Failed: ")) {
      out.raw = opaque(c);
      return out;
    }
    const after = isObj(res.after_activate) ? res.after_activate : {};
    const lock = isObj(res.screen_lock) ? res.screen_lock : {};
    const hostsList = Array.isArray(res.autologin_hosts) ? res.autologin_hosts.filter((x) => typeof x === "string") : [];
    const why = [];
    if (res.would_fill === false) {
      if (str(after.visibility) && after.visibility !== "visible") why.push("tab was hidden");
      if (lock.locked === true) why.push("screen locked");
      if (str(res.window_state) && res.window_state !== "normal") why.push("window " + str(res.window_state));
    }
    if (res.would_fill === true) out.status = "Would fill";
    else {
      out.status = "Would not fill";
      out.tone = "warn";
      out.more = why;
    }
    const bits = [lock.known === false ? "" : lock.locked === true ? "Screen locked" : lock.locked === false ? "Screen unlocked" : "", str(res.window_state) ? "window " + str(res.window_state) : "",
      hostsList.length ? plural(hostsList.length, "sign-in site") : ""].filter(Boolean);
    if (bits.length) out.lines.push({ parts: bits.join(" · "), dim: true });
    const rows = [];
    if (str(after.visibility)) rows.push({ k: "After showing it", v: upper(str(after.visibility)) + (after.ready ? ", ready" : "") });
    if (str(res.window_state)) rows.push({ k: "Window", v: upper(str(res.window_state)) + (res.window_focused === true ? ", focused" : res.window_focused === false ? ", not focused" : "") });
    if (lock.known === false) rows.push({ k: "Screen lock", v: "Not known" });
    else if (typeof lock.locked === "boolean") rows.push({ k: "Screen lock", v: lock.locked ? "Locked" : "Unlocked" });
    if (hostsList.length) rows.push({ k: "Sign-in sites", v: hostsList.join(", ") });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    return out;
  }

  // Tabs, the browser's state and the choice of its computer ---------------

  // away says whether a computer is not the chat's own; c.here is "" when
  // the own name is unknown, and then every computer is named.
  const away = (c, name) => !!str(name) && (!str(c.here) || str(name) !== str(c.here));

  const firefoxState = { connected: "Firefox connected", "not running": "Firefox closed, can start it", "not connected": "Firefox not connected" };

  function tabName(t) {
    return short(t.title) || hostPath(t.url) || "a tab";
  }

  function tabs(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const action = str(a.action) || "list";
    const out = { icon: "tabs", blocks: [], lines: [] };
    const site = hostOfUrl(a.url);
    const where = site ? [{ code: site }] : [];
    // The title of the tab, when the plugin sent it with a close, keep or release.
    const named = c.done && !c.failed && str(res.title) ? ": " + short(res.title) : "";
    if (c.failed && refusal(c) === "") {
      // Firefox was closed and is being started: the call tries again.
      if (isObj(c.res) && str(c.res.code) === "started") {
        out.title = ["Opening a tab" + (site ? ": " : ""), ...where];
        out.status = "Started Firefox, trying again";
        out.tone = "warn";
        out.ownFailure = true;
        return out;
      }
    }
    switch (action) {
      case "open":
        out.title = [c.failed ? "Could not open a tab" : verb(c, "Opened", "Opening") + " a tab", ...(site ? [": "] : []), ...where];
        break;
      case "close": out.title = c.failed ? "Could not close a tab" : verb(c, "Closed", "Closing") + " a tab" + named; break;
      case "keep": out.title = c.failed ? "Could not keep a tab open" : verb(c, "Kept", "Keeping") + " a tab open" + named; break;
      case "release": out.title = c.failed ? "Could not let a tab close" : verb(c, "Let", "Letting") + " a tab close on its own" + named; break;
      default: out.title = c.failed ? "Could not list browser tabs" : verb(c, "Listed", "Listing") + " browser tabs";
    }
    if (!c.done) return out;
    if (fail(c, out, "Failed")) {
      const err = cut(squash(errorText(c.res) || str(c.error) || first(c.out)), 100);
      if (refusal(c) === "") {
        out.status = "Failed";
        out.more = err ? [err] : [];
      }
      out.raw = opaque(c);
      return out;
    }
    if (action === "open") {
      const bits = [str(res.title) ? short(res.title) : "", a.keep === true ? "kept open" : ""].filter(Boolean);
      if (bits.length) out.lines.push({ parts: bits.join(" · "), dim: true });
      if (str(res.url)) out.blocks.push({ kind: "kv", rows: [{ k: "Address", v: [{ code: str(res.url) }] }, ...(str(res.title) ? [{ k: "Page", v: short(res.title) }] : [])] });
    } else if (action === "list" || !str(a.action)) {
      const list = Array.isArray(res.tabs) ? res.tabs.filter(isObj) : [];
      if (!list.length) {
        out.lines.push({ parts: "No browser tabs open", dim: true });
        return out;
      }
      out.chips = [plural(list.length, "tab")];
      const names = list.slice(0, 2).map((t) => tabName(t) + (t.keep === true ? " (kept)" : ""));
      out.lines.push({ parts: names.join(", ") + (list.length > 2 ? " · +" + (list.length - 2) + " more" : ""), dim: true });
      out.blocks.push({
        label: "Tabs",
        kind: "kv",
        rows: list.map((t) => ({
          k: t.active === true ? "Active" : t.keep === true ? "Kept" : "",
          v: [tabName(t), ...(str(t.url) ? [" · ", { code: hostPath(t.url) }] : []), ...(t.mine === true ? [" ", { chip: "opened here" }] : [])],
        })),
      });
    }
    return out;
  }

  function status(c) {
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "globe", blocks: [], lines: [] };
    out.title = c.done ? "Checked the browser" : "Checking the browser";
    if (!c.done) return out;
    if (fail(c, out, "Failed: ")) {
      out.raw = opaque(c);
      return out;
    }
    if (res.available === false) {
      out.title = "No browser available";
      out.status = str(res.reason) ? cut(squash(res.reason), 100) : "No browser is connected";
      out.tone = "warn";
      out.ownFailure = true;
      out.bad = false;
    } else {
      const name = (str(res.browser).split(" ")[0]) || "";
      // The computer is named only when it is not the chat's own.
      out.title = "Checked the browser" + (str(res.device) ? ": " + (name || "Firefox") + (away(c, res.device) ? " on " + short(res.device) : "") : "");
    }
    const list = Array.isArray(res.tabs) ? res.tabs : null;
    const others = (Array.isArray(res.devices) ? res.devices : []).filter((d) => isObj(d) && d.selected !== true);
    if (res.available !== false) {
      const bits = ["Connected", list && list.length ? plural(list.length, "agent tab") : "", others.length ? plural(others.length, "other computer") : "", str(res.tabs_error) ? "could not read the tabs" : ""].filter(Boolean);
      out.lines.push({ parts: bits.join(" · "), dim: true });
    }
    const rows = [];
    if (away(c, res.device)) rows.push({ k: "Computer", v: short(res.device) });
    if (str(res.why)) rows.push({ k: "Chosen because", v: upper(str(res.why)) });
    if (list) rows.push({ k: "Agent tabs", v: String(list.length) });
    if (rows.length) out.blocks.push({ kind: "kv", rows });
    if (others.length) out.blocks.push({ label: "Other computers", kind: "kv", rows: others.map((d) => ({ k: short(d.device), v: firefoxState[str(d.firefox)] || "Firefox " + str(d.firefox) })) });
    return out;
  }

  function useDevice(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "globe", blocks: [], lines: [] };
    const dev = str(res.device) || (str(a.device) !== "default" ? str(a.device) : "");
    if (str(a.device) === "default") out.title = verb(c, "Went back to", "Going back to") + " the default browser computer";
    else out.title = verb(c, "Chose", "Choosing") + (dev ? (away(c, dev) ? " " + short(dev) : " this computer") : " a computer") + " for the " + (str(a.job_id) ? "scheduled job" : "browser");
    if (!c.done) return out;
    if (fail(c, out, "Failed: ")) {
      out.raw = opaque(c);
      return out;
    }
    if (str(res.note)) out.blocks.push({ plain: true, text: str(res.note) });
    return out;
  }

  // other is any browser tool without a card of its own.
  function other(c) {
    const out = { icon: "globe", status: "Done", blocks: [] };
    out.title = verb(c, "Used", "Using") + " the browser: " + c.name.replace(/^browser_/, "").replace(/_/g, " ");
    out.raw = rawOf(c);
    return out;
  }

  H.register({
    browser_navigate: navigate, browser_back: back,
    browser_click: act, browser_type: act, browser_press: act, browser_select: act, browser_hover: act, browser_scroll: act,
    browser_batch: batch_, browser_login: login, browser_vault: vault, browser_check: check,
    browser_tabs: tabs, browser_status: status, browser_use_device: useDevice,
  }, { match: (n) => n.startsWith("browser_"), fn: other });
})();
