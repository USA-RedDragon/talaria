"use strict";
// The Usage page's Subscription accounts panel: a person who cannot sign an
// account in is told why there is no Sign in button, not the agent's
// "run claude and log in" advice. Admins keep their button.
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const { el, El } = require("../fakedom.js");

const [claudeJS] = process.argv.slice(2);
const sandbox = { window: {}, document: {}, localStorage: { getItem() { return null; }, setItem() {} }, setInterval() {}, clearInterval() {}, clearTimeout() {}, setTimeout() {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(claudeJS, "utf8"), sandbox);

const unavailable = "no Claude subscription login found (run 'claude' and log in)";
const account = (over) => Object.assign({ id: "alice", label: "Claude (alice)", signed_in: false, usage: { unavailable } }, over);

// panelFor renders the Usage panel for a backend whose hub answer is data.
async function panelFor(data) {
  const C = sandbox.window.HubClaude({ api: async () => data, el, me: () => ({}), redraw() {} });
  const s = await C.panel("main");
  return s;
}

function texts(node, out = []) {
  if (node && node.childNodes) {
    for (const c of node.childNodes) {
      if (c instanceof El) texts(c, out);
      else out.push(c.data);
    }
  }
  return out;
}
const buttons = (s) => s.querySelectorAll("button").length;
const lines = (s) => texts(s).join("\n");

(async () => {
  // A person who is not a Claude admin, on a signed-out account the hub can sign in.
  let s = await panelFor({ admin: false, accounts: [account({})] });
  assert.strictEqual(buttons(s), 0, "no Sign in button for a non-admin");
  assert.ok(lines(s).includes("Only a Claude admin of this server can sign it in."), lines(s));
  assert.ok(!lines(s).includes("run 'claude'"), "the agent's run-claude advice is not shown");
  assert.ok(!lines(s).includes("Usage not available"), "the unavailable line is replaced");

  // An admin still gets the button and the agent's reason.
  s = await panelFor({ admin: true, accounts: [account({})] });
  assert.strictEqual(buttons(s), 1, "admin sees Sign in");
  assert.ok(lines(s).includes("Usage not available: " + unavailable), lines(s));
  assert.ok(!lines(s).includes("Only a Claude admin"), "admins get no such line");

  // A non-admin on a signed-in account sees its usage as before.
  s = await panelFor({ admin: false, accounts: [account({ signed_in: true })] });
  assert.strictEqual(buttons(s), 0);
  assert.ok(lines(s).includes("Usage not available: " + unavailable), lines(s));
  assert.ok(!lines(s).includes("Only a Claude admin"), "signed-in accounts get no sign-in line");

  // A non-admin on an account the hub cannot sign in (no_signin, such as ChatGPT) gets no line.
  s = await panelFor({ admin: false, pool: null, accounts: [account({ no_signin: true })] });
  assert.ok(!lines(s).includes("Only a Claude admin"), "no_signin accounts get no sign-in line");
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
