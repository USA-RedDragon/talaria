"use strict";
// Cards of commands: terminal, background commands, scripts.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  function terminal(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const cmd = str(a.command);
    const bg = !!a.background || res.status === "yielded_to_background";
    const out = { icon: "terminal", blocks: [] };
    out.title = (bg ? verb(c, "Started in the background: ", "Starting in the background: ") : verb(c, "Ran ", "Running ")) + (short(cmd) || "a command");
    if (short(cmd)) out.code = short(cmd);
    const exit = exitCode(res);
    if (bg && !c.failed) out.status = "Running in the background";
    else if (exit !== null && exit !== 0) out.status = "Exit " + exit;
    else if (exit === 0) out.status = "Exit 0";
    else out.status = "Done";
    // A nonzero exit is the command's own result, not a failed call.
    if (exit !== null && exit !== 0) out.ownFailure = true;
    if (cmd) out.blocks.push({ label: "Command", text: cmd, kind: "command" });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function pm(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const act = str(a.action) || "list";
    const id = str(a.session_id);
    const cmd = short(str(res.command) || (c.mem && c.mem.proc(id)) || id);
    const out = { icon: "activity", blocks: [] };
    const exited = res.status === "exited" || res.status === "already_exited" || (typeof res.exit_code === "number" && res.status !== "killed");
    const exit = exitCode(res);
    const exitText = exit === null ? "Exited" : "Exited " + exit;
    switch (act) {
      case "kill":
        out.icon = "stop";
        out.title = verb(c, "Stopped", "Stopping") + " background command " + cmd;
        out.code = cmd;
        out.status = res.status === "already_exited" ? exitText : "Stopped";
        break;
      case "wait": {
        out.icon = "clock";
        out.title = verb(c, "Waited for", "Waiting for") + " background command " + cmd;
        out.code = cmd;
        if (exited) out.status = exitText;
        else if (res.status === "interrupted") out.status = "Interrupted";
        else {
          // The timeout asked for is not how long it waited; the card's own
          // duration is. A wait that has not finished is not a success.
          out.status = "Still running" + (typeof c.duration === "number" && c.duration >= 1 ? " after waiting " + span(c.duration) : "");
          out.idle = true;
        }
        break;
      }
      case "poll":
        out.title = verb(c, "Checked", "Checking") + " background command " + cmd;
        out.code = cmd;
        out.status = exited ? exitText : "Still running";
        break;
      case "log": {
        out.icon = "list";
        out.title = verb(c, "Read the output of", "Reading the output of") + " background command " + cmd;
        out.code = cmd;
        const n = typeof res.total_lines === "number" ? res.total_lines : c.partial && c.partial.lines ? c.partial.lines : lines(str(res.output));
        out.status = plural(n, "line");
        break;
      }
      case "write":
      case "submit":
        out.icon = "send";
        out.title = verb(c, "Sent input to", "Sending input to") + " background command " + cmd;
        out.code = cmd;
        out.status = "Sent";
        break;
      case "close":
        out.title = verb(c, "Closed the input of", "Closing the input of") + " background command " + cmd;
        out.code = cmd;
        out.status = "Closed";
        break;
      case "handoff":
        out.icon = "send";
        out.title = verb(c, "Handed off", "Handing off") + " background command " + cmd;
        out.code = cmd;
        out.status = "Handed off";
        break;
      default: {
        out.icon = "list";
        out.title = verb(c, "Listed", "Listing") + " background commands";
        const list = Array.isArray(res.processes) ? res.processes : null;
        out.status = list ? plural(list.length, "command") : "Done";
      }
    }
    if (res.status === "not_found") out.status = "No such command";
    out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }


  // code is execute_code: the first line of the script.
  function code(c) {
    const a = isObj(c.args) ? c.args : {};
    const src = first(str(a.code));
    const out = { icon: "terminal", blocks: [], status: "Done" };
    out.title = verb(c, "Ran ", "Running ") + (src ? short(src) : "code");
    if (src) out.code = short(src);
    if (a.code) out.blocks.push({ label: "Code", text: str(a.code), kind: "pre" });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  H.register({ terminal, process_manage: pm, execute_code: code });
})();
