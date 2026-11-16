"use strict";
// usage: node run.js MARKDOWN_JS. The renderer of the user's own messages
// (hubMarkdown.renderUser) in a small DOM that serializes to HTML: quotes,
// bold, italics, code, code blocks, lists, links, headings, line breaks as
// typed, and text people type with stray symbols (paths, globs, names)
// that must stay as typed. Hostile text stays inert.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
class Node_ {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.attrs = {}; this.className = ""; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get classList() {
    const n = this;
    const list = () => n.className.split(/\s+/).filter(Boolean);
    return { add: (c) => { if (!list().includes(c)) n.className = list().concat(c).join(" "); }, remove: (c) => { n.className = list().filter((x) => x !== c).join(" "); }, contains: (c) => list().includes(c) };
  }
  append(...k) { for (const x of k) { if (x.tag === "#frag") this.childNodes.push(...x.childNodes); else this.childNodes.push(x); } }
  appendChild(x) { this.append(x); return x; }
  removeChild(x) { this.childNodes = this.childNodes.filter((y) => y !== x); }
  replaceChildren(...k) { this.childNodes = []; this.append(...k); }
  set textContent(v) { this.childNodes = [{ tag: "#text", text: String(v) }]; }
  get textContent() { return this.childNodes.map((c) => (c.tag === "#text" ? c.text : c.textContent)).join(""); }
  set href(v) { this.attrs.href = v; }
  set rel(v) { this.attrs.rel = v; }
  set target(v) { this.attrs.target = v; }
  set type(v) { this.attrs.type = v; }
  setAttribute(k, v) { this.attrs[k] = v; }
}
const document = {
  createElement: (t) => new Node_(t),
  createDocumentFragment: () => new Node_("#frag"),
  createTextNode: (t) => ({ tag: "#text", text: t }),
};
const html = (n) => {
  if (n.tag === "#text") return esc(n.text);
  const a = (n.className ? ` class="${n.className}"` : "") + Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join("");
  const inner = n.childNodes.map(html).join("");
  return n.tag === "br" ? "<br>" : `<${n.tag}${a}>${inner}</${n.tag}>`;
};

const sandbox = { window: {}, document, URL, Set, Map, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const M = sandbox.window.hubMarkdown;
assert.ok(M && typeof M.renderUser === "function", "hubMarkdown.renderUser exists");

const draw = (text) => { const n = document.createElement("div"); M.renderUser(n, text); return n; };
const h = (text) => html(draw(text)).replace(/^<div class="md">|<\/div>$/g, "");
const eq = (text, want) => assert.strictEqual(h(text), want, JSON.stringify(text));

assert.ok(draw("x").classList.contains("md"), "the node is a .md");

// Quote: the marker is not shown as text.
eq("> From the model's next thinking, 1:15 PM\nDumb", "<blockquote><p>From the model&#39;s next thinking, 1:15 PM</p></blockquote><p>Dumb</p>".replace("&#39;", "'"));
eq("> quoted", "<blockquote><p>quoted</p></blockquote>");
// Bold, italics, strike, inline code.
eq("a **bold** and *it* and _it2_ and ~~gone~~", "<p>a <strong>bold</strong> and <em>it</em> and <em>it2</em> and <del>gone</del></p>");
eq("run `ls -la` now", "<p>run <code>ls -la</code> now</p>");
// Code block.
assert.ok(/<div class="codeblock">.*<code>let x = 1;<\/code>/.test(h("```js\nlet x = 1;\n```")), h("```js\nlet x = 1;\n```"));
// Lists.
eq("- a\n- b", "<ul><li>a</li><li>b</li></ul>");
eq("1. a\n2. b", "<ol><li>a</li><li>b</li></ol>");
// Links.
eq("[site](https://example.com/a)", '<p><a href="https://example.com/a" rel="noopener noreferrer" target="_blank">site</a></p>');
eq("see https://example.com/a_b_c, ok", '<p>see <a href="https://example.com/a_b_c" rel="noopener noreferrer" target="_blank">https://example.com/a_b_c</a>, ok</p>');
eq("go to www.example.com.", '<p>go to <a href="https://www.example.com/" rel="noopener noreferrer" target="_blank">www.example.com</a>.</p>');
// Headings render as a heading element (CSS keeps them at bold size).
eq("# Title", "<h1>Title</h1>");
// A single newline is a line break, as typed.
eq("one\ntwo\nthree", "<p>one<br>two<br>three</p>");
eq("one\n\ntwo", "<p>one</p><p>two</p>");
eq("  indented\nplain", "<p>  indented<br>plain</p>");

// Stray symbols stay as typed.
for (const t of [
  "/home/jacob/my_file_name.txt", "~/Projects/hermes_device/hub_test.go", "snake_case_name and other_name_here",
  "a * b * c", "2*3*4", "*.go and *.md", "rm *.log", "*.go,*.md", "just one * here", "a lone _ here", "__init__.py", "/x/_y_/z",
  "C:\\dir\\_tmp_\\x", "price is 5*3 or 5_3", "cp a_b c_d", "user@host_name:~/dir_x", "~tilde", "100% sure_", "foo*", "*foo",
]) {
  const out = h(t);
  assert.ok(!/<(em|strong|del)>/.test(out), "no surprise formatting: " + JSON.stringify(t) + " -> " + out);
  assert.strictEqual(draw(t).textContent, t, "text kept: " + JSON.stringify(t));
}
eq("a * b", "<p>a * b</p>");

const ALLOWED = new Set(["div", "p", "a", "code", "pre", "span", "button", "br", "blockquote", "ul", "ol", "li", "strong", "em", "del", "h1", "hr"]);
// Hostile text stays inert: no element but the ones the renderer makes.
for (const t of [
  "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "[x](javascript:alert(1))", "[x](data:text/html,<b>)",
  "<a href=\"javascript:alert(1)\">x</a>", "`<script>`", "```\n<script>alert(1)</script>\n```", "> <b onclick=x>hi</b>", "- <iframe src=//evil>",
  "<javascript:alert(1)>", "![i](javascript:alert(1))",
]) {
  const out = h(t);
  const tags = new Set();
  const walk = (n) => { if (n.tag !== "#text") { tags.add(n.tag); n.childNodes.forEach(walk); } };
  walk(draw(t));
  for (const x of tags) assert.ok(ALLOWED.has(x), "only the renderer's elements: " + JSON.stringify(t) + " has " + x);
  const hrefs = [];
  const links = (n) => { if (n.attrs && n.attrs.href) hrefs.push(n.attrs.href); (n.childNodes || []).forEach(links); };
  links(draw(t));
  for (const u of hrefs) assert.ok(/^https?:/i.test(u), "no script link: " + u);
  assert.ok(!out.includes("<script"), out);
}
// The original text is what the node's owner keeps: render does not change its input.
const src = "> q\n**b**";
draw(src);
assert.strictEqual(src, "> q\n**b**");
console.log("ok");
