"use strict";
// Cards of the web: search and read pages.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, host, verb, errorText, upperFirst } = H.util;

  const pageCap = 3000;
  const defaultLimit = 15000;

  // chars writes a text length: 812, 18k.
  const chars = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n)) + " characters";

  // searchList reads the results of a search, in the shape of Hermes's
  // search ({ data: { web } }), of a plain list, or of Claude's own search
  // (a web_search_tool_result with content).
  function searchList(res) {
    if (isObj(res.data) && Array.isArray(res.data.web)) return { list: res.data.web, native: false };
    if (Array.isArray(res.results)) return { list: res.results, native: false };
    if (Array.isArray(res.web)) return { list: res.web, native: false };
    if (res.type === "web_search_tool_result" && Array.isArray(res.content)) return { list: res.content, native: true };
    return { list: null, native: false };
  }

  const searchErrors = {
    too_many_requests: "Too many searches, try again shortly",
    max_uses_exceeded: "Too many searches in this reply",
    unavailable: "Search is not available right now",
  };

  function searchError(c, res) {
    if (isObj(res.content) && typeof res.content.error_code === "string") return searchErrors[res.content.error_code] || upperFirst(res.content.error_code.replace(/_/g, " "));
    return errorText(res) || str(c.error) || first(c.out);
  }

  function search(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const q = short(str(a.query));
    const quoted = q ? " \u201c" + q + "\u201d" : "";
    const found = searchList(res);
    const out = { icon: "globe", blocks: [], chips: found.native || res.provider === "claude" ? ["by Claude"] : [], keepRunStatus: true, ownFailure: true };
    const nativeFail = isObj(res.content) && typeof res.content.error_code === "string";
    if (!c.done) {
      out.title = "Searching the web for" + (quoted || " a query");
      out.status = "Searching...";
      return out;
    }
    if (c.failed || nativeFail) {
      out.title = "Could not search the web for" + (quoted || " a query");
      out.status = cut(squash(searchError(c, res)), 80) || "The search did not work";
      out.bad = true;
      // An error that is not plain text is only in the result.
      if (isObj(res.error)) out.raw = H.util.rawOf(c);
      return out;
    }
    out.title = "Searched the web for" + (quoted || " a query");
    const rows = (found.list || []).filter((r) => isObj(r) && str(r.url));
    if (!found.list) {
      out.status = "Done";
      out.raw = H.util.rawOf(c);
      return out;
    }
    if (!rows.length) {
      out.status = "No results";
      out.tone = "warn";
      return out;
    }
    out.status = plural(rows.length, "result");
    out.tone = "ok";
    const hosts = [];
    for (const r of rows) {
      const h = host(str(r.url));
      if (h && !hosts.includes(h)) hosts.push(h);
    }
    out.lines = [hosts.slice(0, 3).join(", ") + (rows.length > hosts.slice(0, 3).length ? " +" + (rows.length - hosts.slice(0, 3).length) + " more" : "")];
    const top = squash(str(rows[0].title));
    if (top) out.lines.push({ parts: "Top: " + top, dim: true });
    out.blocks.push({
      label: "Results",
      text: rows.map((r) => [squash(str(r.title)) || str(r.url), str(r.url), squash(str(r.description) || str(r.page_age))].filter(Boolean).join("\n")).join("\n\n"),
    });
    return out;
  }

  // pageNote says what a result of web_extract tells about one page.
  function pages(res, urls) {
    const list = Array.isArray(res.results) ? res.results.filter(isObj) : [];
    return list.map((r, i) => {
      const content = str(r.content);
      return {
        url: str(r.url) || urls[i] || "",
        title: squash(str(r.title)),
        content,
        error: squash(str(r.error)),
        // Hermes ends a long page with a note that the whole text was saved.
        cutDown: /full text (is )?(stored|saved)/i.test(content),
      };
    });
  }

  function extract(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const urls = Array.isArray(a.urls) ? a.urls.map(str).filter(Boolean) : a.url ? [str(a.url)] : [];
    const list = pages(res, urls);
    const n = list.length || urls.length || 1;
    const hosts = (list.length ? list.map((p) => p.url) : urls).map(host).filter(Boolean);
    const out = { icon: "globe", blocks: [], chips: [], keepRunStatus: true, ownFailure: true };
    const nameOf = (u) => u.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "").replace(/\/$/, "");
    if (n > 1) {
      out.title = verb(c, "Read ", "Reading ") + n + " web pages";
      if (hosts[0]) out.chips = [hosts[0]];
    } else {
      const p = list[0];
      out.title = verb(c, "Read ", "Reading ") + ((p && !p.error && p.title) || short(nameOf(urls[0] || (p && p.url) || "")) || "a web page");
    }
    if (!c.done) {
      out.status = hosts.length ? "Fetching " + hosts.join(", ") : "Fetching";
      return out;
    }
    if (c.failed && !list.length) {
      out.status = "Failed";
      out.tone = "bad";
      out.more = [cut(squash(errorText(res) || str(c.error) || first(c.out)), 80) || "the call did not work"];
      out.bad = true;
      if (!c.res) out.raw = H.util.rawOf(c);
      return out;
    }
    if (!list.length) {
      out.status = "Done";
      out.raw = H.util.rawOf(c);
      return out;
    }
    const bad = list.filter((p) => p.error);
    const good = list.length - bad.length;
    const total = list.reduce((s, p) => s + (p.error ? 0 : p.content.length), 0);
    if (n === 1 && bad.length) {
      out.status = "Failed";
      out.tone = "bad";
      out.more = [cut(bad[0].error, 80)];
      out.bad = true;
    } else if (bad.length) {
      out.more = [{ tone: "ok", text: good + " read" }, ", ", { tone: "bad", text: bad.length + " failed" }].concat(total ? [" \u00b7 " + chars(total)] : []);
      out.status = "";
    } else {
      out.status = n > 1 ? n + " read" : total ? "Done" : "No text";
      out.tone = total || n > 1 ? "ok" : "warn";
      if (total) out.more = [chars(total)];
    }
    const titles = list.filter((p) => !p.error && p.title).map((p) => p.title);
    if (n > 1 && titles.length) out.lines = [{ parts: titles.join(", "), dim: true }];
    const limit = typeof a.char_limit === "number" ? a.char_limit : defaultLimit;
    const note = (p) => (p.error
      ? { parts: [{ tone: "bad", text: "Failed: " + cut(p.error, 120) }] }
      : !p.content.trim()
        ? { parts: "no text", dim: true }
        : { parts: chars(p.content.length) + (p.cutDown ? ", cut to " + limit.toLocaleString("en-US") + " (full text saved)" : ""), dim: true });
    for (const p of list) {
      out.blocks.push({ label: n > 1 || bad.length ? p.title || nameOf(p.url) : "", kind: "list", items: [p.url, note(p)] });
      if (!p.error && p.content.trim()) out.blocks.push({ text: cut(p.content.trim(), pageCap) });
    }
    return out;
  }

  H.register({ web_search: search, web_extract: extract });
})();
