"use strict";
// HubCmd words the progress of a slash command that Hermes runs outside a
// turn (/compress, /new, /model): a line while it runs, a line for the
// result, and one for a command that waits for the running turn to end.
window.HubCmd = (() => {
  // parse names the command in text, or null for text that is not one the
  // hub sends as a command (/bg has its own path).
  function parse(text) {
    const m = /^\s*\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(String(text || ""));
    if (!m || /^(bg|background)$/i.test(m[1])) return null;
    const name = m[1].toLowerCase();
    return { name, arg: (m[2] || "").trim(), compress: name === "compress" || name === "compact" };
  }

  function elapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? s + " s" : Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
  }

  // running is the line while the command runs.
  function running(cmd, ms) {
    const base = cmd.compress ? (/--preview/.test(cmd.arg) ? "Checking what would be compressed..." : "Compressing the chat...") : "Running /" + cmd.name + "...";
    return ms >= 1000 ? base + " " + elapsed(ms) : base;
  }

  // waiting is the line while a turn runs and the command waits for it.
  function waiting(cmd) {
    return cmd.compress ? "The chat is working. It will compress when this turn ends."
      : "The chat is working. /" + cmd.name + " will run when this turn ends.";
  }

  // result is the line when the command is done.
  function result(cmd, output) {
    const out = String(output || "").trim();
    if (!cmd.compress) return out || "Done: /" + cmd.name;
    const t = /~([\d,]+)\s*(?:→|->)\s*~([\d,]+)\s*tokens/.exec(out);
    if (t && /^Compressed/.test(out)) return "Compressed: " + t[1] + " tokens to " + t[2];
    if (/^No changes/.test(out)) return "Nothing to compress yet. " + out.split("\n")[0].replace(/^No changes from compression:\s*/, "The chat has ") ;
    return out || "Compressed.";
  }

  return { parse, running, waiting, result, elapsed };
})();
