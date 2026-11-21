"use strict";
// The pooled API credits provider in the web UI: the Usage page's "Pooled API
// credits" block, each account's credits line with its pooled spend and hold,
// the line under the model picker for a fallback and for a call that ran on
// API credits, and the line for the provider's own models. An old plugin that
// sends none of it gets today's lines.
process.env.TZ = "America/Chicago";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const { el, El } = require("../fakedom.js");

const [timesJS, claudeJS] = process.argv.slice(2);
const sandbox = { window: {}, document: {}, localStorage: { getItem() { return null; }, setItem() {} }, setInterval() {}, clearInterval() {}, clearTimeout() {}, setTimeout() {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(timesJS, "utf8"), sandbox);
vm.runInContext(fs.readFileSync(claudeJS, "utf8"), sandbox);

function texts(node, out = []) {
  if (node && node.childNodes) {
    for (const c of node.childNodes) {
      if (c instanceof El) texts(c, out);
      else out.push(c.data);
    }
  }
  return out;
}
const lines = (s) => texts(s).join("\n");
const flat = (parts) => parts.map((p) => (typeof p === "string" ? p : p.textContent)).join("");

const future = new Date(Date.now() + 3600 * 1000).toISOString();
const account = (id, credits) => ({ id, label: "Claude (" + id + ")", provider: "claude-" + id, signed_in: true, usage: { windows: [] }, credits });
const credits = (over) => Object.assign({ provider: "claude-api-caam", monthly_usd: 100, spent_usd: 27.4, left_usd: 72.6 }, over);

async function panelFor(data) {
  const C = sandbox.window.HubClaude({ api: async () => data, el, me: () => ({}), redraw() {} });
  return C.panel("main");
}

async function routeFor(pool, provider) {
  const api = async (method, path) => {
    assert.ok(path.startsWith("/api/claude/main/pool?session=s1"), path);
    return pool;
  };
  const C = sandbox.window.HubClaude({ api, el, me: () => ({ claude: true }), redraw() {} });
  const r = await C.route("main", "s1", provider || "claude-pool", "claude-opus-5-5");
  return { C, r };
}

(async () => {
  // The Usage page: the pooled block, the key the next call uses, and a held key.
  let s = await panelFor({ admin: false, accounts: [
    account("caam", credits({ pooled_spent_usd: 12, held_until: future, held_reason: "rate_limit", available: false })),
    account("jaam", credits({ provider: "claude-api-jaam", pooled_spent_usd: 0, available: true })),
  ], credits: { provider: "claude-credits", keys: 2, total_left_usd: 62.5, total_monthly_usd: 200, total_spent_usd: 137.5, pooled_spent_usd: 40, next: "jaam", message: null } });
  let t = lines(s);
  assert.ok(t.includes("Pooled API credits"), t);
  assert.ok(t.includes("About $63 of $200 left across 2 keys."), t);
  assert.ok(t.includes("Spent this month: $138 ($40 through the pool)."), t);
  assert.ok(t.includes("The next call uses jaam."), t);
  assert.ok(t.includes("API credits: about $73 of $100 left. $12 of it spent through the credits pool. Held until "), t);
  assert.ok(/\(rate limit\)\./.test(t), t);
  assert.strictEqual((t.match(/Held until/g) || []).length, 1, "only the held key says so");
  assert.ok(!/\$0 of it/.test(t), t);

  // No key has credit: the plain message, no next key.
  s = await panelFor({ admin: false, accounts: [account("caam", credits({ left_usd: 0, held_until: future, held_reason: "credit" }))],
    credits: { keys: 1, total_left_usd: 0, total_monthly_usd: 100, total_spent_usd: 100, pooled_spent_usd: 0, next: null, message: "No API key has credit left." } });
  t = lines(s);
  assert.ok(t.includes("About $0.00 of $100 left across 1 key."), t);
  assert.ok(t.includes("No API key has credit left."), t);
  assert.ok(!t.includes("The next call uses"), t);
  assert.ok(t.includes("(out of credit)"), t);

  // An old plugin: no pooled block and today's credits line, even with null fields.
  s = await panelFor({ admin: false, accounts: [account("caam", credits({ pooled_spent_usd: null, held_until: null, held_reason: null, available: null }))] });
  t = lines(s);
  assert.ok(!t.includes("Pooled API credits"), t);
  assert.ok(t.includes("API credits: about $73 of $100 left."), t);
  assert.ok(!t.includes("Held until") && !t.includes("credits pool"), t);
  s = await panelFor({ admin: false, accounts: [account("caam", credits())], credits: null });
  assert.ok(!lines(s).includes("Pooled API credits"));

  // A hold in the past is not shown.
  s = await panelFor({ admin: false, accounts: [account("caam", credits({ held_until: "2020-01-01T00:00:00Z", held_reason: "auth" }))] });
  assert.ok(!lines(s).includes("Held until"));

  // The line under the model picker.
  let { C, r } = await routeFor({ account: "", message: "", fallback: { provider: "claude-credits", account: "caam", label: "caam", api_provider: "claude-api-caam", left_usd: 62, message: "x" } });
  assert.strictEqual(flat(r.parts), "All accounts at their limit: the next turn runs on API credits (caam, about $62 left).");
  assert.ok(!r.bad, "a fallback is not an error");
  ({ r } = await routeFor({ account: "", message: "", fallback: { account: "caam", label: "Claude (caam)", left_usd: null } }));
  assert.strictEqual(flat(r.parts), "All accounts at their limit: the next turn runs on API credits (caam).");

  ({ C, r } = await routeFor({ account: "jaam", pinned: true, ran_on_credits: { account: "caam", label: "caam", api_provider: "claude-api-caam", at: "2026-11-20T15:00:00Z", model: "claude-opus-5-5", left_usd: 62 } }));
  assert.strictEqual(flat(r.parts), "Runs on jaam. Ran on API credits (caam, about $62 left).");
  assert.strictEqual(C.ranOn("main", "s1"), "Ran on API credits (caam, about $62 left)");

  // Old plugin answers: today's lines.
  ({ C, r } = await routeFor({ account: "", message: "All limits reached." }));
  assert.ok(r.bad && flat(r.parts) === "All limits reached.", JSON.stringify(r));
  assert.strictEqual(C.ranOn("main", "s1"), "");
  ({ C, r } = await routeFor({ account: "jaam", pinned: true, fallback: null, ran_on_credits: null }));
  assert.strictEqual(flat(r.parts), "Runs on jaam");
  assert.strictEqual(C.ranOn("main", "s1"), "");

  // The provider's own models and the per-account providers.
  ({ r } = await routeFor({}, "claude-credits"));
  assert.strictEqual(flat(r.parts), "Bills the API credits of whichever account has the most left.");
  ({ r } = await routeFor({}, "claude-api-caam"));
  assert.strictEqual(flat(r.parts), "Bills that account's monthly API credits.");

  // The status line names the account the pool runs the chat's next turn on.
  {
    const data = { admin: false, accounts: [account("caam"), account("jaam")] };
    const api = async (method, path) => (path.includes("/pool?") ? { account: "jaam", pinned: true } : data);
    const P = sandbox.window.HubClaude({ api, el, me: () => ({ claude: true }), redraw() {} });
    assert.strictEqual(P.poolNext("main", "s1"), null, "unknown before the pool answers");
    await P.panel("main");
    await P.route("main", "s1", "claude-pool", "claude-opus-5-5");
    assert.strictEqual(P.poolNext("main", "s1").label, "Claude (jaam)");
    assert.strictEqual(P.poolNext("main", "s2"), null, "another chat has its own answer");
  }
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
