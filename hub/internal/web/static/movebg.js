"use strict";
// HubMoveBg settles the Run in background button of a running terminal
// card. Hermes only asks the command to move: the answer is the card's own
// tool.complete event, which a move that raced the end of the command, a
// stream that reconnected, or a device that never answered can leave out.
// settle waits o.wait ms after the hub took the request, and then, if the
// card still runs, reads the state instead of waiting for ever:
//   1. the stored result of the call (the command ended): o.done(result);
//   2. a background command of the chat with the same command line (the
//      move worked): o.moved(process);
//   3. neither: o.back(), the card shows the button again.
// o: wait, timer (setTimeout), finished(), call(), processes(), command.
window.HubMoveBg = (() => {
  async function read(o) {
    try {
      const r = await o.call();
      const full = r && r.content != null ? r.content : r && r.text;
      if (full != null) return { done: full };
    } catch (_) { /* no stored result yet */ }
    try {
      const st = await o.processes();
      const list = (st && st.processes) || [];
      const mine = list.filter((p) => p && p.command === o.command);
      mine.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
      if (mine.length) return { moved: mine[0] };
    } catch (_) { /* unreadable: the card goes back to its button */ }
    return {};
  }

  function settle(o) {
    return new Promise((resolve) => {
      (o.timer || setTimeout)(async () => {
        if (o.finished()) { resolve("finished"); return; }
        const got = await read(o);
        if (o.finished()) { resolve("finished"); return; }
        if (got.done !== undefined) { o.done(got.done); resolve("done"); return; }
        if (got.moved) { o.moved(got.moved); resolve("moved"); return; }
        o.back();
        resolve("back");
      }, o.wait);
    });
  }

  // movedResult is the result of a call that Hermes moved to the background,
  // as Hermes words it for a command it handed over itself.
  function movedResult(p) {
    return JSON.stringify({ status: "yielded_to_background", session_id: p.id, exit_code: null });
  }

  // wait is how long the card gives its own event before it reads the state.
  return { settle, movedResult, wait: 8000 };
})();
