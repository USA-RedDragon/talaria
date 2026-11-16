"use strict";
// Cards of other tools: MCP servers, deferred tools, media, unknown tools.
// Each renderer turns a call into the card model described at the top of
// toolcard.js and is registered with HubToolCard.register.
(() => {
  const H = window.HubToolCard;
  const { isObj, str, cut, squash, short, first, plural, base, verb, errorText, rawOf, size, upperFirst } = H.util;

  // pairs writes a call's arguments as "key: value" pairs for a line.
  function pairs(args) {
    if (!isObj(args)) return "";
    const out = [];
    for (const [k, v] of Object.entries(args)) {
      let s;
      if (typeof v === "string") s = v.length > 40 ? v.length + " characters" : v;
      else if (typeof v === "number" || typeof v === "boolean") s = String(v);
      else if (Array.isArray(v)) s = plural(v.length, "item");
      else if (isObj(v)) s = "{" + Object.keys(v).length + " fields}";
      else continue;
      out.push(k + ": " + squash(s));
    }
    return out.join(", ");
  }

  // argRows are the arguments as rows of a key and value block.
  function argRows(args) {
    if (!isObj(args)) return [];
    return Object.entries(args).map(([k, v]) => ({ k, mono: true, v: [typeof v === "string" ? v : JSON.stringify(v)] }));
  }

  // textNote says what an MCP result holds: text and its size, structured data.
  function kinds(res) {
    const k = [];
    const text = str(res.content);
    if (text) k.push("text");
    if (res.structured_content !== undefined && res.structured_content !== null) k.push("structured data");
    if (res.images) k.push("images");
    const bytes = text ? size(unescape(encodeURIComponent(text)).length) : "";
    return k.length ? k.join(", ") + (bytes ? ", " + bytes : "") : "no output";
  }

  const serverName = (s) => (typeof s === "string" ? s : isObj(s) ? str(s.name) : "");

  function mcpCall(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const out = { icon: "plug", blocks: [], ownFailure: true };
    // The format of what a server returns is not known, so the call and
    // result stay behind Raw.
    out.raw = rawOf(c);
    if (c.name === "mcp_device_servers") {
      out.title = verb(c, "Looked up the servers", "Looking up the servers");
      const names = (Array.isArray(res.servers) ? res.servers : []).map(serverName).filter(Boolean);
      out.status = "Done";
      if (c.done && Array.isArray(res.servers)) {
        out.more = [plural(names.length, "server")];
        if (names.length) {
          out.lines = [{ parts: names.join(", "), mono: true }];
          out.blocks.push({ kind: "list", items: names.map((n) => ({ parts: [{ code: n }] })) });
        }
      }
      return fail(c, res, out);
    }
    const server = str(a.server) || str(res.server);
    if (c.name === "mcp_device_tools") {
      const tool = str(a.tool);
      out.title = tool ? [verb(c, "Looked up ", "Looking up "), { code: (server ? server + "." : "") + tool }] : [verb(c, "Looked up the tools of", "Looking up the tools of") + (server ? " " + short(server) : " a server")];
      out.status = "Done";
      const tools = Array.isArray(res.tools) ? res.tools.filter(isObj) : null;
      if (c.done && tools) {
        const query = squash(str(a.query));
        const total = typeof res.total === "number" ? res.total : tools.length;
        const matched = typeof res.matched === "number" ? res.matched : tools.length;
        out.more = [query && matched !== total ? matched + " of " + total + " match \u201c" + query + "\u201d" : plural(total, "tool")];
        if (res.truncated) out.more.push("showing " + tools.length + " of " + matched);
        if (tools.length) out.lines = [{ parts: tools.slice(0, 3).map((t) => str(t.name)).join(", ") + (tools.length > 3 ? " +" + (tools.length - 3) : ""), mono: true }];
        out.blocks.push({
          kind: "list",
          items: tools.map((t) => ({ parts: [{ code: str(t.name) }, " " + squash(str(t.description))].concat(t.read_only ? [" ", { chip: "read-only" }] : []) })),
        });
      } else if (c.done && isObj(res.tool)) {
        out.blocks.push({ label: str(res.tool.name), text: squash(str(res.tool.description)) });
      }
      return fail(c, res, out);
    }
    const name = (server ? server + "." : "") + str(a.tool);
    out.title = [verb(c, "Called ", "Calling "), { code: name.replace(/\.$/, "") || "a tool" }];
    out.waiting = !!c.pending;
    const args = isObj(a.arguments) ? a.arguments : {};
    const line = pairs(args);
    if (line) out.lines = [{ parts: line, mono: true }];
    const content = str(res.content);
    if (c.done && !c.failed && !res.is_error) {
      out.status = "Done";
      out.more = [kinds(res)];
      const head = first(content);
      if (head) out.lines = (out.lines || []).concat([{ parts: "First line: " + head, dim: true }]);
    }
    const rows = argRows(args);
    if (rows.length) out.blocks.push({ label: "Arguments", kind: "kv", rows });
    if (content && !res.is_error) out.blocks.push({ label: "Result", text: content });
    if (res.structured_content !== undefined && res.structured_content !== null) {
      out.blocks.push({ label: "Structured data", text: typeof res.structured_content === "string" ? res.structured_content : JSON.stringify(res.structured_content, null, 2) });
    }
    return fail(c, res, out, content);
  }

  // fail gives a failed call its status: the error text of the result, or
  // what the server said (an is_error result is a call that worked).
  function fail(c, res, out, content) {
    if (!c.failed && !(isObj(res) && res.is_error === true)) return out;
    const e = errorText(res) || str(c.error) || first(content) || first(c.out);
    out.status = "Failed: " + (cut(squash(e), 80) || "the call did not work");
    out.bad = true;
    out.more = [];
    return out;
  }

  // --- tools that Hermes loads on demand -----------------------------------

  // matches reads the tools a tool_search found: a list of { name,
  // description } in a result, else lines of text like "- name: words".
  function matches(res, out) {
    const list = isObj(res) ? [res.tools, res.matches, res.results].find(Array.isArray) : Array.isArray(res) ? res : null;
    if (list) {
      return list.map((t) => (typeof t === "string" ? { name: t, description: "" } : isObj(t) ? { name: str(t.name), description: squash(str(t.description)) } : null)).filter((t) => t && t.name);
    }
    const found = [];
    for (const l of str(out).split("\n")) {
      const m = /^\s*(?:[-*\u2022]\s*)?`?([A-Za-z][\w.-]*)`?\s*(?::|\u2014|-)\s*(.*)$/.exec(l);
      if (m) found.push({ name: m[1], description: squash(m[2]) });
    }
    return found;
  }

  const codes = (names) => names.map((n, i) => (i ? [", ", { code: n }] : [{ code: n }])).flat();

  function toolSearch(c) {
    const a = isObj(c.args) ? c.args : {};
    const queries = (Array.isArray(a.queries) ? a.queries : a.query ? [a.query] : []).map((q) => short(str(q))).filter(Boolean);
    const out = { icon: "search", blocks: [], keepRunStatus: true };
    out.title = [verb(c, "Searched tools for", "Searching tools for") + (queries.length ? " " : " a tool"), ...(queries.length ? [{ code: queries.join(", ") }] : [])];
    if (!c.done) {
      out.status = "Running";
      return out;
    }
    const found = matches(c.res, c.out);
    const lists = isObj(c.res) ? [c.res.tools, c.res.matches, c.res.results].filter(Array.isArray) : [];
    const n = Math.max(found.length, ...lists.map((l) => l.length));
    if (n) out.status = plural(n, "match", "matches");
    else out.status = !c.failed && (lists.length || !c.out) ? "No matches" : "Done";
    if (found.length) {
      out.tone = "ok";
      out.lines = [{ parts: codes(found.slice(0, 3).map((t) => t.name)).concat(found.length > 3 ? [" +" + (found.length - 3)] : []), dim: true }];
      out.blocks.push({ kind: "list", items: found.map((t) => ({ parts: [{ code: t.name }, t.description ? " " + t.description : ""] })) });
    }
    return out;
  }

  // schemas reads the tools tool_describe returned, when they come as
  // objects with a name and a JSON schema of their parameters.
  function schemas(res) {
    const list = Array.isArray(res) ? res : isObj(res) ? [res.tools, res.schemas, res.results].find(Array.isArray) || (res.name ? [res] : null) : null;
    return (list || []).filter(isObj).map((t) => {
      const sch = [t.parameters, t.input_schema, t.inputSchema].find(isObj) || (isObj(t.function) ? t.function.parameters : null);
      const props = isObj(sch) && isObj(sch.properties) ? sch.properties : {};
      const need = isObj(sch) && Array.isArray(sch.required) ? sch.required : [];
      return {
        name: str(t.name) || (isObj(t.function) ? str(t.function.name) : ""),
        params: Object.entries(props).map(([k, v]) => {
          const p = isObj(v) ? v : {};
          const type = Array.isArray(p.type) ? p.type.join(" or ") : str(p.type);
          return { name: k, type: type === "string" ? "text" : type === "array" ? "list" + (isObj(p.items) && p.items.type === "string" ? " of text" : "") : type === "integer" || type === "number" ? "number" : type, required: need.includes(k), description: squash(str(p.description)) };
        }),
      };
    }).filter((t) => t.name);
  }

  function toolDescribe(c) {
    const a = isObj(c.args) ? c.args : {};
    const names = (Array.isArray(a.names) ? a.names : a.name ? [a.name] : []).map((n) => short(str(n))).filter(Boolean);
    const out = { icon: "search", blocks: [] };
    out.title = [verb(c, "Loaded the details of", "Loading the details of") + (names.length ? " " : " a tool"), ...codes(names)];
    out.status = "Done";
    if (!c.done) return out;
    const tools = schemas(c.res);
    if (c.failed) return out;
    for (const t of tools) {
      out.blocks.push({ label: t.name, kind: "list", items: t.params.map((p) => ({ parts: [{ code: p.name }, " " + [p.type, p.required ? "required" : ""].filter(Boolean).join(", ") + (p.description ? ": " + p.description : "")] })) });
    }
    if (tools[0] && tools[0].params.length) {
      const ps = tools[0].params.filter((p) => p.required);
      const use = (ps.length ? ps : tools[0].params).slice(0, 4);
      out.lines = [{ parts: [{ code: tools[0].name }, " takes "].concat(codes(use.map((p) => p.name))), dim: true }];
    }
    // The format of a schema is the model's own: it stays behind Raw.
    out.raw = c.out;
    return out;
  }

  // wrapper draws a tool_call that could not be unwrapped into the cards of
  // the calls it carries.
  function wrapper(c) {
    const a = isObj(c.args) ? c.args : {};
    const list = H.wrapped(c.name, a) || [];
    const out = { icon: "tool", blocks: [] };
    const names = list.map((x) => x.name);
    out.title = [verb(c, "Ran", "Running") + (names.length ? " " : " a tool"), ...codes(names)];
    out.status = "Done";
    if (list.length) out.blocks.push({ kind: "list", items: list.map((x) => ({ parts: [{ code: x.name }, pairs(x.args) ? " " + pairs(x.args) : ""] })) });
    out.raw = rawOf(c);
    return out;
  }

  // --- speech, images and video --------------------------------------------

  // trunc cuts a prompt for a title, ending in three dots.
  const trunc = (s, n) => {
    const t = squash(s);
    if (t.length <= n) return t;
    const cutAt = t.lastIndexOf(" ", n);
    return t.slice(0, cutAt > 0 ? cutAt : n).replace(/[\s,;:.-]+$/, "") + "...";
  };

  const providers = { edge: "Edge", openai: "OpenAI", elevenlabs: "ElevenLabs", neutts: "NeuTTS", minimax: "MiniMax", xai: "xAI", fal: "FAL.ai" };
  const providerName = (p) => providers[str(p).toLowerCase()] || upperFirst(str(p));

  const ext = (p) => {
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(str(p));
    return m ? m[1].toLowerCase() : "";
  };

  // clip writes a video's settings the way a line reads them.
  function clip(a) {
    const out = [];
    if (typeof a.duration === "number" || /^\d+$/.test(str(a.duration))) out.push(a.duration + " s clip");
    if (a.resolution) out.push(str(a.resolution));
    if (a.aspect_ratio) out.push(str(a.aspect_ratio));
    return out;
  }

  // shape names an aspect ratio: 16:9 is wide, 9:16 tall, 1:1 square.
  function shape(r) {
    const m = /^(\d+):(\d+)$/.exec(str(r));
    if (!m) return str(r);
    const w = +m[1];
    const h = +m[2];
    return (w > h ? "wide " : w < h ? "tall " : "square ") + r;
  }

  // sources lists the pictures an edit started from.
  function sources(a) {
    return [a.image_url].concat(Array.isArray(a.reference_image_urls) ? a.reference_image_urls : []).map(str).filter(Boolean);
  }

  function media(c) {
    const a = isObj(c.args) ? c.args : {};
    const res = isObj(c.res) ? c.res : {};
    const isSpeech = c.name === "text_to_speech";
    const isImage = c.name === "image_generate";
    const subject = squash(str(isSpeech ? a.text : a.prompt));
    const noun = isSpeech ? "speech" : isImage ? "an image" : "a video";
    const out = { icon: isSpeech ? "pulse" : isImage ? "camera" : "play", blocks: [], ownFailure: true, keepRunStatus: !isSpeech && !c.done };
    const quoted = subject ? ": \"" + trunc(subject, 38) + "\"" : "";
    out.title = (c.failed ? "Could not make " : c.done ? "Made " : "Making ") + noun + quoted;
    const settings = isSpeech ? [] : isImage ? [] : clip(a);
    const rows = [];
    if (subject) rows.push(isSpeech ? { text: subject, label: "Text" } : { k: "Prompt", v: [subject] });
    if (c.failed) {
      out.status = "Failed";
      out.more = [cut(squash(errorText(res) || str(c.error) || first(c.out)), 80) || "the call did not work"];
      out.bad = true;
      if (settings.length) out.lines = [{ parts: settings.join(" \u00b7 "), dim: true }];
      if (isObj(res.error)) out.raw = rawOf(c);
    } else if (!c.done) {
      out.status = "Running";
      if (settings.length) out.more = [settings.join(" \u00b7 ")];
    } else {
      out.status = "Done";
      const bits = [];
      if (isSpeech) {
        const e = ext(res.file_path || (Array.isArray(res.file_paths) ? res.file_paths[0] : ""));
        if (e) bits.push(e);
      } else if (isImage) {
        if (a.aspect_ratio) bits.push(shape(a.aspect_ratio));
        if (res.success === true || res.image) bits.push("1 image");
      } else {
        bits.push(...settings);
      }
      if (bits.length) out.more = [bits.join(" \u00b7 ")];
    }
    if (isSpeech) {
      const line = [];
      if (res.provider) line.push(providerName(res.provider) + " voice");
      else if (a.voice_id) line.push("Voice " + str(a.voice_id));
      if (typeof a.speed === "number" && a.speed !== 1) line.push(a.speed + "x speed");
      const words = subject ? subject.split(" ").length : 0;
      if (words) line.push(plural(words, "word"));
      const files = Array.isArray(res.file_paths) ? res.file_paths.map(str) : res.file_path ? [str(res.file_path)] : [];
      if (!c.failed && line.length) out.lines = [{ parts: line.join(" \u00b7 "), dim: true }];
      if (!c.failed && files.length) out.lines = (out.lines || []).concat([{ parts: files.length > 1 ? plural(files.length, "file") : base(files[0]), dim: true, mono: files.length === 1 }]);
      const kv = [];
      if (res.provider) kv.push({ k: "Voice", v: [providerName(res.provider)] });
      else if (a.voice_id) kv.push({ k: "Voice", v: [str(a.voice_id)] });
      if (typeof a.speed === "number" && a.speed !== 1) kv.push({ k: "Speed", v: [a.speed + "x"] });
      if (a.instructions) kv.push({ k: "Instructions", v: [squash(str(a.instructions))] });
      files.forEach((f, i) => kv.push({ k: files.length > 1 ? "Part " + (i + 1) : "Saved to", mono: true, v: [f] }));
      if (subject) out.blocks.push({ label: "Text", text: subject, kind: "plain" });
      out.blocks.push({ kind: "kv", rows: kv });
      return out;
    }
    const kv = [];
    if (subject) kv.push({ k: "Prompt", v: [subject] });
    if (isImage && a.aspect_ratio) kv.push({ k: "Aspect ratio", v: [str(a.aspect_ratio)] });
    if (!isImage && settings.length) kv.push({ k: "Clip", v: [settings.map((s) => s.replace(/ clip$/, "")).join(", ")] });
    const src = sources(a);
    if (src.length) {
      kv.push({ k: src.length > 1 ? "Sources" : "Source", mono: true, v: [src.join(", ")] });
      if (isImage && !c.failed) out.lines = [{ parts: ["Edited from ", { code: base(src[0]) }].concat(src.length > 1 ? [" and " + (src.length - 1) + " more"] : []), dim: true }];
    }
    if (isImage && res.upscaled === true) kv.push({ k: "Upscaled", v: ["Yes"] });
    const where = str(isImage ? res.image : res.video || res.file_path);
    if (c.done && !c.failed && where && !/^https?:/i.test(where)) kv.push({ k: "Saved to", mono: true, v: [where] });
    out.blocks.push({ kind: "kv", rows: kv });
    return out;
  }

  // --- tools with no card of their own ----------------------------------------

  function generic(c) {
    const a = isObj(c.args) ? c.args : {};
    const out = { icon: "tool", blocks: [] };
    let hint = "";
    for (const v of Object.values(a)) {
      const t = typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : "";
      if (t) {
        hint = short(t);
        break;
      }
    }
    out.title = (c.name || "tool") + (hint ? ": " + cut(hint, 60) : "");
    out.status = "Done";
    // The hub does not know this tool's format: its call and result are
    // shown as they came, behind Raw.
    out.raw = rawOf(c);
    return out;
  }

  H.register({
    mcp_device_call: mcpCall, mcp_device_servers: mcpCall, mcp_device_tools: mcpCall,
    tool_search: toolSearch, tool_describe: toolDescribe, tool_call: wrapper,
    text_to_speech: media, image_generate: media, video_generate: media,
  }, { generic });
})();
