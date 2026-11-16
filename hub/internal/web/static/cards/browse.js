"use strict";
// Cards of the browser: open, act on and read pages, steps, tabs, sign-in.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  const browserWords = {
    browser_navigate: ["globe", "Opened", "Opening", (a) => host(str(a.url))],
    browser_click: ["cursor", "Clicked", "Clicking", (a, t) => t],
    browser_type: ["cursor", "Typed into", "Typing into", (a, t) => t],
    browser_press: ["cursor", "Pressed", "Pressing", (a) => keyName(a.key)],
    browser_scroll: ["eye", "Scrolled the page", "Scrolling the page", () => ""],
    browser_back: ["eye", "Went back a page", "Going back a page", () => ""],
    browser_snapshot: ["eye", "Read the page", "Reading the page", () => ""],
    browser_screenshot: ["camera", "Took a screenshot", "Taking a screenshot", () => ""],
    browser_vision: ["eye", "Looked at the page", "Looking at the page", () => ""],
    browser_hover: ["cursor", "Hovered over", "Hovering over", (a, t) => t],
    browser_tabs: ["tabs", "Used the browser tabs", "Using the browser tabs", () => ""],
    browser_eval: ["globe", "Ran a script in the page", "Running a script in the page", () => ""],
  };

  // targetName is what the device plugin said the call acted on: the label
  // the page gave the element, else its role. A ref is never shown.
  function targetName(c) {
    const t = isObj(c.res) && isObj(c.res.target) ? c.res.target : null;
    if (!t) return "";
    return str(t.name) ? short(t.name) : str(t.role) ? "the " + short(t.role) : "";
  }

  const hostOfUrl = (u) => (str(u) ? host(str(u)) : "");

  // batchStep is one step of a browser_batch result: its words, state and
  // the outcome shown beside it. A result from a plugin that sends no
  // details falls back to its step lines.
  function batchSteps(res) {
    if (Array.isArray(res.details) && res.details.length) {
      return res.details.filter(isObj).map((d) => ({
        text: short(d.text) || "Step " + str(d.step),
        state: str(d.state) || "done",
        outcome: d.state === "failed" ? "Failed: " + (short(d.error) || "the step did not work") : d.state === "not_run" ? "Not run" : "Done" + (str(d.approved) ? " · approved " + short(d.approved) : ""),
        form: d.action === "type" || d.action === "select",
      }));
    }
    if (Array.isArray(res.steps)) {
      return res.steps.map((l) => {
        const t = str(l).replace(/^\d+\.\s*/, "");
        const failed = /^Failed:/.test(t);
        const skipped = /^Not run:/.test(t);
        return { text: short(t.replace(/^(Failed|Not run):\s*/, "")), state: failed ? "failed" : skipped ? "not_run" : "done", outcome: failed ? "Failed" : skipped ? "Not run" : "Done", form: /^(Typed into|Selected)/.test(t) };
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

  // batchRefused is the card of a batch that came back with an error and no
  // step results: it never ran (the plugin refused it before the first step,
  // or the browser was not there). The body is the whole error and the steps
  // the agent asked for, each marked not run, the one the error names marked
  // failed.
  function batchRefused(c, a, res) {
    let e = str(res.error) || str(res.message) || str(c.error) || first(c.out);
    e = e.trim();
    const given = Array.isArray(a.steps) ? a.steps : [];
    const m = /\bstep (\d+)\b/i.exec(e);
    const at = m && +m[1] >= 1 && +m[1] <= given.length ? +m[1] : 0;
    const out = { icon: "list", bad: true, blocks: [] };
    out.title = given.length ? "Browser steps not run: " + given.length : "Browser steps not run";
    out.status = at ? "Not run: step " + at + " is not valid" : "Not run";
    out.blocks.push({ label: "Error", plain: true, text: e || "The call did not work." });
    const items = given.map((x, i) => ({ text: askedStep(x), state: i + 1 === at ? "failed" : "not_run", outcome: i + 1 === at ? "Not valid" : "Not run", form: false }));
    if (items.length) out.blocks.push({ label: "Steps asked for", kind: "steps", items, text: items.map((x, i) => (i + 1) + ". " + x.text + " (" + x.outcome + ")").join("\n") });
    return out;
  }

  function batch_(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    if (c.done && (c.failed || str(res.error)) && !batchSteps(res).length) return batchRefused(c, a, res);
    const out = { icon: "list", blocks: [] };
    const given = Array.isArray(a.steps) ? a.steps : [];
    const steps = c.done ? batchSteps(res) : [];
    // Steps the result does not list (the batch ran out of time) were not run.
    if (c.done && steps.length && steps.length < given.length) {
      for (let i = steps.length; i < given.length; i++) steps.push({ text: askedStep(given[i]), state: "not_run", outcome: "Not run", form: false });
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
      out.title = steps.map((x) => x.text).join(", then ").replace(/^./, (m) => m);
    } else {
      out.title = "Ran " + (bad ? count : plural(total, "browser step")) + on;
    }
    if (bad) {
      out.bad = true;
      const at = stopped >= 0 ? stopped + 1 : isObj(res.failed) ? res.failed.step : 0;
      out.status = at ? "Stopped at step " + at : "Stopped";
    } else {
      out.status = "Done";
    }
    if (steps.length) out.blocks.push({ label: "Steps", kind: "steps", items: steps, text: steps.map((x, i) => (i + 1) + ". " + x.text + " (" + x.outcome + ")").join("\n") });
    if (page && (str(page.snapshot) || str(page.text))) {
      const meta = [str(page.title), site, Number.isFinite(page.element_count) ? plural(page.element_count, "element") : ""].filter(Boolean).join(" · ");
      out.blocks.push({ label: "Page read at the end", kind: "page", meta, text: str(page.snapshot) || str(page.text) });
    } else if (str(res.page_error)) {
      out.blocks.push({ label: "Page read at the end", plain: true, text: str(res.page_error) });
    }
    return out;
  }

  function browser(c) {
    const a = isObj(c.args) ? c.args : {};
    if (c.name === "browser_batch") return batch_(c);
    const w = browserWords[c.name];
    const out = { icon: w ? w[0] : "globe", blocks: [] };
    if (w) {
      const arg = w[3](a, targetName(c));
      out.title = (c.done ? w[1] : w[2]) + (arg ? " " + short(arg) : "");
    }
    else out.title = verb(c, "Used", "Using") + " the browser: " + c.name.replace(/^browser_/, "").replace(/_/g, " ");
    out.status = "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

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
    out.status = list ? plural(list.length, "login") : "Done";
    // Never show what the vault returned: it may hold a secret.
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(scrub(a), null, 2), pre: true });
    return out;
  }


  H.register({ browser_vault: vault }, { match: (n) => n.startsWith("browser_"), fn: browser });
})();
