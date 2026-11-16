"use strict";
// HubPeer names the other end of an agent message in plain words. Hermes
// says who it is in a few shapes: "parent", "subagent sa-0-1a2b3c4d", a bare
// "sa-0-1a2b3c4d", "chat 'title' (session 2026..._ab12)", "chat build" or just
// "build". A raw id is never shown when a name is known:
//   a subagent is its goal (one line, cut), from the names the chat knows;
//   a chat is its title; the parent is "the parent".
// A subagent nobody knows reads "a subagent (sa-0-1a2b3c4d)"; a chat nobody
// knows reads by what it was called, or "another chat".
// names.sub(id) gives a goal and names.chat(ref) a title, "" when unknown;
// HubPeer.names is the page's own pair, which the app sets.
window.HubPeer = (() => {
  const goalLen = 80;
  const squash = (s) => String(s == null ? "" : s).split(/\s+/).filter(Boolean).join(" ");
  const cut = (s, n) => {
    const r = Array.from(s);
    return r.length <= n ? s : r.slice(0, n).join("").trim() + "…";
  };
  const subID = /^sa-[0-9A-Za-z-]+$/;
  const sessionID = /^\d{8}_\d{6}_[0-9a-f]+$/;

  // parse reads the shape of a reference: { kind, id, name } where kind is
  // parent, sub, chat or "" (nothing said).
  function parse(ref) {
    let t = squash(ref);
    if (!t) return { kind: "", id: "", name: "" };
    t = t.replace(/^the\s+/i, "");
    if (/^parent(\s+(chat|agent))?$/i.test(t)) return { kind: "parent", id: "", name: "" };
    let m = /^subagent\s+(\S+)$/i.exec(t);
    if (m) return { kind: "sub", id: m[1], name: "" };
    if (subID.test(t)) return { kind: "sub", id: t, name: "" };
    m = /^chat\s+(sa-[0-9A-Za-z-]+)$/i.exec(t);
    if (m) return { kind: "sub", id: m[1], name: "" };
    // The hub's own wording: chat 'title' (session id).
    m = /^chat\s+'(.*)'\s+\(session\s+(\S+)\)$/i.exec(t);
    if (m) return { kind: "chat", id: m[2], name: squash(m[1]) };
    m = /^chat\s+(.+)$/i.exec(t);
    if (m) t = m[1].trim();
    t = t.replace(/^(['"])(.*)\1$/, "$2");
    return { kind: "chat", id: sessionID.test(t) ? t : "", name: sessionID.test(t) ? "" : t };
  }

  // who says the recipient or sender in words. label is the phrase to put
  // after "to" or "from" ("the subagent \"measure the antenna\""), id the raw
  // id for a details line, kind what it is.
  function who(ref, names) {
    const n = names || {};
    const p = parse(ref);
    if (p.kind === "parent") return { kind: "parent", label: "the parent", id: "", name: "" };
    if (p.kind === "sub") {
      const g = squash((n.sub && n.sub(p.id)) || "");
      if (g) return { kind: "sub", label: "the subagent \"" + cut(g, goalLen) + "\"", id: p.id, name: g };
      return { kind: "sub", label: "a subagent (" + p.id + ")", id: p.id, name: "" };
    }
    if (p.kind === "chat") {
      let name = p.name;
      if (!name || !p.id) {
        const got = squash((n.chat && n.chat(p.id || p.name)) || "");
        if (got) name = got;
      }
      if (name) return { kind: "chat", label: "the chat \"" + cut(name, goalLen) + "\"", id: p.id, name };
      return { kind: "chat", label: "another chat", id: p.id, name: "" };
    }
    return { kind: "", label: "another agent", id: "", name: "" };
  }

  return { parse, who, names: { sub: () => "", chat: () => "" } };
})();
