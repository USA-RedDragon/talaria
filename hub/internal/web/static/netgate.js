"use strict";
// HubNetGate is the page's one view of its own network. A fetch that fails
// before any answer (TypeError, NetworkError, aborted, offline) is a drop on
// the user's side, not an error of the hub: the screen keeps what it has,
// says nothing for the first 10 seconds (the grace the event stream has had
// since v0.26.122), then shows one quiet "Reconnecting" state.
//
// While the network is down, a read (GET) is let through only as one probe
// at a time, after a wait that doubles from 1 s to 30 s with jitter, shared
// by every endpoint; every other read fails at once without a request, so a
// drop costs a handful of requests, not one per retry of every caller. The
// first answer of any kind, or the browser's online event, ends the drop and
// calls the listeners with "back" once, so the page refreshes everything once.
//
// o: now(), timer(fn, ms), clear(id), rand(), grace, base, max, probe (ms a
// probe may stay unanswered before another is let through).
window.HubNetGate = (o) => {
  const opt = o || {};
  const now = opt.now || (() => Date.now());
  const timer = opt.timer || ((fn, ms) => setTimeout(fn, ms));
  const clear = opt.clear || ((id) => clearTimeout(id));
  const grace = opt.grace === undefined ? 10000 : opt.grace;
  const probeMax = opt.probe || 15000;
  const wait = window.HubBackoff({ base: opt.base || 1000, max: opt.max || 30000, rand: opt.rand });
  const listeners = [];
  let downAt = 0;
  let nextAt = 0;
  let probeAt = 0;
  let quiet = false;
  let quietTimer = 0;
  let requests = 0;

  const once = [];
  const say = (what) => {
    for (const f of listeners.slice()) f(what);
    if (what !== "quiet") for (const f of once.splice(0)) f();
  };

  // isNetwork is true for a failure with no answer from the hub.
  function isNetwork(e) {
    if (!e || e.status) return false;
    if (e.network === true) return true;
    return e.name === "TypeError" || e.name === "AbortError" || e.name === "NetworkError";
  }

  // allow says whether a read may go out now. Up: always. Down: only the
  // probe, once its wait is over.
  function allow() {
    if (!downAt) return true;
    const t = now();
    if (t < nextAt) return false;
    if (probeAt && t - probeAt < probeMax) return false;
    probeAt = t;
    requests++;
    return true;
  }

  // failed notes a fetch that got no answer.
  function failed() {
    const t = now();
    probeAt = 0;
    if (!downAt) {
      downAt = t;
      quietTimer = timer(() => {
        quietTimer = 0;
        if (!downAt || quiet) return;
        quiet = true;
        say("quiet");
      }, grace);
    }
    nextAt = t + wait.next();
  }

  // answered notes any answer from the hub, whatever its status.
  function answered() {
    if (!downAt) return;
    const wasQuiet = quiet;
    clear(quietTimer);
    quietTimer = 0;
    downAt = 0;
    nextAt = 0;
    probeAt = 0;
    quiet = false;
    wait.reset();
    say(wasQuiet ? "back" : "recovered");
  }

  // online is the browser's word that the network is back: the next read is
  // the probe, at once.
  function online() {
    if (!downAt) return;
    nextAt = 0;
    probeAt = 0;
    wait.reset();
  }

  return {
    isNetwork, allow, failed, answered, online,
    // quiet: the drop has lasted past the grace, so the page says so.
    quiet: () => quiet,
    down: () => downAt !== 0,
    // retryIn is the ms until the next probe may go, at least 250.
    retryIn: () => Math.max(250, nextAt - now()),
    probes: () => requests,
    on: (f) => { listeners.push(f); },
    // whenBack calls f once, when the drop ends.
    whenBack: (f) => { once.push(f); },
  };
};

window.HubNet = window.HubNetGate();
if (window.addEventListener) window.addEventListener("online", () => window.HubNet.online());
