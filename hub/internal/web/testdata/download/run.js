"use strict";
// Downloads one file from the hub in headless Chrome and waits for Chrome
// to finish it, resuming it when the connection breaks.
// usage: node run.js CHROME HUB_URL PROFILE_DIR FILE_URL DOWNLOAD_DIR
// Prints the progress and, last, one JSON line {"file", "bytes"}.
// Chrome resumes an interrupted download by itself when the answer had a
// strong validator and Accept-Ranges; when it gives up instead, this
// presses Resume on chrome://downloads, as a user would.
const [bin, url, dir, fileURL, downloads] = process.argv.slice(2);

const { proc, connect } = require("../cdp.js").launch(bin, dir);

// browserSocket opens a DevTools socket to the browser target, whose
// Browser domain reports downloads.
async function browserSocket() {
  let stderr = "";
  const ws = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("no DevTools address from Chrome")), 30000);
    proc.stderr.on("data", (d) => {
      stderr += d;
      const m = /ws:\/\/\S+/.exec(stderr);
      if (m) { clearTimeout(t); res(m[0]); }
    });
  });
  const sock = new WebSocket(ws);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = () => rej(new Error("browser socket error")); });
  let id = 0;
  const pend = new Map();
  const listeners = [];
  sock.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) {
      const p = pend.get(d.id);
      pend.delete(d.id);
      if (d.error) p.rej(new Error(p.method + ": " + JSON.stringify(d.error))); else p.res(d.result);
    } else if (d.method) listeners.forEach((f) => f(d.method, d.params));
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pend.set(i, { res, rej, method });
    sock.send(JSON.stringify({ id: i, method, params }));
  });
  return { send, on: (f) => listeners.push(f), close: () => sock.close() };
}

async function main() {
  const b = await browserSocket();
  const c = await connect();
  await c.load(url + "/auth/login?next=/", `location.pathname === "/" && document.readyState === "complete"`, "signed in to the hub");
  await b.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
  let guid = "";
  let last = { receivedBytes: 0, totalBytes: 0, state: "" };
  let interrupted = false;
  const done = new Promise((res, rej) => {
    b.on((method, p) => {
      if (method === "Browser.downloadWillBegin") {
        guid = p.guid;
        console.log("download began: " + p.suggestedFilename);
      }
      if (method !== "Browser.downloadProgress" || p.guid !== guid) return;
      if (p.receivedBytes < last.receivedBytes) console.log("received went back to " + p.receivedBytes);
      if (p.state === "completed") res(p);
      else if (p.state === "canceled") {
        interrupted = true;
        console.log("download stopped at " + p.receivedBytes + " bytes");
      }
      last = p;
    });
  });
  await c.send("Page.navigate", { url: fileURL }).catch(() => {});
  // A download Chrome gave up on is resumed from chrome://downloads.
  const deadline = Date.now() + 180000;
  let resumes = 0;
  for (;;) {
    const r = await Promise.race([done, new Promise((res) => setTimeout(() => res(null), 500))]);
    if (r) {
      console.log(JSON.stringify({ file: guid, bytes: r.receivedBytes }));
      break;
    }
    if (Date.now() > deadline) throw new Error("the download did not finish: " + JSON.stringify(last));
    if (interrupted && resumes < 3) {
      interrupted = false;
      resumes++;
      console.log("pressing Resume on chrome://downloads");
      await c.send("Page.navigate", { url: "chrome://downloads" });
      await c.until(`(() => { const m = document.querySelector("downloads-manager"); const l = m && m.shadowRoot.querySelector("downloads-item"); const b = l && [...l.shadowRoot.querySelectorAll("cr-button")].find((x) => /resume/i.test(x.textContent)); if (b) { b.click(); return true; } return false; })()`, "the Resume button");
    }
  }
  b.close();
  c.close();
}

main().then(() => process.exit(0), (e) => {
  console.error(e && e.stack || String(e));
  try { proc.kill(); } catch (_) { /* gone */ }
  process.exit(1);
});
