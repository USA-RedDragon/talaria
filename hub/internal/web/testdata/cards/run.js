"use strict";
// The cases of each card module: testdata/cards/<module>.json, one case for
// every state its mockup shows. A case is { name, learn, call, want }: call
// is what derive() gets (done and failed default to true and false; out and
// res as a finished call has them; result, when given, goes through
// outcome() as the page does), want holds only the fields the case checks:
//   icon, title, status, state, tone, code, chips (list), sub (text),
//   lines (texts), lineStyles ("dim mono" per line), more (text after the
//   status), blocks (labels), raw (true or false), page, vision, waiting
// usage: node run.js STATIC_DIR CASES_DIR
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const assert = require("assert");

const [dir, casesDir] = process.argv.slice(2);
const sandbox = { window: {} };
vm.createContext(sandbox);
sandbox.window.HubTimes = { clock: () => "12:56 PM", valid: (ms) => typeof ms === "number" && ms > 0 };
for (const f of ["peer.js", "toolcard.js", "questioncard.js", "approvals.js", ...fs.readdirSync(path.join(dir, "cards")).filter((x) => x.endsWith(".js")).sort().map((x) => "cards/" + x)]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), sandbox);
}
const H = sandbox.window.HubToolCard;
const text = (parts) => parts.map((p) => (typeof p === "string" ? p : p.code || p.chip || p.text || "")).join("");

let n = 0;
for (const f of fs.readdirSync(casesDir).filter((x) => x.endsWith(".json")).sort()) {
  for (const c of JSON.parse(fs.readFileSync(path.join(casesDir, f), "utf8"))) {
    const mem = H.memory();
    for (const l of c.learn || []) mem.learn(l.name, l.args, l.res);
    const call = Object.assign({ done: true, failed: false, out: "", res: null, mem }, c.call);
    if (c.call.result !== undefined) {
      const o = H.outcome(call.name, { result: typeof c.call.result === "string" ? c.call.result : JSON.stringify(c.call.result), is_error: c.call.is_error });
      Object.assign(call, { res: o.res, failed: o.failed || !!c.call.failed, out: c.call.out !== undefined ? c.call.out : o.out });
    }
    const d = H.derive(call);
    const all = {
      icon: d.icon, title: d.title, status: d.status, state: d.state, tone: d.tone || "", code: d.code, chips: d.chips,
      sub: d.sub ? text(d.sub.parts) : "", lines: d.lines.map((l) => text(l.parts)),
      lineStyles: d.lines.map((l) => [l.dim ? "dim" : "", l.mono ? "mono" : "", l.closed ? "closed" : "", l.wrap ? "wrap" : ""].filter(Boolean).join(" ")),
      more: text(d.more), blocks: d.blocks.map((b) => b.label || b.kind || ""), raw: !!d.raw, page: d.page || null, vision: d.vision || null, waiting: !!d.waiting,
    };
    const seen = {};
    for (const k of Object.keys(c.want)) seen[k] = all[k];
    assert.deepStrictEqual(JSON.parse(JSON.stringify(seen)), c.want, f + ": " + c.name);
    n++;
  }
}
console.log(n + " cases");
