"use strict";
// Shared guard of the browser-driven run.js scripts: an error the page throws
// (an uncaught exception or an unhandled rejection) fails the script, however
// the script ends, so a bug that only throws in a handler cannot pass behind a
// test that happens to look at something else. cdp.js and bidi.js call
// track(text) for each page error; the script's exit code becomes 1 and the
// errors are printed. PAGE_ERRORS_OK=1 turns the guard off for a script that
// throws on purpose.
const errors = [];
let hooked = false;

exports.track = (text) => {
  errors.push(String(text).slice(0, 600));
  if (hooked) return;
  hooked = true;
  process.on("exit", (code) => {
    if (process.env.PAGE_ERRORS_OK || !errors.length) return;
    console.error(`the page threw ${errors.length} error(s) while the script ran:\n  ` + errors.slice(0, 10).join("\n  "));
    if (!code) process.exitCode = 1;
  });
};
exports.errors = errors;
