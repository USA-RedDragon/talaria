// Unit tests for loginguard.js. Run: node --test extension/firefox/loginguard_test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("./loginguard.js");

function guard(extra = []) {
  return { hosts: new Set(["portal.example.com", ...extra]), submitting: true, blocked: null };
}

test("grantableHost takes DNS names only", () => {
  for (const h of ["portal-api.example.com", "a.b.example.co"]) {
    assert.equal(g.grantableHost(h), true, h);
  }
  for (const h of ["localhost", "127.0.0.1", "Portal.example.com", "api.example.com:443", "", "a..b", "-a.example.com", "[::1]"]) {
    assert.equal(g.grantableHost(h), false, h);
  }
});

test("loginPostHosts keeps the login host's own valid hosts", () => {
  const map = { "portal.example.com": ["Portal-API.example.com", "portal.example.com", "10.0.0.1", "x", "portal-api.example.com"],
    "other.example.com": ["evil.example.net"] };
  assert.deepEqual(g.loginPostHosts(map, "portal.example.com"), ["portal-api.example.com"]);
  assert.deepEqual(g.loginPostHosts(map, "nope.example.com"), []);
  assert.deepEqual(g.loginPostHosts(null, "portal.example.com"), []);
  assert.deepEqual(g.loginPostHosts(["portal.example.com"], "portal.example.com"), []);
  assert.deepEqual(g.loginPostHosts({ "portal.example.com": "api.example.com" }, "portal.example.com"), []);
  assert.deepEqual(g.loginPostHosts({ __proto__: null, toString: ["a.example.com"] }, "constructor"), []);
  const many = { "portal.example.com": ["a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com"] };
  assert.equal(g.loginPostHosts(many, "portal.example.com").length, g.MAX_POST_HOSTS);
});

test("a login post to another host is cancelled and named", () => {
  const lg = guard();
  assert.equal(g.loginRequestCancels(lg, "POST", "https://portal.example.com/api/login"), false);
  assert.equal(g.loginRequestCancels(lg, "GET", "https://cdn.example.net/app.js"), false);
  assert.equal(g.loginRequestCancels(lg, "POST", "https://portal-api.example.com/api/portal/users/login"), true);
  assert.deepEqual(lg.blocked, { host: "portal-api.example.com", grantable: true });
  // The first cancelled host is the one reported.
  assert.equal(g.loginRequestCancels(lg, "POST", "https://metrics.example.org/collect"), true);
  assert.equal(lg.blocked.host, "portal-api.example.com");
  const res = g.loginBlockedResult(lg, { tab_id: 3, filled: true, landed_host: "portal.example.com" });
  assert.deepEqual(res, { tab_id: 3, filled: true, landed_host: "portal.example.com", submitted: false,
    needs_post_host: "portal-api.example.com",
    reason: "the login form sends to portal-api.example.com, which is not approved for this saved login" });
});

test("an allowed post host passes, only over https", () => {
  const lg = guard(["portal-api.example.com"]);
  assert.equal(g.loginRequestCancels(lg, "POST", "https://portal-api.example.com/api/portal/users/login"), false);
  assert.equal(g.loginRequestCancels(lg, "POST", "http://portal-api.example.com/api/portal/users/login"), true);
  const res = g.loginBlockedResult(lg, {});
  assert.equal(res.needs_post_host, undefined);
  assert.equal(res.submitted, false);
  assert.match(res.reason, /not an https host name/);
});

test("an IP address is cancelled but never offered for approval", () => {
  const lg = guard();
  assert.equal(g.loginRequestCancels(lg, "PUT", "https://10.1.2.3/login"), true);
  const res = g.loginBlockedResult(lg, {});
  assert.equal(res.needs_post_host, undefined);
  assert.match(res.reason, /10\.1\.2\.3/);
});

test("nothing is cancelled outside the submit window", () => {
  const lg = guard();
  lg.submitting = false;
  assert.equal(g.loginRequestCancels(lg, "POST", "https://elsewhere.example.net/"), false);
  assert.equal(g.loginRequestCancels(undefined, "POST", "https://elsewhere.example.net/"), false);
  assert.equal(lg.blocked, null);
});

test("a 307 to another host is cancelled and named", () => {
  const lg = guard();
  assert.equal(g.loginRedirectCancels(lg, "/next", "https://portal.example.com/login"), false);
  assert.equal(g.loginRedirectCancels(lg, "https://sso.example.net/login", "https://portal.example.com/login"), true);
  assert.deepEqual(lg.blocked, { host: "sso.example.net", grantable: true });
  const lg2 = guard(["sso.example.net"]);
  assert.equal(g.loginRedirectCancels(lg2, "https://sso.example.net/login", "https://portal.example.com/login"), false);
  assert.equal(g.loginRedirectCancels(lg2, "http://sso.example.net/login", "https://portal.example.com/login"), true);
  const lg3 = guard();
  assert.equal(g.loginRedirectCancels(lg3, "http://[bad", "https://portal.example.com/login"), true);
});
