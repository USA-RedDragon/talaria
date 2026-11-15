"use strict";
// Usage page reset times: the ISO time from the hub, written in the viewer's
// zone with the zone name and, when it is not today, the day.
process.env.TZ = "America/Chicago";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const [timesJS, claudeJS] = process.argv.slice(2);
const sandbox = { window: {}, document: {}, setInterval() {}, clearInterval() {}, clearTimeout() {}, setTimeout() {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(timesJS, "utf8"), sandbox);
const T = sandbox.window.HubTimes;
const at = (iso) => Date.parse(iso);
const chicago = "America/Chicago";
const now = at("2026-11-14T19:00:00Z"); // Sat 1:00 PM CST

assert.strictEqual(T.reset(at("2026-11-14T19:59:00Z"), now, chicago), "today 1:59 PM CST");
assert.strictEqual(T.reset(at("2026-11-15T08:00:00Z"), now, chicago), "tomorrow 2:00 AM CST");
assert.strictEqual(T.reset(at("2026-11-16T14:00:00Z"), now, chicago), "Mon 8:00 AM CST");
assert.strictEqual(T.reset(at("2026-11-20T14:00:00Z"), now, chicago), "Fri 8:00 AM CST", "six days out is a weekday");
assert.strictEqual(T.reset(at("2026-12-01T08:00:00Z"), now, chicago), "Dec 1, 2:00 AM CST", "more than six days out is a date");
assert.strictEqual(T.reset(at("2026-11-14T10:00:00Z"), now, chicago), "today 4:00 AM CST", "a past time reads as today");
assert.strictEqual(T.reset(at("2026-11-15T05:30:00Z"), now, chicago), "today 11:30 PM CST", "11:30 PM is still today in Chicago");
assert.strictEqual(T.reset(at("2026-11-15T19:00:00Z"), now, "Asia/Tokyo"), "tomorrow 4:00 AM GMT+9", "the day is the day in the zone");
assert.strictEqual(T.reset(at("2026-11-14T19:59:00Z"), now, "UTC"), "today 7:59 PM UTC");
assert.strictEqual(T.reset(0, now, chicago), "");
assert.strictEqual(T.resetDay(at("2026-12-01T08:00:00Z"), chicago), "Dec 1");

// The Usage page's own phrasing, from the hub's ISO times, not its text.
vm.runInContext(fs.readFileSync(claudeJS, "utf8"), sandbox);
const C = sandbox.window.HubClaude({ api() {}, el() {} });
// The vm context has its own Date: give HubTimes the fixed clock through it.
vm.runInContext("Date.now = () => " + now, sandbox);
assert.strictEqual(C.reset({ resets_at: "2026-11-14T19:59:00Z", resets_text: "6:59 PM UTC" }), "today 1:59 PM CST");
assert.strictEqual(C.reset({ resets_at: "2026-11-16T14:00:00Z", resets_text: "Mon 2:00 PM UTC" }), "Mon 8:00 AM CST");
assert.strictEqual(C.reset({ resets_at: "2026-11-15T08:00:00Z", resets_text: "8:00 AM UTC" }), "tomorrow 2:00 AM CST");
assert.strictEqual(C.reset({ resets_text: "Mon 3:00 PM CST" }), "Mon 3:00 PM CST", "no ISO time: the backend's text");
assert.strictEqual(C.reset({}), "");
