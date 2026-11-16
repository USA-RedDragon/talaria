"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const sandbox = { window: {}, setTimeout, JSON };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const M = sandbox.window.HubMoveBg;

// A card that sees no tool.complete: what settle does after the wait.
async function run(over) {
  const seen = [];
  const o = {
    wait: 1, command: "du -sh ~/ROMs", finished: () => false,
    call: async () => { throw new Error("no stored result"); },
    processes: async () => ({ processes: [] }),
    done: (r) => seen.push(["done", r]), moved: (p) => seen.push(["moved", p.id]), back: () => seen.push(["back"]),
    ...over,
  };
  const how = await M.settle(o);
  return { how, seen };
}

(async () => {
  // The card ended meanwhile: nothing to do, never a second change.
  let r = await run({ finished: () => true });
  assert.deepStrictEqual(r, { how: "finished", seen: [] });

  // The command ended first and its result is stored: the card finishes with it.
  r = await run({ call: async () => ({ content: "{\"output\":\"x\",\"exit_code\":0}" }) });
  assert.deepStrictEqual(r, { how: "done", seen: [["done", "{\"output\":\"x\",\"exit_code\":0}"]] });

  // The move worked and the event was lost: the newest background command with this line.
  r = await run({ processes: async () => ({ processes: [
    { id: "proc_old", command: "du -sh ~/ROMs", started_at: 1 },
    { id: "proc_new", command: "du -sh ~/ROMs", started_at: 9 },
    { id: "proc_other", command: "ls", started_at: 99 }] }) });
  assert.deepStrictEqual(r, { how: "moved", seen: [["moved", "proc_new"]] });
  assert.strictEqual(JSON.parse(M.movedResult({ id: "proc_new" })).status, "yielded_to_background");

  // Nothing moved and nothing stored: the button comes back, never a pill for ever.
  r = await run({});
  assert.deepStrictEqual(r, { how: "back", seen: [["back"]] });
  r = await run({ processes: async () => { throw new Error("hub away"); } });
  assert.deepStrictEqual(r, { how: "back", seen: [["back"]] });

  // The tool.complete came while the state was being read: no second change.
  let ended = false;
  r = await run({ processes: async () => { ended = true; return { processes: [] }; }, finished: () => ended });
  assert.deepStrictEqual(r, { how: "finished", seen: [] });
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
