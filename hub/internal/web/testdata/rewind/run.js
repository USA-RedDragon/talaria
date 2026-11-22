"use strict";
// Drives the real hub page in headless Chrome (a Pixel-sized phone, touch) or
// headless Firefox (WebDriver BiDi, a desktop window) on "Rewind to here".
// usage: node run.js BROWSER_BIN HUB_URL PROFILE_DIR
// Chat s1 has three user messages, a running subagent, a running command and a
// to-do list. Rewinding to the second message asks first (title, what stays,
// the model), hides it and what follows, shows a line with a Show button where
// they were, puts the message in the box and leaves the subagent and the command
// alone. Show lists the hidden messages read only, and the line comes back after
// a reload. Chat s2 has a message waiting, so the hub refuses its rewind.
// With REWIND_SHOTS set to a folder (Chrome only) it saves screenshots there.
const assert = require("assert");
const fs = require("fs");
const [bin, url, dir] = process.argv.slice(2);
const firefox = /firefox/.test(bin);
const shots = process.env.REWIND_SHOTS || "";

const open = firefox ? require("../bidi.js").launch(bin, dir) : require("../cdp.js").launch(bin, dir);
const { connect } = open;

(async () => {
  const c = await connect();
  const { ev } = c;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    for (;;) {
      last = await ev(`(() => { try { return ${expr}; } catch (e) { return false; } })()`);
      if (last) return last;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last ${JSON.stringify(last)}; log ${await ev(`(document.getElementById("log") || {}).innerText`)}`);
      await sleep(40);
    }
  };
  if (firefox) {
    await c.send("browsingContext.setViewport", { context: c.context, viewport: { width: 1280, height: 900 } });
  } else {
    await c.send("Page.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
    await c.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  }
  const goto = async (u, ready) => {
    if (firefox) { await c.goto(u); await until(ready, "the page"); } else await c.load(u, ready, "the page");
  };
  const ready = `!document.getElementById("composer").hidden && !document.getElementById("log").hidden`;
  const open_ = async (id) => {
    await ev(`(location.hash = "#/s/pc/${id}", 1)`);
    await until(`location.hash === "#/s/pc/${id}" && ${ready}`, "chat " + id);
  };
  const users = () => ev(`Array.from(document.querySelectorAll("#log .msg.user")).map((n) => n.rawText || n.innerText)`);
  const bubbleCount = () => ev(`document.querySelectorAll("#log .msg.user, #log .msg.assistant").length`);
  const rewindButtons = () => ev(`Array.from(document.querySelectorAll("#log > .acts")).map((a) => ({ user: a.owner.classList.contains("user"), rewind: !!Array.from(a.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === "Rewind to here") }))`);
  const clickRewind = (i) => ev(`(() => { const u = Array.from(document.querySelectorAll("#log .msg.user"))[${i}]; const a = Array.from(document.querySelectorAll("#log > .acts")).find((x) => x.owner === u); a.querySelector('button[aria-label="Rewind to here"]').click(); return true; })()`);
  const dlg = () => ev(`(() => { const d = document.querySelector("dialog.rewind"); if (!d || !d.open) return null; return { title: d.querySelector("h2").textContent, text: d.querySelector(".pbody").innerText, models: Array.from(d.querySelectorAll("select option")).map((o) => o.textContent), err: d.querySelector(".err").textContent }; })()`);
  const press = (label) => ev(`(() => { const b = Array.from(document.querySelectorAll("dialog.rewind button")).find((x) => x.textContent === ${JSON.stringify(label)}); b.click(); return true; })()`);
  const shot = async (name) => {
    if (!shots || firefox) return;
    for (const [w, h] of [[412, 915], [1280, 900]]) {
      for (const scheme of ["light", "dark"]) {
        await c.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 2 : 1, mobile: w < 500 });
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await until(`innerWidth === ${w}`, "the width");
        await sleep(400);
        const r = await c.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(`${shots}/${name}-${w}-${scheme}.png`, Buffer.from(r.data, "base64"));
      }
    }
    await c.send("Emulation.setEmulatedMedia", { features: [] });
    await c.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  };
  const showActs = (i) => ev(`(() => { const u = Array.from(document.querySelectorAll("#log .msg.user"))[${i}]; const a = Array.from(document.querySelectorAll("#log > .acts")).find((x) => x.owner === u); a.classList.add("show"); u.scrollIntoView({ block: "center" }); return true; })()`);

  await goto(url + "/auth/login?next=/", `document.getElementById("sessions") && document.getElementById("sessions").children.length > 0`);
  await open_("s1");
  await until(`document.querySelectorAll("#log .msg.user").length === 3 && document.querySelectorAll("#log > .acts").length >= 6`, "the three messages with their actions");
  const panel = () => ev(`!document.getElementById("app").classList.contains("act-closed")`);
  const wasOpen = await panel();
  if (!wasOpen) await ev(`document.getElementById("actbtn").click()`);
  await until(`document.querySelector('#actbody .row[data-act="sa-light"]') && document.querySelector('#actbody .row[data-act="proc_sleep"]')`, "the subagent and the command");
  if (!wasOpen) await ev(`document.getElementById("actclose").click()`);

  // Every message of the user has Rewind to here; a reply has not.
  const acts = await rewindButtons();
  assert.strictEqual(acts.filter((a) => a.user).length, 3);
  assert.ok(acts.filter((a) => a.user).every((a) => a.rewind), "each message of the user has Rewind to here");
  assert.ok(acts.filter((a) => !a.user).every((a) => !a.rewind), "a reply has none");
  await showActs(1);
  await shot("action");

  // The question names the message, the rows that go and what stays.
  await clickRewind(1);
  await until(`document.querySelector("dialog.rewind[open]")`, "the question");
  const q = await dlg();
  assert.strictEqual(q.title, "Rewind to “Now also check the shadow cascades”?");
  assert.match(q.text, /This message and the 3 messages after it leave what the model sees\. They are hidden, not deleted\./);
  assert.match(q.text, /Stays: 1 running subagent \(their results still arrive here\), 1 background command and the todo list \(\d+ open of \d+\)\./);
  assert.match(q.text, /Your message goes back in the box to edit before sending\./);
  assert.ok(!/undefined|NaN|null/.test(q.text), "no placeholder: " + q.text);
  assert.strictEqual(q.models[0], "opus-5.5 (unchanged)");
  await shot("confirm");

  // Cancel changes nothing.
  await press("Cancel");
  await until(`!document.querySelector("dialog.rewind")`, "the question to close");
  assert.strictEqual(await bubbleCount(), 6);
  assert.strictEqual(await ev(`document.getElementById("input").value`), "");

  // Rewind: the message goes, a line stays, the box has the text.
  await clickRewind(1);
  await until(`document.querySelector("dialog.rewind[open]")`, "the question again");
  await press("Rewind");
  await until(`!document.querySelector("dialog.rewind") && document.querySelectorAll("#log .msg.user, #log .msg.assistant").length === 2`, "the chat to be rewound");
  assert.deepStrictEqual(await users(), ["Port the light-culling pass to the new compute queue"]);
  assert.strictEqual(await ev(`document.getElementById("input").value`), "Now also check the shadow cascades");
  assert.strictEqual(await ev(`location.hash`), "#/s/pc/s1", "the same chat stays open");
  await until(`document.querySelector("#log .rewound")`, "the line where they were");
  const line = await ev(`document.querySelector("#log .rewound .rewound-line").innerText`);
  assert.match(line, /^4 messages rewound at \d{1,2}:\d\d [AP]M \S+ · Show$/);
  const where = await ev(`(() => { const d = document.querySelector("#log .rewound"); const m = Array.from(document.querySelectorAll("#log .msg")); return m.length === 2 && !!(m[1].compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); })()`);
  assert.ok(where, "the line is after the last message that stayed: " + await ev(`Array.from(document.getElementById("log").children).map((n) => n.className + (n.dataset.row ? "#" + n.dataset.row : "")).join(" | ")`));
  // The subagent and the command are still there and still run.
  assert.match(await ev(`document.querySelector('#actbody .row[data-act="sa-light"]').innerText`), /profile the light pass/);
  assert.strictEqual(await ev(`document.getElementById("actcount").textContent`), "2");
  await shot("after");

  // Show lists the hidden messages, read only.
  await ev(`document.querySelector("#log .rewound button.link").click()`);
  await until(`document.querySelectorAll("#log .rewound-list .hmsg").length === 4`, "the hidden messages");
  const hidden = await ev(`Array.from(document.querySelectorAll("#log .rewound-list .hmsg")).map((n) => n.innerText)`);
  assert.deepStrictEqual(hidden, ["Now also check the shadow cascades", "The cascades split correctly.", "Add a test for the cascade split", "Added the test."]);
  assert.strictEqual(await ev(`document.querySelectorAll("#log .rewound-list button, #log .rewound-list textarea, #log .rewound-list input").length`), 0, "read only");
  assert.strictEqual(await ev(`document.querySelector("#log .rewound button.link").textContent`), "Hide");
  assert.strictEqual(await bubbleCount(), 2, "the hidden messages are not chat messages");
  await ev(`document.querySelector("#log .rewound").scrollIntoView({ block: "start" })`);
  await shot("show");

  // The line comes back after a reload, with its time.
  await goto(url + "/?again=1#/s/pc/s1", `!document.getElementById("composer").hidden && !document.getElementById("log").hidden && document.querySelector("#log .msg")`);
  await until(`document.querySelector("#log .rewound")`, "the line after a reload");
  assert.match(await ev(`document.querySelector("#log .rewound .rewound-line").innerText`), /^4 messages rewound at \d{1,2}:\d\d [AP]M \S+ · Show$/);
  assert.strictEqual(await bubbleCount(), 2);

  // The hub refuses while the chat has a message waiting; nothing changes.
  await open_("s2");
  await until(`document.querySelectorAll("#log .msg.user").length >= 2 && document.querySelectorAll("#log > .acts").length >= 2`, "the messages of s2");
  await clickRewind(0);
  await until(`document.querySelector("dialog.rewind[open]")`, "the question for s2");
  await press("Rewind");
  await until(`document.querySelector("dialog.rewind .err").textContent`, "the refusal");
  assert.match((await dlg()).err, /Could not rewind: .*still working/);
  assert.strictEqual(await ev(`document.getElementById("input").value`), "");
  assert.strictEqual(await ev(`document.querySelectorAll("#log .rewound").length`), 0);
  await press("Cancel");
  console.log("ok");
  c.close();
})().catch((e) => { console.error(e); process.exit(1); });
