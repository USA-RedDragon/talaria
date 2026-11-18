// Self-update of the extension. Firefox checks for extension updates once a
// day, so a fix can wait hours. Where the browser has
// runtime.requestUpdateCheck, the extension asks for a check itself when it
// starts, every few hours, and whenever the daemon or the plugin names a
// version newer than its own. Firefox does not implement it (its runtime
// schema marks it "unsupported", so browser.runtime.requestUpdateCheck is
// undefined, checked on Firefox 157); there the state is "manual": the
// update comes with Firefox's daily check or a check in about:addons. Either
// way an available update (runtime.onUpdateAvailable) is applied with
// runtime.reload as soon as no agent action is in flight, so a running
// action is never cut. The logic takes its environment as
// arguments, so a unit test can run it with a stubbed runtime
// (update_test.js).
"use strict";

const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
// After a throttled or failed check, Firefox may answer again later.
const UPDATE_RETRY_MS = 30 * 60 * 1000;
// While an action is in flight, how often a waiting reload looks again.
const UPDATE_IDLE_POLL_MS = 2000;

// parseVersion returns the numbers of a dotted version such as 0.31.1, or
// null when v is not one (a dev build, an empty string).
function parseVersion(v) {
  if (typeof v !== "string" || !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(v)) {
    return null;
  }
  return v.split(".").map(Number);
}

// compareVersions returns -1, 0 or 1, or NaN when either is not a version.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    return NaN;
  }
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

// createUpdater returns the updater. env has:
//   runtime       requestUpdateCheck() and reload() (browser.runtime)
//   ownVersion    the extension's own version
//   busy()        true while an agent action, batch or script is in flight
//   report(state, version) tells the daemon: "checking", "current", "pending",
//                 "throttled", "error" or "manual" (the browser cannot be
//                 asked for a check)
//   setTimeout, clearTimeout (default: the globals)
function createUpdater(env) {
  const st = env.setTimeout || setTimeout;
  const ct = env.clearTimeout || clearTimeout;
  let checking = false;
  let pending = "";
  let retry = null;
  let poll = null;
  const asked = new Set();
  const u = {};

  u.state = () => (pending ? "pending" : "");
  u.pendingVersion = () => pending;

  // tryReload reloads the extension when an update waits and nothing is in
  // flight; otherwise it looks again soon. It never cuts a running action.
  u.tryReload = () => {
    if (!pending) {
      return false;
    }
    if (env.busy()) {
      if (!poll) {
        poll = st(() => {
          poll = null;
          u.tryReload();
        }, UPDATE_IDLE_POLL_MS);
      }
      return false;
    }
    if (poll) {
      ct(poll);
      poll = null;
    }
    env.runtime.reload();
    return true;
  };

  // onUpdateAvailable is the runtime.onUpdateAvailable listener.
  u.onUpdateAvailable = (details) => {
    const v = details && details.version;
    // An update that is not newer than this one would reload in a loop.
    if (compareVersions(v, env.ownVersion) !== 1) {
      return;
    }
    pending = v;
    env.report("pending", v);
    u.tryReload();
  };

  // check asks Firefox for an update now.
  u.check = async () => {
    if (checking || pending) {
      return;
    }
    if (typeof env.runtime.requestUpdateCheck !== "function") {
      // Nothing to retry: only Firefox's own check finds the update.
      env.report("manual", "");
      return;
    }
    checking = true;
    env.report("checking", "");
    let res;
    try {
      res = await env.runtime.requestUpdateCheck();
    } catch (e) {
      res = { status: "error" };
    } finally {
      checking = false;
    }
    const status = res && res.status;
    if (status === "update_available") {
      // onUpdateAvailable names the version; this covers an answer that
      // comes first.
      u.onUpdateAvailable({ version: res.version });
    } else if (status === "no_update") {
      env.report("current", "");
    } else {
      // "throttled", or an error: Firefox may allow a check later.
      env.report(status === "throttled" ? "throttled" : "error", "");
      if (retry) {
        ct(retry);
      }
      retry = st(() => {
        retry = null;
        u.check();
      }, UPDATE_RETRY_MS);
    }
  };

  // noteVersions is called with the versions a daemon or plugin reports.
  // The first time one is newer than the extension, it asks for a check.
  u.noteVersions = (...versions) => {
    for (const v of versions) {
      if (compareVersions(v, env.ownVersion) === 1 && !asked.has(v)) {
        asked.add(v);
        u.check();
        return true;
      }
    }
    return false;
  };

  // start checks now and every few hours.
  u.start = () => {
    u.check();
    return setIntervalFn(env, u);
  };
  return u;
}

function setIntervalFn(env, u) {
  const every = env.setInterval || setInterval;
  return every(() => u.check(), UPDATE_CHECK_EVERY_MS);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createUpdater, compareVersions, parseVersion, UPDATE_CHECK_EVERY_MS, UPDATE_RETRY_MS, UPDATE_IDLE_POLL_MS };
}
