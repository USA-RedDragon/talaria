"use strict";
// HubToolCard is the one card component of a tool call. The main chat, a
// subagent's steps in Activity (minichat.js) and the full steps dialog all
// draw their cards through mount() and finish() here, so a call looks the
// same wherever it shows. Nothing else builds a tool card.
//
// The card has the look of the notice cards (notice.js): a line icon, a
// title in plain words (a command or path in it in monospace), chips, a
// status line that leads with the result and then the time and how long it
// took, up to three short lines of what matters most, and an expanded part
// with the bulky detail (output, diffs, file text, lists). Raw JSON shows
// only where the hub cannot know the format, behind a closed Raw toggle.
//
// derive(c) is the pure part: it turns a call c (name, args, res, out,
// done, failed, ...) into the card model below, through the renderer that
// a card module registered for the tool (static/cards/*.js). memory()
// keeps what earlier calls of a chat taught (a background command by its
// session id, a subagent by its id) so that a later call can name it.
//
// c: name, args, result (raw), res (parsed result or null), out (output
// text), diff (inline diff text), done, failed, error, startedAt and endedAt
// (Unix ms, 0 when not known), duration (s), answer (what the model said
// about an image it looked at), pending, partial, mem, here (the name of the
// chat's own computer, "" when not known: a card names another computer
// only when it is not this one).
//
// The model a renderer returns (every field but title optional):
//   icon       an icon name of icons.js
//   title      a string, or parts (below); code: a command at its end
//   chips      short tags after the title: strings
//   sub        one line between the title and the status (a folder)
//   status     the result in words; tone ok, bad, warn or still to color it
//              (else the state's color); more: parts after it, " · " apart
//   lines      up to three lines under the status: { parts, dim, mono,
//              closed (shown only while the card is closed), wrap (the
//              line wraps on a narrow screen instead of ending in "…") }
//   blocks     the expanded part: { label, text, kind } where kind is pre
//              (default), command, diff, plain, steps (items), page (meta),
//              kv (rows of { k, v, mono }), list (items of parts), question
//              (rec, drawn by questioncard.js); copy: false drops the button
//   raw        text for the closed Raw toggle at the end of the expanded part
//   vision     { kind, url|path, question } of an image the call looked at
//   page       { path, title } of a page the call published
//   statusLast the status line comes after the lines
//   bad, idle, waiting  the state is bad; the status is muted; it waits
// Parts are strings or { code }, { chip }, { tone, text } (tone ok, bad,
// warn, add, del), { link, text } (a web page, opened in a new tab). A list
// item may set gap to start a new group of rows.
window.HubToolCard = (() => {
  const titleLen = 120;
  const errorLen = 80;
  const outLen = 20000;
  const lineLen = 160;
  const maxLines = 3;

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
  const cut = (s, n) => {
    const r = Array.from(s);
    return r.length <= n ? s : r.slice(0, n).join("").trim() + "…";
  };
  const squash = (s) => str(s).split(/\s+/).filter(Boolean).join(" ");
  const short = (s) => cut(squash(s), titleLen);
  const first = (s) => {
    for (const l of str(s).split("\n")) if (l.trim()) return l.trim();
    return "";
  };
  const last = (s) => {
    const ls = str(s).split("\n");
    for (let i = ls.length - 1; i >= 0; i--) if (ls[i].trim()) return ls[i].trim();
    return "";
  };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const base = (p) => str(p).replace(/\/+$/, "").split("/").pop() || str(p);
  // dir is the folder of a path, with its slash: /home/a/b.go is /home/a/.
  const dir = (p) => {
    const s = str(p);
    const i = s.replace(/\/+$/, "").lastIndexOf("/");
    return i < 0 ? "" : s.slice(0, i + 1);
  };
  const lines = (s) => (s ? s.replace(/\n+$/, "").split("\n").length : 0);
  const stripAnsi = (s) => str(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "");
  // size writes a byte count: 212 B, 1.3 KB, 4.2 MB.
  function size(n) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return n + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)) + " " + u[i];
  }
  const upperFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  function host(u) {
    try {
      return new URL(u).host || u;
    } catch (_) {
      return str(u).replace(/^[a-z]+:\/\//i, "").split("/")[0];
    }
  }

  function memory() {
    const procs = new Map();
    const subs = new Map();
    const find = (m, id) => {
      if (!id) return "";
      if (m.has(id)) return m.get(id);
      const hits = [...m.keys()].filter((k) => k.startsWith(id) || k.replace(/^proc_/, "").startsWith(id));
      return hits.length === 1 ? m.get(hits[0]) : "";
    };
    return {
      proc: (id) => find(procs, id),
      sub: (id) => find(subs, id),
      learn(name, args, res) {
        if (!isObj(res)) return;
        if (isObj(args) && typeof res.session_id === "string" && typeof res.command === "string") procs.set(res.session_id, res.command);
        if (name === "terminal" && isObj(args) && typeof res.session_id === "string" && args.command) procs.set(res.session_id, str(args.command));
        if (name === "process_manage" && Array.isArray(res.processes)) {
          for (const p of res.processes) if (isObj(p) && p.session_id && p.command) procs.set(str(p.session_id), str(p.command));
        }
        if (name === "delegate_task") {
          if (Array.isArray(res.subagent_ids) && Array.isArray(res.goals)) {
            res.subagent_ids.forEach((id, i) => {
              if (id && res.goals[i]) subs.set(str(id), str(res.goals[i]));
            });
          }
          if (Array.isArray(res.subagents)) {
            for (const s of res.subagents) if (isObj(s) && s.subagent_id && s.goal) subs.set(str(s.subagent_id), str(s.goal));
          }
        }
      },
    };
  }

  // wrapped lists the calls that a tool_call of Hermes carries; take removes
  // the first of them named name and returns it.
  function wrapped(name, args) {
    if (name !== "tool_call" || !isObj(args) || !Array.isArray(args.calls)) return null;
    return args.calls.filter((x) => isObj(x) && typeof x.name === "string").map((x) => ({ name: x.name, args: x.arguments }));
  }

  // calls lists the cards a live tool_call draws: one for each call it
  // carries, keyed by the wrapper's id and the call's place, with the id
  // that tells the fold the calls ran together (none when there is one).
  // It is null for any other call.
  function calls(id, name, args) {
    const list = wrapped(name, args);
    if (!list || !list.length) return null;
    return list.map((x, i) => ({ key: id + ":" + i, name: x.name, args: x.args, batch: list.length > 1 ? id : "" }));
  }

  // split divides the one result Hermes ends a live tool_call with into a
  // result for each of its n calls, when it is a list of that length (or an
  // object with a results list of that length). Else it is null.
  function split(result, n) {
    let r = result;
    if (typeof r === "string" && (r[0] === "[" || r[0] === "{")) {
      try {
        r = JSON.parse(r);
      } catch (_) {
        return null;
      }
    }
    const list = Array.isArray(r) ? r : isObj(r) && Array.isArray(r.results) ? r.results : null;
    return list && list.length === n ? list : null;
  }

  function take(list, name) {
    const i = list.findIndex((x) => x.name === name);
    return i < 0 ? null : list.splice(i, 1)[0];
  }

  const verb = (c, past, now) => (c.done ? past : now);

  // errorText is the error a result carries in any of the shapes tools use:
  // error as text or as { message }, else message beside a failed status.
  function errorText(res) {
    if (!isObj(res)) return "";
    if (typeof res.error === "string" && res.error.trim()) return res.error;
    if (isObj(res.error) && typeof res.error.message === "string") return res.error.message;
    if (typeof res.message === "string" && failedRes(res)) return res.message;
    if (typeof res.reason === "string" && failedRes(res)) return res.reason;
    return "";
  }

  // badStatus are the status words with which a tool says it did not do
  // what was asked.
  const badStatus = new Set(["error", "failed", "failure", "refused", "denied", "blocked", "rejected", "not_found", "invalid", "timeout", "timed_out"]);

  // failedRes says a parsed result reports a failure, whatever the tool:
  // an error, success or ok false, is_error, or a failing status.
  function failedRes(res) {
    if (!isObj(res)) return false;
    if (typeof res.error === "string" ? res.error.trim() !== "" : isObj(res.error) || res.error === true) return true;
    if (res.success === false || res.is_error === true) return true;
    if (typeof res.status === "string" && badStatus.has(res.status.toLowerCase())) return true;
    return false;
  }

  function failure(c) {
    if (!c.failed) return "";
    let e = errorText(c.res) || str(c.error);
    if (!e) e = first(c.out);
    return "Failed: " + (cut(squash(e), errorLen) || "the call did not work");
  }

  const exitCode = (res) => (isObj(res) && typeof res.exit_code === "number" ? res.exit_code : null);

  // span writes a length of time: 45 s, 3 min, 1 h 5 min.
  function span(s) {
    s = Math.round(s);
    if (s < 60) return s + " s";
    if (s < 3600) return Math.round(s / 60) + " min";
    const m = Math.round((s % 3600) / 60);
    return Math.floor(s / 3600) + " h" + (m ? " " + m + " min" : "");
  }

  // who names a peer from what the chat learned, then from the page's names.
  function who(ref, mem) {
    const P = window.HubPeer;
    if (!P) return { kind: "", label: "another agent", id: "" };
    const page = P.names || {};
    return P.who(ref, {
      sub: (id) => (mem && mem.sub(id)) || (page.sub && page.sub(id)) || "",
      chat: (r) => (page.chat && page.chat(r)) || "",
    });
  }

  // keyName is a pressed key in words: Enter, Tab, Ctrl+A. Anything that is
  // not a key name (a stray digit, a ref) is left out.
  function keyName(k) {
    const t = squash(k);
    return t.length > 1 || /^[A-Za-z]$/.test(t) ? t : "";
  }

  // toolLabel is a tool's name in plain words: get_thing is "get thing".
  function toolLabel(name) {
    return plain(name).replace(/[_-]+/g, " ").trim() || "a tool";
  }

  // json writes a value for the Raw toggle.
  function json(v) {
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch (_) {
      return "";
    }
  }

  // The renderers of the tools: card modules register theirs. A name with
  // no renderer of its own goes to the first fallback whose test matches
  // it, else to the generic card.
  const handlers = Object.create(null);
  const fallbacks = [];
  let generic = null;
  function register(map, opts) {
    for (const [k, fn] of Object.entries(map || {})) handlers[k] = fn;
    if (opts && typeof opts.match === "function" && typeof opts.fn === "function") fallbacks.push(opts);
    if (opts && typeof opts.generic === "function") generic = opts.generic;
  }

  // basic is the card of a tool nobody registered a renderer for: its name
  // in plain words, and its call and result behind Raw, since the hub does
  // not know their format.
  function basic(c) {
    const out = { icon: "tool", title: verb(c, "Used ", "Using ") + toolLabel(c.name), status: "Done", blocks: [] };
    out.raw = rawOf(c);
    return out;
  }

  // rawOf is the call and its result as JSON, for the Raw toggle.
  function rawOf(c) {
    const parts = [];
    if (isObj(c.args) && Object.keys(c.args).length) parts.push(json(c.args));
    if (c.res !== null && c.res !== undefined) parts.push(json(c.res));
    else if (c.out) parts.push(c.out);
    return parts.join("\n\n");
  }

  // part normalizes one part of a title or line.
  function part(p) {
    if (typeof p === "string" || typeof p === "number") return String(p).replace(emojiRe, "");
    if (!isObj(p)) return "";
    if (p.code !== undefined) return { code: plain(str(p.code)) };
    if (p.chip !== undefined) return { chip: plain(str(p.chip)) };
    // A link goes only to a web page: any other address is its text alone.
    if (p.link !== undefined) return /^https?:\/\//i.test(str(p.link)) ? { link: str(p.link), text: plain(str(p.text)) || str(p.link) } : plain(str(p.text));
    if (p.tone !== undefined) return { tone: str(p.tone), text: plain(str(p.text)) };
    return "";
  }
  const partsOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(part).filter((p) => p !== "" && !(isObj(p) && !(p.code || p.chip || p.text)));
  const textOf = (parts) => parts.map((p) => (typeof p === "string" ? p : p.code || p.chip || p.text || "")).join("");

  // derive gives the card model of a call (see the top of this file) with
  // state ("run", "ok" or "bad"), title (the plain text of the title) and
  // titleParts. A running call has no status unless it waits.
  function derive(c) {
    const name = plain(str(c.name)) || "tool";
    c = Object.assign({}, c, { name });
    let fn = handlers[name];
    if (!fn) {
      const f = fallbacks.find((x) => x.match(name));
      fn = f ? f.fn : generic || basic;
    }
    const d = fn(c) || basic(c);
    if (!d.blocks) d.blocks = [];
    d.state = !c.done ? "run" : c.failed || d.bad ? "bad" : "ok";
    if (c.failed && d.state === "bad" && !d.ownFailure) d.status = failure(c) || d.status;
    if (!c.done && !d.keepRunStatus) d.status = d.waiting ? "Waiting for approval" : "";
    d.status = plain(d.status);
    // The title: parts, or a string with the command at its end in code.
    let tp;
    if (Array.isArray(d.title)) tp = partsOf(d.title);
    else {
      const t = plain(d.title);
      const code = d.code ? plain(d.code) : "";
      tp = code && t.endsWith(code) && code !== t ? [t.slice(0, t.length - code.length), { code }] : [t];
      if (code && t === code) tp = [{ code }];
    }
    d.titleParts = tp.filter((p) => p !== "");
    d.title = textOf(d.titleParts);
    const tail = d.titleParts[d.titleParts.length - 1];
    d.code = isObj(tail) && tail.code ? tail.code : "";
    d.chips = (d.chips || []).map((x) => plain(str(x))).filter(Boolean);
    d.more = partsOf(d.more);
    d.sub = d.sub ? normLine(d.sub) : null;
    d.lines = (d.lines || []).map(normLine).filter(Boolean).slice(0, maxLines);
    d.blocks = d.blocks.filter((b) => b && (b.text || (b.items && b.items.length) || (b.rows && b.rows.length) || b.rec));
    for (const b of d.blocks) if (typeof b.text === "string" && b.text.length > outLen) b.text = b.text.slice(0, outLen) + "\n...";
    d.raw = typeof d.raw === "string" && d.raw.trim() ? (d.raw.length > outLen ? d.raw.slice(0, outLen) + "\n..." : d.raw) : "";
    // A failed card that opens shows its error: the whole text when the
    // status line had to cut it. One with nothing more does not open.
    if (d.state === "bad" && !d.blocks.length && !d.raw && c.failed && d.status === failure(c) && d.status.endsWith("…")) {
      const full = squash(errorText(c.res) || str(c.error) || first(c.out));
      if (full) d.blocks.push({ label: "Error", text: full, plain: true, copy: false });
    }
    d.opens = d.blocks.length > 0 || !!d.raw || !!d.vision;
    return d;
  }

  function normLine(l) {
    if (!l) return null;
    const o = typeof l === "string" || Array.isArray(l) || !isObj(l) || l.parts === undefined ? { parts: l } : l;
    const parts = partsOf(o.parts).map((p) => (typeof p === "string" ? cut(p.replace(/\s*\n\s*/g, " "), lineLen) : p));
    if (!textOf(parts).trim()) return null;
    return { parts, dim: !!o.dim, mono: !!o.mono, closed: !!o.closed, wrap: !!o.wrap };
  }

  // plain drops the emoji and variation selectors that Hermes puts in its
  // labels and progress text. Message text of the user and the assistant never
  // goes through it.
  const emojiRe = /[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;
  function plain(s) {
    return String(s === undefined || s === null ? "" : s).replace(emojiRe, "").replace(/ {2,}/g, " ").trim();
  }

  // batch reads the progress text of a batched call, "[set 5] terminal,
  // terminal, process_manage", into its size and its distinct tool names.
  function batch(text) {
    const m = /^\[set\s+(\d+)\]\s*(.*)$/i.exec(plain(text));
    if (!m) return null;
    const names = [];
    for (const n of m[2].split(",")) {
      const t = n.trim().split(/\s+/)[0];
      if (t && !names.includes(t)) names.push(t);
    }
    return { n: +m[1], names };
  }

  // statusLine turns what Hermes says a subagent is doing now (the tool name
  // and a short preview, which is a string and not the call's arguments)
  // into one plain sentence and an icon. Card modules add their tools'
  // words with lineWords(map): name -> [icon, words] or fn(preview, mem).
  const pmWords = {
    wait: ["clock", "Waiting on"], poll: ["activity", "Checking"], log: ["list", "Reading the output of"], kill: ["stop", "Stopping"],
    write: ["send", "Sending input to"], submit: ["send", "Sending input to"], close: ["activity", "Closing the input of"], handoff: ["send", "Handing off"],
  };
  const words = {
    todo: ["checkcircle", "Updating the to-do list"], todo_list: ["checkcircle", "Updating the to-do list"],
    memory: ["database", "Saving to memory"], project_memory: ["database", "Updating the project notes"],
    delegate_task: ["bot", "Starting a subagent"], send_file: ["file", "Offering a file"], page_publish: ["file", "Publishing a page"], agent_send: ["mail", "Sending a message"], agent_peers: ["list", "Listing your chats"], agent_set_name: ["edit", "Naming this chat"],
    skills_list: ["book", "Looking at skills"], skill_view: ["book", "Reading a skill"], skill_manage: ["book", "Editing a skill"],
    tool_search: ["search", "Looking up a tool"], tool_describe: ["search", "Looking up a tool"],
    mcp_device_servers: ["plug", "Looking up the servers on your computer"], mcp_device_tools: ["plug", "Looking up tools on your computer"],
  };
  const browserNow = {
    browser_navigate: ["globe", "Opening"], browser_click: ["cursor", "Clicking"], browser_type: ["cursor", "Typing into"], browser_press: ["cursor", "Pressing"],
    browser_scroll: ["eye", "Scrolling the page"], browser_back: ["eye", "Going back a page"], browser_snapshot: ["eye", "Reading the page"],
    browser_screenshot: ["camera", "Taking a screenshot"], browser_vision: ["eye", "Looking at the page"], browser_hover: ["cursor", "Hovering over"],
    browser_tabs: ["tabs", "Using the browser tabs"], browser_eval: ["globe", "Running a script in the page"],
  };

  function statusLine(name, preview, mem) {
    const l = statusLine0(plain(name), plain(preview), mem);
    const text = plain(l.text);
    const code = l.code ? plain(l.code) : "";
    return { icon: l.icon, text, code: code && text.endsWith(code) ? code : "" };
  }

  function statusLine0(name, preview, mem) {
    name = str(name).trim();
    const b = batch(preview);
    if (b && (!name || name === "tool_call" || name === "tool")) name = "tool_call";
    const p = squash(preview);
    const arg = (p.split(" ")[0] || "");
    if (!name) return { icon: "tool", text: "Working" };
    if (name === "process_manage") {
      const w = p.split(" ");
      const act = pmWords[w[0]] ? w[0] : w[0] === "list" || !w[0] ? "list" : "";
      const id = /^(proc_)?[0-9a-f]{4,}$/i.test(w[1] || "") ? w[1] : /^proc_/.test(w[0] || "") ? w[0] : "";
      const cmd = id && mem ? mem.proc(id) : "";
      if (act === "list" || !act) return { icon: "list", text: "Listing background commands" };
      const [icon, word] = pmWords[act];
      return { icon, text: word + (cmd ? " background command " + short(cmd) : " a background command"), code: cmd ? short(cmd) : "" };
    }
    if (name === "terminal") return { icon: "terminal", text: p ? "Running " + short(p) : "Running a command", code: p ? short(p) : "" };
    if (name === "execute_code") return { icon: "terminal", text: p ? "Running code " + short(p) : "Running code", code: p ? short(p) : "" };
    if (name === "read_file") return { icon: "file", text: "Reading " + (base(arg) || "a file") };
    if (name === "write_file" || name === "patch") return { icon: name === "write_file" ? "filenew" : "edit", text: (name === "write_file" ? "Writing " : "Editing ") + (base(arg) || "a file") };
    if (name === "search_files") return { icon: "search", text: "Searching files" + (p ? " for " + short(p) : "") };
    if (name === "web_search") return { icon: "globe", text: "Searching the web" + (p ? " for " + short(p) : "") };
    if (name === "web_extract") return { icon: "globe", text: "Reading " + (arg ? host(arg) : "a web page") };
    if (name === "session_search") return { icon: "search", text: "Searching past chats" + (p ? " for " + short(p) : "") };
    if (name === "browser_vault") return { icon: "key", text: /^(fill|use|login)\b/.test(p) ? "Using a saved login" : "Looking for a saved login" };
    if (name === "mcp_device_call") return { icon: "plug", text: "Calling " + (arg ? short(arg) : "a tool") + " on your computer" };
    if (name === "tool_call") {
      const m = /(\d+)\s+calls?/.exec(p);
      const n = b ? b.n : m ? +m[1] : 1;
      const list = b && b.names.length ? ": " + b.names.join(", ") : "";
      return { icon: "tool", text: n !== 1 ? "Running " + n + " tools" + list : "Running a tool" };
    }
    if (words[name]) return { icon: words[name][0], text: words[name][1] };
    if (browserNow[name]) {
      const w = browserNow[name];
      return { icon: w[0], text: w[1] + (name === "browser_navigate" && arg ? " " + short(host(arg)) : "") };
    }
    if (name === "browser_batch") return { icon: "list", text: "Running browser steps" };
    if (name.startsWith("browser_")) return { icon: "globe", text: "Using the browser" };
    return { icon: "tool", text: "Using " + toolLabel(name) };
  }

  function parse(r) {
    if (isObj(r)) return r;
    if (typeof r !== "string" || r[0] !== "{") return null;
    try {
      return JSON.parse(r);
    } catch (_) {
      return null;
    }
  }

  // outcome reads a finished call's result p (result, is_error, error,
  // result_text): the parsed result, whether it failed, and the output to
  // show (a command's output with its error and exit code). A result fails
  // when the event says so or when the result itself does (an error, success
  // or ok false, a failing status, a nonzero exit code).
  function outcome(name, p) {
    const res = parse(p.result);
    const exit = res && typeof res.exit_code === "number" ? res.exit_code : null;
    const failed = !!(p.is_error || (p.error && p.error !== false) || failedRes(res) || (exit !== null && exit !== 0));
    let out = p.result_text;
    if (!out && res && name === "terminal" && "output" in res) {
      out = String(res.output || "");
      if (res.error) out += (out ? "\n" : "") + res.error;
      if (exit !== null && exit !== 0) out += (out ? "\n" : "") + "(exit code " + exit + ")";
    }
    if (!out && p.result !== undefined && p.result !== null) out = typeof p.result === "string" ? p.result : JSON.stringify(p.result, null, 2);
    return { res, failed, out: out || "" };
  }

  // diffLines reads a diff for a card: the added and removed lines and the
  // lines around them, without the file headers (diff, index, ---, +++) or
  // the first hunk header; a later hunk starts after a "⋯" line. Color codes
  // and blank lines at the start are dropped.
  function diffLines(text) {
    const src = stripAnsi(text).split("\n");
    while (src.length && !src[0].trim()) src.shift();
    // A first line that names the files, "a/x.go → b/x.go", is a header too.
    if (src.length > 1 && /^\S.*(→|->)\s*\S/.test(src[0]) && !/^[-+ @]/.test(src[0])) src.shift();
    const out = [];
    let hunk = 0;
    for (const l of src) {
      if (/^(diff --git |index [0-9a-f]|--- |\+\+\+ |\\ No newline)/.test(l) || l === "---" || l === "+++") continue;
      if (l.startsWith("@@")) {
        if (hunk++ && out.length) out.push({ kind: "hunk", text: "⋯" });
        continue;
      }
      out.push({ kind: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "", text: l });
    }
    while (out.length && !out[out.length - 1].text.trim() && !out[out.length - 1].kind) out.pop();
    return out;
  }

  // drawParts puts parts in a node: text, code in monospace, chips, tones.
  function drawParts(el, node, parts) {
    node.replaceChildren(...parts.map((p) => {
      if (typeof p === "string") return p;
      if (p.code !== undefined) return el("code", "tcode", p.code);
      if (p.chip !== undefined) return el("span", "tchip", p.chip);
      if (p.link !== undefined) {
        const a = el("a", "tlink", p.text);
        a.href = p.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
        return a;
      }
      const cls = { ok: "notice-ok", bad: "notice-bad", warn: "notice-wait", add: "tadd", del: "tdel" }[p.tone] || "";
      return el("span", cls, p.text);
    }));
  }

  // drawTitle puts a card's title in its element: the words in the UI font,
  // the commands, code and paths in it in monospace elements of their own.
  function drawTitle(el, node, d) {
    if (Array.isArray(d.titleParts)) return drawParts(el, node, d.titleParts);
    if (d.code && d.title.endsWith(d.code)) node.replaceChildren(d.title.slice(0, d.title.length - d.code.length), el("code", "tcode", d.code));
    else node.replaceChildren(d.title);
  }

  // The card of each box, for the one click listener below.
  const cards = new WeakMap();

  // create builds the card of call c0 and returns its view: node, body (a
  // place for things a caller adds under the blocks), live (things shown
  // while it runs), update(c) to draw it again, toggle(), answer(text).
  // ctx: el, toast(text), highlight(code), diff(text), page(page), image(path),
  // zoom(src, name), more(call) (fetch the rest of a cut output).
  function create(ctx, c0) {
    const { el } = ctx;
    const T = window.HubTimes;
    const box = el("div", "tool notice");
    const head = el("button", "notice-head");
    head.type = "button";
    head.setAttribute("aria-expanded", "false");
    const title = el("span", "notice-title");
    const meta = el("div", "notice-meta");
    const sub = el("div", "tool-sub");
    const lineBox = el("div", "tool-lines");
    const wrap = el("div", "notice-body-wrap");
    wrap.hidden = true;
    const blocks = el("div", "notice-body");
    const raw = el("details", "tool-raw");
    raw.hidden = true;
    const extra = el("div", "tool-extra");
    const live = el("div", "tool-live");
    const visBig = el("div", "notice-sec vis-sec");
    visBig.hidden = true;
    wrap.append(visBig, blocks, raw, extra);
    const chev = window.HubIcons.icon("chev");
    chev.classList.add("notice-chev");
    let pending = false;
    const isOpen = () => head.getAttribute("aria-expanded") === "true";
    // flat says the card has nothing more to show when open: no chevron,
    // and a click does not open an empty body.
    const flat = () => !!view.derived && !view.derived.opens && !extra.children.length && !(view.cur && view.cur.partial);
    function shape() {
      const f = flat();
      head.classList.toggle("flat", f);
      if (f) head.removeAttribute("aria-expanded");
      else if (!head.getAttribute("aria-expanded")) head.setAttribute("aria-expanded", "false");
      if (f) wrap.hidden = true;
    }
    function toggle() {
      if (flat()) return;
      const open = !isOpen();
      head.setAttribute("aria-expanded", open ? "true" : "false");
      wrap.hidden = !open;
      if (open && !built) build();
      if (view.derived) {
        drawLines(view.derived);
        drawVision(view.derived);
      }
      // A snapshot sent only the start of a long output: fetch the rest as
      // the card opens.
      if (open && view.cur && view.cur.partial && ctx.more && !pending) {
        pending = true;
        Promise.resolve(ctx.more(view.cur, box)).catch(() => {}).finally(() => { pending = false; });
      }
    }
    const vis = el("div", "vis");
    vis.hidden = true;
    box.append(head, vis, live, wrap);
    const view = { node: box, body: extra, live, derived: null, cur: null, toggle, shape: () => shape() };
    cards.set(box, view);
    // The blocks of a card (and the code highlighting in them) are built when
    // the card first opens, not when it is created.
    let built = false;
    function build() {
      built = true;
      const d = view.derived;
      blocks.replaceChildren(...(d ? d.blocks : []).map(drawBlock));
      raw.hidden = !(d && d.raw);
      raw.open = false;
      raw.replaceChildren();
      if (d && d.raw) {
        const pre = el("pre", "tool-box");
        pre.textContent = d.raw;
        raw.append(el("summary", "", "Raw"), pre, copyButton(d.raw));
      }
    }
    // A page_publish card that made a page shows the page card in place of
    // the usual card, so the page opens from the chat. It is not a step
    // that folds into a group.
    let pageNode = null;
    let pagePath = "";
    function drawPage(d) {
      const page = d.page && d.state === "ok" && ctx.page ? d.page : null;
      if (page && pagePath !== page.path) {
        const node = ctx.page(page);
        if (node) {
          pageNode = el("div", "media tool-page-card");
          pageNode.append(node);
          pagePath = page.path;
        }
      }
      const on = !!page && !!pageNode;
      if (!on && pageNode) {
        pageNode.remove();
        pageNode = null;
        pagePath = "";
      }
      box.classList.toggle("tool", !on);
      box.classList.toggle("notice", !on);
      box.classList.toggle("tool-page", on);
      head.hidden = on;
      live.hidden = on;
      wrap.hidden = on || !isOpen();
      if (on) {
        box.setAttribute("aria-label", d.title);
        if (pageNode.parentNode !== box) box.append(pageNode);
      } else {
        box.removeAttribute("aria-label");
      }
      view.page = on ? page.path : "";
    }

    function copyButton(text) {
      const b = window.HubIcons.button("copy", "Copy", "ghost ib tool-copy");
      b.hubText = text;
      b.hubToast = ctx.toast;
      return b;
    }

    function drawBlock(b) {
      const sec = el("div", "notice-sec tool-sec");
      if (b.label) sec.append(el("b", "", b.label));
      let body;
      let copy = b.copy !== false;
      if (b.kind === "steps") {
        body = el("ol", "steps");
        for (const x of b.items) {
          const li = el("li");
          li.append(el("span", "st", x.text), el("span", x.state === "failed" ? "notice-bad" : x.state === "not_run" ? "notice-still" : "notice-ok", x.outcome));
          body.append(li);
        }
      } else if (b.kind === "kv") {
        body = el("dl", "tool-kv");
        for (const r of b.rows) {
          const dd = el("dd", r.mono ? "mono" : "");
          drawParts(el, dd, partsOf(r.v));
          body.append(el("dt", "", plain(str(r.k))), dd);
        }
        copy = false;
      } else if (b.kind === "list") {
        body = el("div", "tool-list");
        for (const it of b.items) {
          const o = isObj(it) && it.parts !== undefined ? it : { parts: it };
          const row = el("div", "tool-li" + (o.dim ? " dim" : "") + (o.mono ? " mono" : "") + (o.gap ? " gap" : ""));
          drawParts(el, row, partsOf(o.parts));
          body.append(row);
        }
        copy = false;
      } else if (b.kind === "question" && window.HubQuestion) {
        body = window.HubQuestion.view({ el, clock: (ms) => window.HubTimes.clock(ms) }, b.rec);
        copy = false;
      } else if (b.plain) {
        body = el("div", "tool-q", b.text);
      } else if (b.kind === "page") {
        body = el("div", "tool-page-read");
        if (b.meta) body.append(el("div", "pagemeta", b.meta));
        const pre = el("pre", "tool-box");
        pre.textContent = b.text;
        body.append(pre);
      } else if (b.kind === "diff") {
        body = el("pre", "diff tool-box");
        for (const l of diffLines(b.text)) body.append(el("span", l.kind, l.text || " "));
      } else {
        body = el("pre", "tool-box" + (b.kind === "command" ? " command" : ""));
        const html = b.kind === "command" && ctx.highlight ? ctx.highlight(b.text) : null;
        if (html !== null && html !== undefined) {
          body.innerHTML = html;
          body.classList.add("hljs");
        } else if (window.HubLinkify) {
          window.HubLinkify.append(body, b.text);
        } else {
          body.textContent = b.text;
        }
      }
      sec.append(body);
      if (copy && typeof b.text === "string" && b.text) sec.append(copyButton(b.text));
      return sec;
    }

    // drawLines draws the line under the title and the short lines under
    // the status; a line marked closed shows only while the card is closed.
    function drawLines(d) {
      const open = isOpen();
      const row = (l) => {
        const n = el("div", "tool-line" + (l.dim ? " dim" : "") + (l.mono ? " mono" : "") + (l.wrap ? " wrap" : ""));
        drawParts(el, n, l.parts);
        return n;
      };
      sub.hidden = !d.sub;
      sub.replaceChildren(...(d.sub ? [row(d.sub)] : []));
      const shown = d.lines.filter((l) => !(open && l.closed));
      lineBox.hidden = !shown.length;
      lineBox.replaceChildren(...shown.map(row));
    }

    // drawVision shows the image of a vision call: a thumbnail beside the
    // model's answer (or the question, while there is none) while the card
    // is closed, the image (tap for full screen), the question and the whole
    // answer when it is open. An image that cannot be shown, or that fails
    // to load, is a dashed placeholder, never a broken image.
    let seen = { key: "", broken: false };
    function gone() {
      const g = el("div", "vis-gone");
      g.setAttribute("aria-hidden", "true");
      g.append(window.HubIcons.icon("noimg"));
      return g;
    }
    function picture(src, name, cls, onBroken) {
      const b = el("button", cls);
      b.type = "button";
      b.setAttribute("aria-label", "Open image full screen");
      const img = el("img");
      img.alt = name;
      img.loading = "lazy";
      img.onerror = onBroken;
      img.src = src;
      b.append(img);
      b.onclick = () => ctx.zoom(src, name);
      return b;
    }
    // missing says why a kept screenshot cannot be shown: the plugin deletes
    // them after 7 days (and keeps each chat's newest 50).
    function missing(v) {
      return v.kind === "file" && /\/cache\/screenshots\/hermes-device\//.test(v.path || "")
        ? "The screenshot was removed after 7 days"
        : "Image not available here";
    }
    function drawVision(d) {
      const v = d.vision;
      const open = isOpen();
      if (!v) {
        vis.hidden = visBig.hidden = true;
        return;
      }
      let src = "";
      if (v.kind === "data") src = v.url;
      else if (v.kind === "file" && ctx.image) src = ctx.image(v.path) || "";
      const answer = str(v.answer);
      const key = v.kind + "|" + (v.path || "") + "|" + src.length + "|" + v.question + "|" + answer + "|" + open + "|" + d.state;
      if (key === seen.key) return;
      const keep = seen.broken && seen.src === src;
      seen = { key, broken: keep, src };
      const broken = () => {
        seen.broken = true;
        seen.key = "";
        drawVision(d);
      };
      const shown = src && !seen.broken && !!ctx.zoom;
      const name = v.path ? base(v.path) : "image";
      const path = v.path && !v.hidePath ? el("span", "vis-path", v.path) : null;
      vis.replaceChildren();
      visBig.replaceChildren();
      if (open) {
        vis.hidden = true;
        visBig.hidden = false;
        if (shown) {
          visBig.append(picture(src, name, "vis-big", broken));
          if (path) visBig.append(path);
        } else if (v.kind === "link") {
          visBig.append(link(v.url));
        } else if (v.kind !== "nothing") {
          visBig.append(el("span", "vis-note", missing(v)));
          if (path) visBig.append(path);
        }
        if (v.question) visBig.append(el("b", "", "Question"), el("div", "tool-q", v.question));
        if (answer) visBig.append(el("b", "", "Answer"), el("div", "tool-q vis-answer", answer));
        return;
      }
      visBig.hidden = true;
      vis.hidden = false;
      const q = el("div", "vis-q");
      if (answer) q.append(el("span", "qt", first(answer)));
      if (v.question) q.append(el(answer ? "small" : "span", answer ? "vis-ask" : "qt", v.question));
      if (shown) {
        vis.append(picture(src, name, "vis-thumb", broken), q);
      } else if (v.kind === "nothing") {
        vis.append(q);
      } else {
        vis.append(gone(), q);
        if (v.kind === "link") q.append(link(v.url));
        else {
          q.append(el("small", "", missing(v)));
          if (path) q.append(path);
        }
      }
    }
    function link(u) {
      const a = el("a", "vis-link");
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      let t = u;
      try {
        const x = new URL(u);
        t = x.host + (x.pathname === "/" ? "" : x.pathname);
      } catch (_) { /* the whole link */ }
      a.textContent = cut(t, 80);
      return a;
    }

    function drawMeta(d, c) {
      meta.replaceChildren();
      const more = () => {
        if (!d.more.length) return null;
        const s = el("span", "tool-more");
        drawParts(el, s, d.more);
        return s;
      };
      if (d.state === "run") {
        const lead = el("span", d.waiting ? "notice-wait" : "notice-run", d.status || "Running");
        meta.append(lead);
        const m = more();
        if (m) meta.append(" · ", m);
        // How long it has run, never the clock time: the message the card
        // belongs to shows that.
        if (T && T.valid(c.startedAt)) meta.append(" · ", T.ticking(el("span", "nowrap"), c.startedAt));
        return;
      }
      const tone = d.waiting ? "wait" : d.tone === "warn" ? "wait" : d.tone || (d.idle ? "still" : d.state);
      let lead = d.status ? el("span", "notice-" + tone, d.status) : null;
      const m = more();
      if (m) {
        const w = el("span", "tool-lead");
        if (lead) w.append(lead, " · ");
        w.append(m);
        lead = w;
      }
      // The status and how long the call ran, never the clock time: the
      // message the card belongs to shows that.
      if (T) T.finished(meta, 0, c.duration, lead || undefined);
      else if (lead) meta.append(lead);
    }

    view.update = (c) => {
      const d = derive(c);
      view.derived = d;
      view.cur = c;
      box.dataset.state = d.state;
      box.dataset.tool = c.name || "tool";
      const kids = [window.HubIcons.icon(d.icon || "tool"), title];
      if (d.chips.length) {
        const chips = el("span", "tool-chips");
        chips.append(...d.chips.map((x) => el("span", "tchip", x)));
        kids.push(chips);
      }
      kids.push(chev);
      if (d.statusLast) kids.push(sub, lineBox, meta);
      else kids.push(sub, meta, lineBox);
      head.replaceChildren(...kids);
      head.classList.toggle("chipped", d.chips.length > 0);
      drawTitle(el, title, d);
      title.title = d.title;
      drawMeta(d, c);
      drawLines(d);
      built = false;
      if (isOpen()) build();
      else {
        blocks.replaceChildren();
        raw.replaceChildren();
        raw.hidden = true;
      }
      drawPage(d);
      drawVision(d);
      shape();
      return d;
    };
    // answer keeps what the model said about the image the call looked at.
    view.answer = (text) => {
      if (!view.cur || view.cur.answer === text) return;
      view.cur.answer = text;
      view.update(view.cur);
    };
    view.update(c0);
    return view;
  }

  // One listener serves every card's head and copy buttons.
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const copy = t.closest(".tool-copy");
      if (copy && copy.hubText !== undefined) {
        navigator.clipboard.writeText(copy.hubText).then(() => copy.hubToast("Copied"), () => copy.hubToast("Could not copy: the browser did not allow it", { bad: true }));
        return;
      }
      const head = t.closest(".notice-head");
      const card = head && head.parentNode && cards.get(head.parentNode);
      if (card) card.toggle();
    });
  }

  // quiet says a tool call is not shown to the reader: the ledger is the
  // agent's own notebook, so a call that worked leaves no card. A call that
  // failed or was blocked is shown as any other.
  const quiet = (name, failed) => name === "ledger" && !failed;

  // mount builds the card of a call that started, for any log: the main
  // chat, a subagent's steps, the steps dialog. s: key (unique in the log),
  // name, args, startedAt (ms), batch (the id of the tool_call it ran in),
  // mem (the log's memory()). ctx is create's, plus what the log can do:
  // activity { opens(name, args), open(name, args, result) } (Show in
  // Activity), background(key) (the Run in background buttons of a
  // command, only where the hub can move it), fileCard(offer) (the card of
  // a file offered), refusal(node,
  // text) (an agent message that was refused), question() (a question card
  // replaced its tool card).
  function mount(ctx, s) {
    const { el } = ctx;
    const call = { name: s.name || "tool", args: s.args === undefined ? null : s.args, res: null, out: "", done: false, failed: false,
      startedAt: s.startedAt || 0, endedAt: 0, duration: undefined, mem: s.mem || memory(), batch: s.batch || "",
      here: ctx.here ? ctx.here() || "" : "" };
    const view = create(ctx, call);
    const node = view.node;
    node.view = view;
    node.call = call;
    node.toolName = call.name;
    node.batch = call.batch;
    node.classList.toggle("quiet", quiet(call.name, false));
    node.dataset.ukey = "t:" + s.key;
    node.classList.add("running");
    if (ctx.activity && ctx.activity.opens(call.name, call.args)) {
      const open = el("button", "link tool-open", "Show in Activity");
      open.type = "button";
      open.onclick = async () => {
        if (ctx.more && node.call.partial) await ctx.more(node.call, node);
        ctx.activity.open(call.name, call.args, node.result);
      };
      view.body.append(open);
      view.shape();
    }
    if (ctx.background && call.name === "terminal" && isObj(call.args) && typeof call.args.command === "string" && !call.args.background) {
      const acts = ctx.background(s.key);
      if (acts) view.live.append(acts);
    }
    return node;
  }

  // finish shows the end of a call on its card. p: result (raw), result_text,
  // is_error, error, inline_diff, duration (s), endedAt (ms, 0 when not
  // known), cut ({ row, call, size, lines } of an output the snapshot cut),
  // size (the whole result's length, when the result is its start), args
  // (when the start did not carry them).
  function finish(ctx, node, p) {
    if (!node.classList.contains("running") && node.finished) return;
    node.finished = true;
    const { el } = ctx;
    const call = node.call;
    if (!call.args && p.args) call.args = p.args;
    if (node.toolName === "clarify" && questionCard(ctx, node, p)) return;
    node.view.live.replaceChildren();
    if (p.result !== undefined) node.result = p.result;
    node.classList.remove("running");
    const { res, failed, out } = outcome(node.toolName, p);
    node.failed = failed;
    node.classList.toggle("failed", failed);
    node.classList.toggle("quiet", quiet(node.toolName, failed));
    call.done = true;
    call.partial = p.cut && (p.cut.row > 0 || p.cut.call) ? p.cut : null;
    call.res = res;
    call.failed = failed;
    call.error = typeof p.error === "string" ? p.error : "";
    const whole = typeof p.size === "number" && typeof p.result === "string" && p.size > p.result.length;
    call.out = (out || "") + (whole ? "\n… (" + p.size + " characters in all)" : "");
    call.diff = typeof p.inline_diff === "string" ? p.inline_diff : "";
    call.endedAt = p.endedAt || 0;
    // How long it ran: as the event says, else from its start and end when
    // both are known. A duration of 0 is no measure.
    let dur;
    if (typeof p.duration === "number") dur = p.duration > 0 ? p.duration : undefined;
    else if (call.startedAt > 0 && call.endedAt > call.startedAt) dur = (call.endedAt - call.startedAt) / 1000;
    node.duration = dur;
    call.duration = dur;
    call.mem.learn(call.name, call.args, res);
    node.view.update(call);
    if (node.toolName === "agent_send" && ctx.refusal) ctx.refusal(node, call.out + " " + call.error);
    // A refused offer is a failed call that still shows its file card.
    if (node.toolName === "send_file" && ctx.fileCard) fileOffer(ctx, node, res, call.endedAt);
    node.view.shape();
    void el;
  }

  // questionCard draws the finished clarify call as the card of its
  // questions, from the stored result: every choice that was offered with the
  // answer checked, and when and where it was answered. A result stored
  // before Hermes kept that stays the plain tool card (false).
  function questionCard(ctx, node, p) {
    let res = p.result !== undefined ? p.result : p.result_text;
    if (typeof res === "string") {
      try { res = JSON.parse(res); } catch (_) { return false; }
    }
    const Q = window.HubQuestion;
    const rec = Q && Q.fromResult(res);
    if (!rec || !node.parentNode) return false;
    const q = Q.view({ el: ctx.el, clock: (ms) => window.HubTimes.clock(ms) }, rec);
    if (node.dataset.ukey) q.dataset.ukey = node.dataset.ukey;
    node.parentNode.replaceChild(q, node);
    node.qcard = q;
    if (ctx.question) ctx.question();
    return true;
  }

  // fileOffer shows the file card of a send_file result next to its tool
  // card. The card is no .tool box, so folding the finished cards stops
  // at it and it stays in view.
  function fileOffer(ctx, node, res, at) {
    const o = res && res.file_offer;
    if (!o || typeof o.path !== "string" || (res.status !== "offered" && res.status !== "refused")) return;
    const card = ctx.fileCard(Object.assign({}, o, { status: res.status, at: at || 0 }));
    if (!card) return;
    const box = ctx.el("div", "file-offer");
    box.append(card);
    if (node.parentNode) node.after(box);
    else node.view.body.append(box);
  }

  // answers ties the model's words about an image to the card of the call
  // that looked at it: after a vision call ends, the first block of thinking
  // or reply that follows is its answer. A new tool call, or a second block,
  // ends the wait. tool(node) is called as a card finishes, start() as a
  // call starts, text(kind, chunk, more) as thinking ("think") or reply
  // ("say") text arrives (more: chunk adds to the block, else it is all).
  const visionTools = new Set(["vision_analyze", "browser_vision"]);
  function answers() {
    let wait = null;
    return {
      tool(node) {
        wait = node && node.view && visionTools.has(node.toolName) && !node.failed ? { node, kind: "", text: "" } : null;
      },
      start() {
        wait = null;
      },
      text(kind, chunk, more) {
        if (!wait) return;
        if (wait.kind && wait.kind !== kind) {
          wait = null;
          return;
        }
        wait.kind = kind;
        wait.text = more ? wait.text + str(chunk) : str(chunk);
        const t = wait.text.trim();
        if (t) wait.node.view.answer(t);
      },
    };
  }

  const util = { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, failedRes, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain };

  return { register, util, diffLines, drawTitle, quiet, derive, memory, create, mount, finish, answers, wrapped, take, calls, split, parse, outcome, statusLine, plain, batch };
})();
