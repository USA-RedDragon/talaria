"use strict";
// Cards of the web: search and read pages.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, last, plural, base, dir, lines, stripAnsi, host, verb, failure, errorText, exitCode, span, upperFirst, who, keyName, toolLabel, json, rawOf, num, size, plain } = H.util;

  function web(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "globe", blocks: [] };
    if (c.name === "web_search") {
      out.title = verb(c, "Searched", "Searching") + " the web for " + (short(str(a.query)) || "a query");
      const list = isObj(res.data) && Array.isArray(res.data.web) ? res.data.web : Array.isArray(res.results) ? res.results : Array.isArray(res.web) ? res.web : null;
      out.status = list ? plural(list.length, "result") : "Done";
      // Each result's title and link, the way the search card reads: Hermes's search and Claude's own one
      // (server-side, talaria-hermes 0125) give the same result shape.
      const found = (list || []).filter((r) => isObj(r) && str(r.url));
      if (found.length) {
        out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
        out.blocks.push({ label: "Results", text: found.map((r) => (str(r.title) || str(r.url)) + "\n" + str(r.url)).join("\n\n") });
        return out;
      }
    } else {
      const urls = Array.isArray(a.urls) ? a.urls.map(str).filter(Boolean) : a.url ? [str(a.url)] : [];
      const h = urls.length ? host(urls[0]) : "a page";
      out.title = verb(c, "Read", "Reading") + " " + h + (urls.length > 1 ? " and " + (urls.length - 1) + " more" : "");
      const list = Array.isArray(res.results) ? res.results : null;
      out.status = plural(list ? list.length : urls.length || 1, "page");
    }
    out.blocks.push({ label: "Call", text: JSON.stringify(a, null, 2), pre: true });
    if (c.out) out.blocks.push({ label: "Output", text: c.out, pre: true });
    return out;
  }


  H.register({ web_search: web, web_extract: web });
})();
