"use strict";
// What the page gives the one chat view (chatview.js) to draw with, for the
// node tests: the fake DOM's el, the chat's words, and Markdown and media
// helpers that keep the text as it is.
const words = { tobottom: "Jump to latest", newone: "1 new message", newmany: "%d new messages", waiting: "Waiting" };

module.exports = (el) => ({
  el,
  toast: () => {},
  t: (k) => words[k] || k,
  render: (node, raw) => node.replaceChildren(raw),
  media: {
    directives: (text) => ({ text, paths: [] }),
    hidePending: (text) => text,
    markdownMedia: () => null,
    pageCard: () => el("div", "page"),
    mediaRow: () => el("div", "media"),
    attachmentRow: () => el("div", "atts"),
    split: (text) => ({ text, atts: [] }),
  },
});

// sandbox is what the page's scripts find around them in a node test: the
// fake DOM, frames that run at once, and observers that see nothing.
module.exports.sandbox = (document) => {
  class Quiet { observe() {} unobserve() {} disconnect() {} }
  const listen = { addEventListener() {}, removeEventListener() {} };
  const window = Object.assign({ hubMarkdown: { renderUser: (n, t) => n.append(t), render: (n, t) => n.replaceChildren(t) } }, listen);
  return { window, document: Object.assign(document, listen), setInterval: () => 1, clearInterval: () => {}, setTimeout: (fn) => { fn(); return 1; },
    requestAnimationFrame: (fn) => { fn(); return 1; }, ResizeObserver: Quiet, MutationObserver: Quiet, AbortController,
    URL, Date, Math, JSON, Intl };
};
