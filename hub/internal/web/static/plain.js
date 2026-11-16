"use strict";
// HubPlain turns an internal id (a toolset, a provider, a config key) into
// words for the screen: "web_search" becomes "Web search". The hub sends
// labels for tools, skills and connections; this is the fallback for any
// other id that reaches the page, so no snake_case or dotted key is shown.
window.HubPlain = (() => {
  const acronyms = { api: "API", mcp: "MCP", url: "URL", oauth: "OAuth", ssh: "SSH", ai: "AI", ascii: "ASCII", svg: "SVG", html: "HTML", pcb: "PCB", rf: "RF", id: "ID", tts: "TTS", stt: "STT", pdf: "PDF", gpu: "GPU", cli: "CLI", llm: "LLM", openai: "OpenAI", github: "GitHub" };
  const text = (id) => {
    const s = String(id == null ? "" : id).trim();
    if (!s || /[\s]/.test(s) || /[A-Z]/.test(s)) return s;
    const w = s.split(/[_\-.:/]+/).filter(Boolean).map((x) => acronyms[x] || x);
    if (w.length && w[0] === w[0].toLowerCase()) w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return w.join(" ");
  };
  // clean drops ids (snake_case or dotted keys) from a sentence that came
  // from somewhere else; it answers "" when one shows.
  const clean = (s) => (/[A-Za-z0-9]+(?:[_.][A-Za-z0-9]+)+/.test(String(s || "")) ? "" : String(s || ""));
  // failure turns the text of a failed turn (Hermes' failure copy, with the
  // provider's raw answer, status codes and request ids) into one plain line;
  // the whole text stays for a folded details view.
  const failure = (raw) => {
    const full = String(raw == null ? "" : raw).trim();
    let first = full.split(/\n/)[0].replace(/`/g, "");
    first = first.split(/(?<=[.!?])\s/)[0].replace(/,\s*so the model didn['\u2019]t answer\.?$/i, "").replace(/[.!?]+$/, "").trim();
    const internal = /[A-Z]{2,}_[A-Z_]{2,}|\breq_[A-Za-z0-9]|\bHTTP \d{3}\b|Provider said|request_id|[a-z]+\.\d+\.[a-z]+/;
    const reason = first && first.length <= 160 && !internal.test(first) ? first : "";
    return { line: "The model request failed" + (reason ? ": " + reason + "." : "."), details: full };
  };
  return { text, clean, failure };
})();
