// Unit tests of pageMethod in background.js, with a fake page: run with
// `node --test pagemethod_test.js` (pagemethod_node_test.go does).
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const start = src.indexOf("function pageMethod(");
const end = src.indexOf("\n}\n", start);
const refused = /const REFUSED_METHOD = \/(.+)\/i;/.exec(src)[1];

// page builds pageMethod over fake buttons; clicked lists the texts clicked.
// opts sets the page's title, text, path and whether it has an email field.
function page(texts, opts = {}) {
  const clicked = [];
  const els = texts.map((text) => ({
    tagName: "BUTTON", innerText: text, disabled: false, form: null,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }),
    contains: () => false, click() { clicked.push(text); },
  }));
  const field = { tagName: "INPUT", getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const title = opts.title === undefined ? "Sign in" : opts.title;
  const document = {
    title, readyState: "complete", body: { innerText: opts.text === undefined ? title + "\n" + texts.join("\n") : opts.text },
    querySelectorAll: (sel) => (sel.startsWith("input[type=password]") ? [] : sel.startsWith("input[") ? (opts.email ? [field] : []) : els),
  };
  const path = opts.path || "/";
  const location = { protocol: "https:", hostname: "login.example.com", href: "https://login.example.com" + path, pathname: path };
  const getComputedStyle = () => ({ visibility: "visible", display: "block" });
  const fn = new Function("document", "location", "getComputedStyle", src.slice(start, end + 2) + "\nreturn pageMethod;")(
    document, location, getComputedStyle);
  return { run: (label) => fn(["login.example.com"], "login.example.com", label, true, refused), clicked };
}

const W3ID = "w3id Password Use your w3id and password if you can't use a passkey.";

test("a label that starts a button's text clicks that button", () => {
  const p = page(["Passkey Use a passkey on this device", W3ID]);
  const out = p.run("w3id Password");
  assert.strictEqual(out.clicked, true);
  assert.strictEqual(out.prefix, true);
  assert.deepStrictEqual(p.clicked, [W3ID]);
});

test("an exact label wins over a longer one", () => {
  const p = page(["Password", "Password Use your password here"]);
  assert.strictEqual(p.run("Password").clicked, true);
  assert.deepStrictEqual(p.clicked, ["Password"]);
});

test("no prefix match inside a word, on a short rest, or when the rest names a passkey", () => {
  for (const texts of [["Password-reset your account now"], ["Password help"], ["Password with passkey on phone"],
    ["Passwords Use your passwords here"]]) {
    const p = page(texts);
    const out = p.run("Password");
    assert.strictEqual(out.clicked, false, texts[0]);
    assert.strictEqual(out.matched, 0, texts[0]);
    assert.deepStrictEqual(p.clicked, []);
  }
});

test("two buttons that start with the label click nothing", () => {
  const p = page(["Password Use your password here", "Password Use another password here"]);
  const out = p.run("Password");
  assert.strictEqual(out.matched, 2);
  assert.deepStrictEqual(p.clicked, []);
});

test("a configured label that names a passkey is refused", () => {
  const p = page([W3ID]);
  assert.match(p.run("Passkey").error, /passkey/);
  assert.deepStrictEqual(p.clicked, []);
});

test("long labels are listed cut at a word break", () => {
  const long = "Password " + "word ".repeat(30).trim();
  const out = page([long]).run("");
  assert.ok(out.labels[0].length <= 80);
  assert.ok(long.startsWith(out.labels[0]));
  assert.ok(!out.labels[0].endsWith(" "));
});

const methods = new Function(src.slice(src.indexOf("function methodName("), src.indexOf("// SIGNED_IN_MS")) +
  "\nreturn { methodName, passwordMethod };")();

test("the one password method is chosen; none when two or none name a password", () => {
  const pick = (labels) => methods.passwordMethod(labels, refused);
  assert.strictEqual(pick(["Password help", "Passkey", "Password", "Approve on phone"]), "Password");
  assert.strictEqual(pick(["Passkey Use a passkey on this device", W3ID, "IBM Verify Approve on your phone"]), "w3id Password");
  assert.strictEqual(pick(["Work password", "Home password", "Passkey"]), "");
  assert.strictEqual(pick(["Forgot password?", "Reset password", "Password with passkey", "Passkey"]), "");
  assert.strictEqual(pick(["jacob@example.com acme", "Billing & Usage", "Log Explorer"]), "");
});

test("an account menu on a page that asks nothing is not a sign-in page", () => {
  const p = page(["jacob@example.com acme", "Billing & Usage", "Log Explorer", "Contact Support"],
    { title: "Example Portal", path: "/organizations/acme/billing", text: "Billing & Usage\nCurrent Credit Amount $12.34" });
  const out = p.run("");
  assert.strictEqual(out.signin, false);
  assert.strictEqual(out.ready, "complete");
  assert.deepStrictEqual(p.clicked, []);
});

test("a title, text, address or email field that asks to sign in makes a sign-in page", () => {
  for (const opts of [{ title: "Log in | Example" }, { title: "Example", text: "Choose how to sign in" },
    { title: "Example", text: "x", path: "/login" }, { title: "Example", text: "x", path: "/oauth2/authorize" },
    { title: "Example", text: "Next", email: true }, { title: "Example", text: "Pick an account" }]) {
    assert.strictEqual(page(["Next"], opts).run("").signin, true, JSON.stringify(opts));
  }
});
