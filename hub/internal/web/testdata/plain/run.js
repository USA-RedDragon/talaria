"use strict";
// Runs plain.js: node run.js plain.js
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");

const sandbox = { window: {}, String };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const P = sandbox.window.HubPlain;

const cases = {
  web_search: "Web search",
  code_execution: "Code execution",
  "systematic-debugging": "Systematic debugging",
  mcp_servers: "MCP servers",
  "agent.locked_keys": "Agent locked keys",
  "openai-codex": "OpenAI codex",
  "ascii-video": "ASCII video",
  "Already Fine": "Already Fine",
  "Claude": "Claude",
  "": "",
};
for (const [id, want] of Object.entries(cases)) assert.strictEqual(P.text(id), want, id);
assert.strictEqual(P.text(null), "");
assert.strictEqual(P.text(undefined), "");
// An unknown id never comes back as it went in.
for (const id of ["brand_new_toolset", "some.dotted.key", "third_party_tool"]) {
  assert.ok(!/[_.]/.test(P.text(id)), id);
}
// Sentences with ids in them are dropped; plain ones stay.
assert.strictEqual(P.clean("web_search, web_extract"), "");
assert.strictEqual(P.clean("approvals.mode is locked"), "");
assert.strictEqual(P.clean("The model is busy"), "The model is busy");
assert.strictEqual(P.clean(undefined), "");

// A failed turn's copy becomes one plain line; codes and ids stay in the folded details.
const copy = "Claude rejected this request as malformed, so the model didn't answer. Start a clean session with /new or switch models with /model; if it keeps happening, run `hermes doctor`.\n\nProvider said: HTTP 400: Incomplete upstream response (first upstream attempt: status 400, capture incomplete, native retries denied: 3, upstream said: messages.554.content.0: Invalid `encrypted_content` in `search_result` block): API Error: 400 HERMES_MODEL_ADMISSION_CONSUMED (request_id=req_011Ch7FeWfTSCk9rTqqUKFTh)";
const f = P.failure(copy);
assert.strictEqual(f.line, "The model request failed: Claude rejected this request as malformed.");
assert.ok(!/HERMES_|req_|HTTP 400|encrypted_content/.test(f.line), f.line);
assert.strictEqual(f.details, copy);
// A raw provider error with no plain first sentence shows no codes either.
assert.strictEqual(P.failure("HTTP 400: API Error: 400 HERMES_MODEL_ADMISSION_CONSUMED (request_id=req_1)").line, "The model request failed.");
assert.strictEqual(P.failure("").line, "The model request failed.");
