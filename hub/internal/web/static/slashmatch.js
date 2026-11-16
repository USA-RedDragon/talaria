"use strict";
// HubSlash.match(commands, query) picks the commands that a typed "/query"
// offers, best first: a command whose name or alias is the query, then one
// that starts with it, then skills that start with it, then names that
// contain it, then descriptions that contain it. Each result is
// {c, alias}: alias is the alias that matched when the name did not.
//
// HubSlash.find(commands, name) is the command a typed name or alias
// means. HubSlash.parse(usage) reads a command's usage hint, such as
// "[here [N] | focus topic | --preview|--dry-run]", into a tree, and
// HubSlash.options(tree, words, partial) says what may come next after
// the words already typed: {choices, hints, end}. A choice is a word to
// insert ({text, desc}); a hint is a placeholder to fill in ({text, name,
// desc}); end says the usage allows the line to stop there.
window.HubSlash = (() => {
  const bare = (n) => String(n || "").replace(/^\//, "").toLowerCase();

  function rank(c, q) {
    const names = [bare(c.name)].concat((c.aliases || []).map(bare));
    if (!q) return { tier: 2, alias: "" };
    const at = (test) => names.findIndex(test);
    let i = at((n) => n === q);
    if (i >= 0) return { tier: 0, alias: i ? c.aliases[i - 1] : "" };
    i = at((n) => n.startsWith(q));
    if (i >= 0) return { tier: c.skill ? 2 : 1, alias: i ? c.aliases[i - 1] : "" };
    i = at((n) => n.includes(q));
    if (i >= 0) return { tier: 3, alias: i ? c.aliases[i - 1] : "" };
    if (String(c.description || "").toLowerCase().includes(q)) return { tier: 4, alias: "" };
    return null;
  }

  function match(commands, query) {
    const q = bare(query);
    const out = [];
    (commands || []).forEach((c, order) => {
      const r = rank(c, q);
      if (r) out.push({ c, alias: r.alias, tier: r.tier, order });
    });
    out.sort((a, b) => a.tier - b.tier || a.order - b.order);
    return out.map((m) => ({ c: m.c, alias: m.alias }));
  }

  // Words in a usage hint that stand for a value the user types, not for
  // themselves. Anything else bare is a word to insert.
  const PLACEHOLDERS = new Set(["n", "name", "text", "topic", "prompt", "task", "reason", "number", "id", "path", "file", "filename",
    "description", "notes", "subcommand", "profile", "platform", "slug", "interval", "condition", "question", "model", "instructions",
    "query", "value", "session-id", "cmd", "pid", "archive", "args", "message", "title", "a", "b"]);
  const isPh = (w) => PLACEHOLDERS.has(w.toLowerCase()) || /^[A-Z]$/.test(w) || /[=.]/.test(w);
  // Placeholders that take one word and no more.
  const ONE = /^(n|number|id|pid|a|b|interval|slug|platform|days|page|filename|session-id)$/i;

  // Plain words for the words Hermes' usage hints use most. Hermes sends
  // only the usage string, so these are the hub's own.
  const LIT = {
    here: "Keep the most recent turns as they are", focus: "Summarize with a focus", "--preview": "Show what would happen, change nothing",
    "--dry-run": "Show what would happen, change nothing", all: "Everything, not only the first part", status: "Show the current state",
    on: "Turn it on", off: "Turn it off", list: "List them", show: "Show it", hide: "Hide it", clear: "Clear it", pause: "Pause it",
    resume: "Resume it", stop: "Stop it", reset: "Go back to the default", "--global": "Save for every chat, not only this one",
    "--session": "This chat only", "--refresh": "Reload the list first", "--here": "Stay in this thread", "--all": "Include everything",
    "--stat": "Show a summary of changes", create: "Create one", restore: "Restore one", prune: "Remove old ones", delete: "Delete one",
    edit: "Edit one", remove: "Remove one", rm: "Remove one", move: "Move one", new: "Make a new one", fork: "Branch from there",
    staged: "Only staged changes", session: "Only this chat's changes", draft: "Draft it, do not set it yet", gate: "Set a check that must pass",
    "--provider": "Pick the provider", "--reasoning": "Set the reasoning effort", add: "Add one", redact: "Hide secrets in the export", wait: "Wait for a process", unwait: "Stop waiting", every: "Repeat on an interval", accept: "Accept it", dismiss: "Dismiss it",
    catalog: "Browse the catalog", pending: "Show what waits", approve: "Approve it", reject: "Reject it", approval: "The approval gate",
    queue: "Queue it for the next turn", steer: "Nudge the turn that runs", interrupt: "Stop the turn, then answer", full: "Show all of it",
    level: "A reasoning level", normal: "Normal speed", fast: "Fast mode", auto: "Chosen automatically", manual: "Approve every time", smart: "Approve when unsure",
    help: "Show help", tts: "Speak replies", always: "Always, from now on", scale: "Set a size", toggle: "Switch it", clamp: "Limit it",
  };
  const PHD = {
    n: "A number", number: "A number", name: "A name", topic: "What the summary should focus on, in your own words",
    text: "Your own words", prompt: "Your request, in your own words", task: "What to do, in your own words", reason: "A reason, in your own words",
    id: "An ID", path: "A file or folder (type @ to pick one)", file: "A file", description: "A description, in your own words",
    notes: "Notes, in your own words", model: "A model name", instructions: "Instructions, in your own words", interval: "How often, such as 30m",
    condition: "A condition, in your own words", question: "Your question", subcommand: "A subcommand", platform: "A platform name",
    query: "What to look for", value: "A value", title: "A title", message: "Your message", profile: "A profile name", slug: "A name", pid: "A process ID",
  };

  // Bare words that are words to type wherever they stand. Other bare
  // words are words to type only as the first of a choice ("a | b c"), and
  // placeholders anywhere else ("[focus instructions]").
  const ALWAYS = new Set(["all", "status", "on", "off", "add", "show", "hide", "list", "pause", "resume", "stop", "clear", "reset", "help", "full", "later", "redact"]);
  PLACEHOLDERS.add("days"); PLACEHOLDERS.add("page"); PLACEHOLDERS.add("level");
  LIT.level = "A reasoning level"; LIT.scale = "Set a size";

  const tokens = (u) => String(u || "").match(/\.\.\.|\[|\]|\||<[^>]*>|[^\s\[\]|<>]+/g) || [];

  // parse reads a usage hint into nodes: {t: "lit", v}, {t: "ph", v, many}
  // and {t: "opt" | "alt", alts: [[node, ...], ...]}. A group in [] is
  // optional; bare | splits alternatives.
  function parse(usage) {
    const toks = tokens(usage);
    let i = 0;
    // settle turns the bare words of the branches into literals and
    // placeholders, once it is known whether the group has a choice.
    function settle(branches) {
      const choice = branches.length > 1;
      return branches.map((br) => {
        const out = [];
        br.forEach((n, k) => {
          if (n.t !== "w") { out.push(n); return; }
          const lit = n.v.startsWith("-") || ALWAYS.has(n.v.toLowerCase()) || (choice && k === 0 && !isPh(n.v));
          if (lit) { out.push({ t: "lit", v: n.v }); return; }
          const last = out[out.length - 1];
          if (last && last.t === "ph" && last.bare) { last.v += " " + n.v; last.many = true; return; }
          out.push({ t: "ph", v: n.v, many: n.many || !ONE.test(n.v), bare: true });
        });
        return out;
      });
    }
    function alts(closer) {
      const out = [[]];
      while (i < toks.length) {
        const t = toks[i++];
        const cur = out[out.length - 1];
        if (t === "]") { if (closer) return settle(out); continue; }
        if (t === "|") { out.push([]); continue; }
        if (t === "[") { cur.push({ t: "opt", alts: alts(true) }); continue; }
        if (t === "...") { const p = cur[cur.length - 1]; if (p && (p.t === "ph" || p.t === "w")) p.many = true; continue; }
        if (t[0] === "<") {
          const inner = t.slice(1, -1).trim();
          if (inner.includes("|") && !/\s/.test(inner)) cur.push({ t: "alt", alts: inner.split("|").map((w) => [{ t: "lit", v: w }]) });
          else cur.push({ t: "ph", v: inner, many: !ONE.test(inner) });
          continue;
        }
        const dots = /\.\.\.$/.test(t) && t.length > 3;
        cur.push({ t: "w", v: dots ? t.slice(0, -3) : t, many: dots });
      }
      return settle(out);
    }
    const top = alts(false);
    return top.length > 1 ? [{ t: "alt", alts: top }] : top[0];
  }

  // expand lists the stacks a stack of nodes can be, each starting at a
  // lit or ph, or empty when the usage may end.
  function expand(st, out) {
    if (!st.length) { out.push(st); return out; }
    const h = st[0];
    const rest = st.slice(1);
    if (h.t === "opt") {
      for (const a of h.alts) expand(a.concat(rest), out);
      expand(rest, out);
    } else if (h.t === "alt") {
      for (const a of h.alts) expand(a.concat(rest), out);
    } else out.push(st);
    return out;
  }

  const eat = (states, word) => {
    const out = [];
    for (const st of states) {
      for (const s of expand(st, [])) {
        const h = s[0];
        if (!h) continue;
        if (h.t === "lit") { if (h.v.toLowerCase() === word.toLowerCase()) out.push(s.slice(1)); }
        else { out.push(s.slice(1)); if (h.many) out.push(s); }
      }
    }
    return out;
  };

  function options(tree, words, partial) {
    let states = [tree || []];
    for (const w of words) states = eat(states, w);
    const q = String(partial || "").toLowerCase();
    const choices = [];
    const hints = [];
    let end = false;
    for (const st of states) {
      for (const s of expand(st, [])) {
        const h = s[0];
        if (!h) { end = true; continue; }
        if (h.t === "lit") {
          if (h.v.toLowerCase().includes(q) && !choices.some((c) => c.text === h.v)) choices.push({ text: h.v, desc: LIT[h.v.toLowerCase()] || "" });
        } else if (!hints.some((x) => x.text === h.v)) {
          hints.push({ text: h.v, name: h.v.toLowerCase(), desc: PHD[h.v.toLowerCase()] || "Type your own" });
        }
      }
    }
    choices.sort((a, b) => (b.text.toLowerCase().startsWith(q) ? 1 : 0) - (a.text.toLowerCase().startsWith(q) ? 1 : 0));
    return { choices, hints, end, lost: !states.length };
  }

  // find is the command a typed name or alias means.
  function find(commands, name) {
    const n = bare(name);
    return (commands || []).find((c) => bare(c.name) === n || (c.aliases || []).some((a) => bare(a) === n)) || null;
  }

  return { match, find, parse, options, bare };
})();
