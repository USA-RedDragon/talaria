"use strict";
const fs = require("fs");
const vm = require("vm");
const assert = require("assert");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(process.argv[2], "utf8"), sandbox);
const C = sandbox.window.HubCmd;

assert.strictEqual(C.parse("hello"), null);
assert.strictEqual(C.parse("/bg do it"), null);
assert.strictEqual(C.parse("/path/to/file"), null);
assert.deepStrictEqual({ ...C.parse(" /Compress keep the API") }, { name: "compress", arg: "keep the API", compress: true });
assert.strictEqual(C.parse("/compact").compress, true);
assert.strictEqual(C.parse("/model gpt").compress, false);

const c = C.parse("/compress");
assert.strictEqual(C.running(c, 0), "Compressing the chat...");
assert.strictEqual(C.running(c, 12000), "Compressing the chat... 12 s");
assert.strictEqual(C.running(c, 75000), "Compressing the chat... 1 min 15 s");
assert.strictEqual(C.running(C.parse("/compress --preview"), 0), "Checking what would be compressed...");
assert.strictEqual(C.running(C.parse("/new"), 0), "Running /new...");
assert.strictEqual(C.waiting(c), "The chat is working. It will compress when this turn ends.");
assert.strictEqual(C.waiting(C.parse("/new")), "The chat is working. /new will run when this turn ends.");

assert.strictEqual(C.result(c, "Compressed: 80 → 12 messages\nApprox request size: ~182,000 → ~24,000 tokens"), "Compressed: 182,000 tokens to 24,000");
assert.strictEqual(C.result(c, "No changes from compression: 6 messages\nApprox request size: ~900 tokens (unchanged)"), "Nothing to compress yet. The chat has 6 messages");
const failed = "Compression aborted: 40 messages preserved\nApprox request size: ~5,000 tokens (unchanged)\nSummary generation failed; no messages were removed.";
assert.strictEqual(C.result(c, failed), failed);
assert.strictEqual(C.result(c, ""), "Compressed.");
assert.strictEqual(C.result(C.parse("/model x"), "Model set to x"), "Model set to x");
assert.strictEqual(C.result(C.parse("/new"), ""), "Done: /new");
console.log("ok");
