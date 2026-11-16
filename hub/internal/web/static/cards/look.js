"use strict";
// Cards of looking: screenshots, images and the page, scripts in a page.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  // vision is vision_analyze and browser_vision: the card shows the image the
  // call looked at (d.vision) with the question as a plain line. A path the
  // hub may serve is a thumbnail, a data: URL is shown as it is, a web link
  // is a link and never loaded, and the rest is a placeholder. The generic
  // "Image loaded into your context" output is dropped; any other stays.
  const dataImage = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

  const imageExt = /\.(png|jpe?g|gif|webp)$/i;

  function imageFile(p) {
    return p.length > 1 && p.length < 4096 && p[0] === "/" && !/[\x00-\x1f\x7f]/.test(p) && imageExt.test(p) &&
      !p.slice(1).split("/").some((x) => x === "" || x === "." || x === "..");
  }

  function visionSource(a, res) {
    let u = str(a.image_url).trim();
    if (!u && Array.isArray(res.content)) {
      for (const part of res.content) {
        const v = isObj(part) ? (isObj(part.image_url) ? part.image_url.url : part.image_url) : "";
        if (typeof v === "string" && dataImage.test(v)) {
          u = v;
          break;
        }
      }
    }
    if (dataImage.test(u)) return { kind: "data", url: u };
    if (/^https?:\/\//i.test(u)) return { kind: "link", url: u };
    if (imageFile(u)) return { kind: "file", path: u };
    // browser_vision keeps the screenshot it looked at and names it in its result
    if (!u && typeof res.path === "string" && imageFile(res.path)) return { kind: "file", path: res.path };
    return { kind: "none", path: u[0] === "/" ? u : "" };
  }

  function vision(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const page = c.name === "browser_vision";
    const out = { icon: "eye", blocks: [], status: "Done" };
    out.title = page ? verb(c, "Looked at", "Looking at") + " the page" : verb(c, "Looked at", "Looking at") + " an image";
    const q = str(a.question).trim();
    // The answer is what the model said about the image right after the
    // call (toolcard.js answers()); the question and image show with it.
    out.vision = Object.assign(visionSource(a, res), { question: q, answer: str(c.answer).trim() });
    const text = c.out || "";
    if (text && !/^Image loaded into your context/.test(text) && !text.includes("data:image/")) out.blocks.push({ label: "Output", text, pre: true });
    return out;
  }


  H.register({ vision_analyze: vision, browser_vision: vision });
})();
