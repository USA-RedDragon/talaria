"use strict";
// Cards of agents: subagents, messages between chats, questions.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  function delegate(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const act = str(a.action) || "spawn";
    const out = { icon: "bot", blocks: [] };
    const id = str(a.subagent_id) || str(res.subagent_id);
    const goalOf = () => short((c.mem && c.mem.sub(id)) || id) || "a subagent";
    if (act === "list") {
      out.icon = "list";
      out.title = verb(c, "Listed", "Listing") + " subagents";
      out.status = Array.isArray(res.subagents) ? plural(res.subagents.length, "subagent") + " running" : "Done";
    } else if (act === "steer") {
      out.icon = "compass";
      out.title = verb(c, "Message to subagent: ", "Sending a message to subagent: ") + goalOf();
      out.status = res.status === "queued" ? "Delivered at its next step" : str(res.status) ? squash(res.status) : "Delivered at its next step";
      if (a.message) out.blocks.push({ label: "Message", text: str(a.message), pre: true });
    } else if (act === "resume") {
      out.icon = "bot";
      out.title = verb(c, "Resumed subagent: ", "Resuming subagent: ") + goalOf();
      out.status = res.status === "dispatched" || res.status === "running" ? "Running again" : str(res.status) ? upperFirst(squash(res.status)) : "Running again";
      if (a.message) out.blocks.push({ label: "Message", text: str(a.message), pre: true });
    } else if (act === "transcript") {
      out.icon = "list";
      out.title = verb(c, "Read subagent steps: ", "Reading subagent steps: ") + goalOf();
      const n = typeof res.returned === "number" ? res.returned : Array.isArray(res.entries) ? res.entries.length : null;
      const all = typeof res.total_entries === "number" ? res.total_entries : null;
      out.status = n === null ? "Done" : all !== null && all > n ? "Last " + n + " of " + plural(all, "step") : plural(n, "step");
      if (res.running === true) out.status += ", still running";
    } else if (act === "stop") {
      out.icon = "stop";
      out.title = verb(c, "Stopped", "Stopping") + " subagent: " + goalOf();
      out.status = "Stopped";
    } else {
      const tasks = Array.isArray(a.tasks) ? a.tasks.filter(isObj) : [];
      const goals = tasks.length ? tasks.map((t) => str(t.goal)) : [str(a.goal)];
      out.title = tasks.length > 1 ? verb(c, "Started", "Starting") + " " + tasks.length + " subagents" : verb(c, "Started", "Starting") + " subagent: " + (short(goals[0]) || "a task");
      out.status = Array.isArray(res.results) ? plural(res.results.length, "result") : "Running in the background";
      out.blocks.push({ label: goals.length > 1 ? "Goals" : "Goal", text: goals.filter(Boolean).join("\n\n"), pre: true });
      if (a.context) out.blocks.push({ label: "Context", text: str(a.context), pre: true });
    }
    if (c.failed) out.status = failure(c);
    if (act === "list" || act === "stop" || act === "transcript" || act === "resume") out.raw = c.out;
    else if (c.out && !out.blocks.some((b) => b.label === "Output")) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function send(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "mail", blocks: [] };
    // The hub names the peer in the result ("chat 'name' (session id)",
    // "subagent sa-..."); the title says it in words: a subagent by its goal,
    // a chat by its title. The raw id goes in the details.
    const peer = who(str(res.to) || str(a.to), c.mem);
    out.title = verb(c, "Sent a message to ", "Sending a message to ") + peer.label;
    out.status = str(res.delivery) ? upperFirst(squash(res.delivery)) : "Sent";
    if (a.text) out.blocks.push({ label: "Message", text: str(a.text), pre: true });
    if (peer.id) out.blocks.push({ label: { sub: "Subagent", cron: "Scheduled job" }[peer.kind] || "Chat", text: peer.id, pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  // agentPeers and agentName are the tools that list the user's chats and
  // name this one.
  function agentPeers(c) {
    const out = { icon: "list", blocks: [], status: "Done" };
    out.title = verb(c, "Listed", "Listing") + " your chats";
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }

  function agentName(c) {
    const a = isObj(c.args) ? c.args : {};
    const name = short(str(a.name));
    const out = { icon: "edit", blocks: [], status: "Done" };
    out.title = name ? verb(c, "Named this chat ", "Naming this chat ") + name : verb(c, "Cleared", "Clearing") + " this chat's name";
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }


  H.register({ delegate_task: delegate, agent_send: send, agent_peers: agentPeers, agent_set_name: agentName });
})();
