"use strict";
// Cards of commands: terminal, background commands, scripts.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, lines, stripAnsi, verb, errorText, exitCode, span } = H.util;

  // clock writes a length of time the way a command's run is told: 2 m 10 s.
  function clock(s) {
    s = Math.round(s);
    if (s < 60) return s + " s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " m" + (s % 60 ? " " + (s % 60) + " s" : "");
    return Math.floor(m / 60) + " h" + (m % 60 ? " " + (m % 60) + " m" : "");
  }

  // ranFor is how long a background command ran, when the result says: its uptime_seconds,
  // else the two Unix times. "" when it does not (an older Hermes), so no time is shown.
  function ranFor(res) {
    if (typeof res.exited_at === "number" && typeof res.started_at === "number" && res.exited_at >= res.started_at) return clock(res.exited_at - res.started_at);
    // An older Hermes counted uptime to now even for an exited command: trust it only beside a start time.
    return typeof res.started_at === "number" && typeof res.uptime_seconds === "number" && res.uptime_seconds >= 0 ? clock(res.uptime_seconds) : "";
  }

  // upFor is how long a command that has not exited has been running: from its start time to now.
  function upFor(res, now) {
    const started = typeof res.started_at === "number" ? res.started_at : typeof res.started_at_unix === "number" ? res.started_at_unix : 0;
    if (started <= 0 || typeof now !== "number" || now / 1000 - started < 5) return typeof res.uptime_seconds === "number" ? clock(res.uptime_seconds) : "";
    return clock(now / 1000 - started);
  }

  // secs writes a short run time: 0.3 s, 4.8 s, 41 s.
  const secs = (s) => (s < 10 ? Math.round(s * 10) / 10 + " s" : clock(s));

  const tail = (s) => last(stripAnsi(str(s)));
  const hasText = (s) => str(s).trim() !== "";

  // folder is where a command ran: the folder it was given, else the one
  // the result names.
  const folder = (a, res) => str(a.workdir) || str(res.cwd);

  const timedOut = (res) => res.status === "timeout" || res.status === "timed_out" || /timed out/i.test(errorText(res));

  // denied says a command did not run because the approval said no.
  function denied(res) {
    const e = errorText(res);
    return res.status === "blocked" || res.status === "denied" || res.status === "refused" || /\b(denied|declined|blocked|not approved)\b/i.test(e);
  }
  const deniedWhy = (res) => (/\b(user|you)\b.*\b(denied|declined)\b|\bdenied by the user\b/i.test(errorText(res)) ? "you declined the approval" : cut(squash(errorText(res).replace(/^BLOCKED:\s*/i, "")), 80));

  function terminal(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const cmd = str(a.command);
    const bg = !!a.background || res.status === "yielded_to_background";
    const out = { icon: "terminal", blocks: [], lines: [] };
    const dirText = folder(a, res);
    const shown = short(cmd);
    if (c.done && denied(res)) {
      out.title = [bg ? "Not started: " : "Did not run ", ...(shown ? [{ code: shown }] : ["the command"])];
      if (!shown && bg) out.title = ["Not started: the command"];
      out.status = "Refused";
      out.tone = "bad";
      out.ownFailure = true;
      out.bad = true;
      out.more = [deniedWhy(res)].filter(Boolean);
      return out;
    }
    const lead = bg ? verb(c, "Started in the background: ", "Starting in the background: ") : verb(c, "Ran ", "Running ");
    out.title = shown ? [lead, { code: shown }] : lead + "a command";
    const exit = exitCode(res);
    const watch = Array.isArray(a.watch_patterns) ? a.watch_patterns.map(str).filter(Boolean) : [];
    if (bg) {
      if (!c.failed) {
        const up = !c.done || typeof res.started_at !== "number" ? "" : upFor(res, typeof c.now === "number" ? c.now : Date.now());
        out.status = up ? "Running for " + up : "Running";
        out.tone = "warn";
        if (dirText) out.more = ["in ", { code: dirText }];
      }
      if (watch.length) out.lines.push({ parts: ["Watching for " + watch.map((w) => "\"" + w + "\"").join(", ")], dim: true });
      if (dirText && !out.more) out.lines.push({ parts: ["in ", { code: dirText }], dim: true });
    } else {
      if (timedOut(res)) {
        out.status = "Timed out";
        out.tone = "bad";
        out.ownFailure = true;
      } else if (exit !== null) {
        out.status = "Exit " + exit;
        // A nonzero exit is the command's own result, not a failed call.
        if (exit !== 0) out.ownFailure = true;
      } else out.status = "Done";
      if (dirText) out.lines.push({ parts: ["in ", { code: dirText }], dim: true });
    }
    // The start of a background command has nothing worth showing as output.
    if (cmd) out.blocks.push({ label: "Command", text: cmd, kind: "command" });
    if (bg && !c.failed) {
      if (dirText) out.blocks.push({ label: "Where", kind: "kv", rows: [{ k: "Folder", v: [dirText], mono: true }] });
    } else if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  // failedInner lists the inner tool calls of a script that failed.
  function failedInner(res) {
    return Array.isArray(res.tool_errors) ? res.tool_errors : [];
  }

  // meaningful is the line of a script that says what it does: the first
  // one that is no blank, no comment and no bare import, else the first.
  function meaningful(src) {
    const ls = str(src).split("\n").map((l) => l.trim()).filter(Boolean);
    const skip = (l) => l.startsWith("#") || /^(import|from)\s+\S+/.test(l);
    return ls.find((l) => !skip(l)) || ls[0] || "";
  }

  function code(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const src = str(a.code);
    const line = short(meaningful(src));
    const out = { icon: "terminal", blocks: [], lines: [] };
    const lead = verb(c, "Ran Python", "Running Python");
    out.title = line ? [lead + " ", { code: line }] : lead;
    if (a.reset) out.chips = ["Fresh session"];
    const status = str(res.status).toLowerCase();
    const calls = typeof res.tool_calls_made === "number" ? res.tool_calls_made : null;
    const stdout = str(res.output);
    const err = str(res.error) || errorText(res);
    const inner = failedInner(res);
    const exit = exitCode(res);
    const dur = typeof res.duration_seconds === "number" ? res.duration_seconds : null;
    const more = [];
    if (status === "timeout" || status === "timed_out") {
      out.status = "Timed out" + (typeof a.timeout === "number" ? " after " + a.timeout + " s" : dur !== null ? " after " + span(dur) : "");
      out.tone = "warn";
      out.ownFailure = true;
      out.bad = true;
    } else if (status === "interrupted") {
      out.status = "Interrupted";
      out.tone = "warn";
      out.ownFailure = true;
      out.bad = true;
    } else if (status === "error" || (exit !== null && exit !== 0)) {
      out.status = "Script error" + (exit !== null ? ": exit " + exit : "");
      out.ownFailure = true;
      out.bad = true;
    } else if (inner.length && calls !== null) {
      out.status = "Done, " + inner.length + " of " + calls + " tool calls failed";
      out.tone = "warn";
    } else if (inner.length) {
      out.status = "Done, " + plural(inner.length, "tool call") + " failed";
      out.tone = "warn";
    } else out.status = "Done";
    if (calls !== null && !inner.length) more.push(plural(calls, "tool call"));
    if (typeof c.duration !== "number" && dur !== null && !/^Timed out/.test(out.status)) more.push(secs(dur));
    out.more = more.flatMap((m, i) => (i ? [" · ", m] : [m]));
    // The line under the status: the error's last line, or the first line
    // of what the script printed.
    const body = stdout.trim() ? stdout : "";
    if (out.bad && (err.trim() || body.trim())) out.lines.push({ parts: [tail(err) || tail(body)] });
    else if (body) {
      const n = lines(stripAnsi(body));
      out.lines.push({ parts: [first(stripAnsi(body)), ...(n > 1 ? [{ chip: "+" + (n - 1) + " lines" }] : [])], dim: true });
    } else if (c.done && !out.bad) out.lines.push({ parts: ["No output"], dim: true });
    if (src) out.blocks.push({ label: "Code", text: src, kind: "pre" });
    let shownOut = stdout;
    if (err.trim() && !stdout.includes(err.trim())) shownOut += (shownOut && !shownOut.endsWith("\n") ? "\n" : "") + err;
    if (shownOut.trim()) out.blocks.push({ label: "Output", text: shownOut, pre: true });
    if (res.stdout_truncated || typeof res.warning === "string") {
      out.blocks.push({ label: "Note", text: str(res.warning) || "The output was cut", kind: "plain", plain: true, copy: false });
    }
    if (inner.length) {
      const items = inner.map((e) => {
        if (isObj(e)) return { parts: [str(e.tool || e.name || "A tool call"), ": ", cut(squash(str(e.error || e.message)), 100)] };
        return { parts: [cut(squash(str(e)), 120)] };
      });
      out.blocks.push({ label: "Tool calls that failed", kind: "list", items });
    }
    // An error that is only in the JSON: no output and no error text.
    if (out.bad && !err.trim() && !stdout.trim() && c.res) out.raw = H.util.json(c.res);
    return out;
  }

  // pmLast is the last output line of a background command's result.
  function pmLast(res) {
    return tail(res.output_preview) || tail(res.output);
  }

  function pm(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const act = str(a.action) || "list";
    const id = str(a.session_id);
    const known = str(res.command) || (c.mem && c.mem.proc(id)) || "";
    const cmd = short(known);
    const out = { icon: "activity", blocks: [], lines: [] };
    const exited = res.status === "exited" || res.status === "already_exited" || (typeof res.exit_code === "number" && res.status !== "killed");
    const exit = exitCode(res);
    const ran = ranFor(res);
    const exitText = (exit === null ? "Exited" : "Exited " + exit) + (ran && exited ? " after " + ran : "");
    const now = typeof c.now === "number" ? c.now : Date.now();
    const ok = !c.failed || exited;
    // The title: a verb, then the command in monospace; a command that is
    // not known by name is not named by its id.
    const title = (past, now, failed) => {
      const w = c.done ? (c.failed && !exited ? failed : past) : now;
      return [w + " background command" + (cmd ? " " : ""), ...(cmd ? [{ code: cmd }] : [])];
    };
    const tailLine = () => {
      const l = pmLast(res);
      if (l) out.lines.push({ parts: [{ code: l }], dim: true });
      else if (c.done && ok && (act === "poll" || act === "wait" || act === "log" || act === "kill") && (res.output !== undefined || res.output_preview !== undefined)) out.lines.push({ parts: ["No output yet"], dim: true });
    };
    const outBlock = () => {
      const text = str(res.output) || str(res.output_preview);
      if (text.trim()) out.blocks.push({ label: "Output", text: stripAnsi(text), pre: true });
    };
    switch (act) {
      case "kill":
        out.icon = "stop";
        out.title = title("Stopped", "Stopping", "Could not stop");
        out.status = res.status === "already_exited" ? exitText : "Stopped";
        tailLine();
        outBlock();
        break;
      case "wait":
        out.icon = "clock";
        out.title = title("Waited for", "Waiting for", "Could not wait for");
        if (exited) {
          out.status = exitText;
          if (exit !== null && exit !== 0) {
            out.tone = "bad";
            out.ownFailure = true;
          }
        } else if (res.status === "interrupted") out.status = "Interrupted";
        else {
          // A wait that has not finished is not a success; the card's own
          // duration says how long it waited.
          const up = upFor(res, now);
          out.status = "Still running" + (up ? ", up " + up : "");
          out.idle = true;
          out.ownFailure = res.status === "timeout";
        }
        tailLine();
        outBlock();
        break;
      case "poll":
        out.title = title("Checked", "Checking", "Could not check");
        if (exited) {
          out.status = exitText;
          if (exit !== null && exit !== 0) {
            out.tone = "bad";
            out.ownFailure = true;
          }
        } else {
          const up = upFor(res, now);
          out.status = "Still running" + (up ? ", up " + up : "");
        }
        tailLine();
        outBlock();
        break;
      case "log": {
        out.icon = "list";
        out.title = title("Read the output of", "Reading the output of", "Could not read the output of");
        const n = typeof res.total_lines === "number" ? res.total_lines : c.partial && c.partial.lines ? c.partial.lines : lines(str(res.output));
        out.status = plural(n, "line");
        tailLine();
        outBlock();
        break;
      }
      case "write":
      case "submit": {
        out.icon = "send";
        out.title = title("Sent input to", "Sending input to", "Could not send input to");
        out.status = "Sent";
        const data = str(a.data);
        const enter = act === "submit";
        const text = data.replace(/\n+$/, "");
        if (text.trim()) out.lines.push({ parts: [{ code: short(text) }, ...(enter ? [" then Enter"] : [])], dim: true });
        else if (enter) out.lines.push({ parts: ["Enter"], dim: true });
        if (data || enter) out.blocks.push({ label: "Sent", text: data + (enter && !data.endsWith("\n") ? "\n" : ""), pre: true });
        break;
      }
      case "close":
        out.title = title("Closed the input of", "Closing the input of", "Could not close the input of");
        out.status = "Closed";
        break;
      case "handoff": {
        out.icon = "send";
        out.title = title("Handed off", "Handing off", "Could not hand off");
        out.status = a.resume_on_exit ? "Waiting for exit, will wake this chat" : "Handed off";
        const note = str(a.data);
        if (note.trim()) out.lines.push({ parts: [short(note)], dim: true });
        if (note.trim()) out.blocks.push({ label: "Note", text: note, kind: "plain", plain: true });
        break;
      }
      default: {
        out.icon = "list";
        out.title = ["Listed background commands"];
        if (c.done && c.failed) out.title = ["Could not list background commands"];
        const list = Array.isArray(res.processes) ? res.processes.filter(isObj) : null;
        out.status = list ? plural(list.length, "command") : "Done";
        if (list && list.length) {
          const names = list.map((p) => short(str(p.command))).filter(Boolean);
          if (names.length) out.lines.push({ parts: [names.join(", ")], dim: true });
          out.blocks.push({
            label: "Commands",
            kind: "kv",
            rows: list.map((p) => {
              const st = str(p.status);
              const done = st === "exited" || typeof p.exit_code === "number";
              const t = typeof p.uptime_seconds === "number" ? clock(p.uptime_seconds) : "";
              const up = t && (typeof p.started_at_unix === "number" || typeof p.exited_at === "number") ? (done ? "ran " : "up ") + t : t;
              const state = done ? "Exited" + (typeof p.exit_code === "number" ? " " + p.exit_code : "") : st ? H.util.upperFirst(st) : "";
              return { k: short(str(p.command)) || "A command", v: [[state, up].filter(Boolean).join(", ")] };
            }),
          });
        }
      }
    }
    if (res.status === "not_found" && !c.failed) out.status = "No such command";
    return out;
  }

  H.register({ terminal, process_manage: pm, execute_code: code });
})();
