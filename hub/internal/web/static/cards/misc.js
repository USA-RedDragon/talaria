"use strict";
// Cards of other tools: MCP servers, deferred tools, unknown tools.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  function mcpCall(c) {
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "plug", blocks: [] };
    const tool = [str(a.server), str(a.tool)].filter(Boolean).join(".") || str(a.name);
    if (c.name === "mcp_device_call") out.title = verb(c, "Called ", "Calling ") + (short(tool) || "a tool") + " on your computer";
    else if (c.name === "mcp_device_tools") out.title = verb(c, "Looked up", "Looking up") + " the tools of " + (short(str(a.server)) || "a server") + " on your computer";
    else out.title = verb(c, "Looked up", "Looking up") + " the servers on your computer";
    out.status = "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function toolLookup(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "search", blocks: [] };
    out.title = verb(c, "Looked up", "Looking up") + " a tool";
    const list = Array.isArray(res.tools) ? res.tools : Array.isArray(res.matches) ? res.matches : Array.isArray(res.results) ? res.results : null;
    out.status = list ? plural(list.length, "match", "matches") : "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  // wrapped lists the calls that a tool_call of Hermes carries; take removes
  // the first of them named name and returns it.
  function wrapped(name, args) {
    if (name !== "tool_call" || !isObj(args) || !Array.isArray(args.calls)) return null;
    return args.calls.filter((x) => isObj(x) && typeof x.name === "string").map((x) => ({ name: x.name, args: x.arguments }));
  }

  function wrapper(c) {
    const a = isObj(c.args) ? c.args : {};
    const list = wrapped(c.name, a);
    const out = { icon: "tool", blocks: [] };
    out.title = list && list.length ? verb(c, "Ran ", "Running ") + plural(list.length, "tool") + " in one call" : verb(c, "Used", "Using") + " a deferred tool";
    out.status = "Done";
    if (Object.keys(a).length) out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function generic(c) {
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "tool", blocks: [] };
    let hint = "";
    for (const v of Object.values(a)) {
      const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "";
      if (s) {
        hint = short(s);
        break;
      }
    }
    out.title = (c.name || "tool") + (hint ? ": " + cut(hint, 60) : "");
    out.status = "Done";
    // The hub does not know this tool's format: its call and result are
    // shown as they came, behind Raw.
    out.raw = rawOf(c);
    return out;
  }


  H.register({ mcp_device_call: mcpCall, mcp_device_servers: mcpCall, mcp_device_tools: mcpCall, tool_search: toolLookup, tool_describe: toolLookup, tool_call: wrapper }, { generic });
})();
