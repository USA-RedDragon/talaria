"""A stand-in model for trying Talaria without an API key.

Speaks the OpenAI chat completions API (plain and streaming) and answers every request with a short canned
reply that quotes the last user message. Two words show more of Talaria:

  run: <command>   runs the command with the terminal tool (in the sandbox, or on a paired computer)
  send: <path>     offers that file with the send_file tool (a download card in the hub)
  page:            answers with a small interactive page
  remember: <fact> saves the fact with the memory tool (Notes > About you on the Memory page)
  recall: <word>   quotes what Talaria's memory gave the model about the word, in any chat
  search: <words>  searches the web with the web_search tool (Talaria's SearXNG, or the search you set up)
  tools:           lists the tools the agent offered the model for this message

Use a real model for real work.
"""

import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "talaria-demo"


def last_user_text(messages):
    for m in reversed(messages or []):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
            return (c or "").strip()
    return ""


def tool_call_for(body):
    """'run: <command>' as the last message makes the model run that command with the terminal tool."""
    msgs = body.get("messages") or []
    if not msgs or msgs[-1].get("role") != "user":
        return None
    # Only the first paragraph: Hermes appends plugin context (such as the shell of a Windows computer)
    # after a blank line.
    text = last_user_text(msgs).split("\n\n", 1)[0]
    names = {t.get("function", {}).get("name") for t in body.get("tools") or []}
    if text.lower().startswith("run:") and "terminal" in names:
        return {"index": 0, "id": "call_demo_%d" % time.time_ns(), "type": "function",
                "function": {"name": "terminal", "arguments": json.dumps({"command": text[4:].strip()})}}
    if text.lower().startswith("send:") and ("send_file" in names or "tool_call" in names):
        args = {"path": text[5:].strip()}
        if "send_file" not in names:
            # Hermes defers plugin tools behind its tool_search bridge: call send_file through tool_call
            return {"index": 0, "id": "call_demo_%d" % time.time_ns(), "type": "function",
                    "function": {"name": "tool_call",
                                 "arguments": json.dumps({"calls": [{"name": "send_file", "arguments": args}]})}}
        return {"index": 0, "id": "call_demo_%d" % time.time_ns(), "type": "function",
                "function": {"name": "send_file", "arguments": json.dumps(args)}}
    if text.lower().startswith("search:") and "web_search" in names:
        return {"index": 0, "id": "call_demo_%d" % time.time_ns(), "type": "function",
                "function": {"name": "web_search", "arguments": json.dumps({"query": text[7:].strip()})}}
    if text.lower().startswith("remember:") and "memory" in names:
        args = {"target": "user", "operations": [{"action": "add", "content": text[9:].strip()}]}
        return {"index": 0, "id": "call_demo_%d" % time.time_ns(), "type": "function",
                "function": {"name": "memory", "arguments": json.dumps(args)}}
    return None


def send_file_result(out):
    """The send_file result in a tool message: the result itself, or the first one that the tool_call bridge
    wraps (a list of results, or an object with a results list)."""
    try:
        value = json.loads(out)
    except ValueError:
        return {}
    for _ in range(3):
        if isinstance(value, dict) and ("status" in value or "error" in value) and "results" not in value:
            return value
        if isinstance(value, dict):
            value = value.get("results") or value.get("result") or value.get("output") or {}
        elif isinstance(value, list):
            value = value[0] if value else {}
        if isinstance(value, dict) and isinstance(value.get("result"), str):
            value = value["result"]
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return {}
    return value if isinstance(value, dict) else {}


def recall(body, word):
    """Lines that mention the word in what Hermes gave the model: the system prompt (built-in memory)."""
    def text_of(m):
        c = m.get("content")
        return c if isinstance(c, str) else " ".join(p.get("text", "") for p in c or [] if isinstance(p, dict))
    msgs = body.get("messages") or []
    system = "\n".join(text_of(m) for m in msgs if m.get("role") == "system")
    found = []
    for source, text in (("memory notes", system),):
        hits = [ln.strip(" -*") for ln in text.splitlines() if word and word.lower() in ln.lower()]
        found += ["%s: %s" % (source, h[:200]) for h in hits[:3]]
    if not found:
        return "Nothing about \"%s\" in what Talaria gave me for this chat." % word
    return "From memory, about \"%s\": " % word + " | ".join(found)


PAGE = """Here is a small page. Open it and pick a color: the page sends your answer back to this chat.

```page
<!doctype html>
<title>Pick a color</title>
<style>
  body { font: 16px system-ui, sans-serif; margin: 2rem; }
  button { font: inherit; margin: .25rem; padding: .5rem 1rem; border-radius: .5rem; border: 1px solid #888; }
</style>
<h1>Pick a color</h1>
<p>This page came from the demo model. Its buttons send the answer back to the chat.</p>
<button data-hermes-send="I picked blue">Blue</button>
<button data-hermes-send="I picked green">Green</button>
<button data-hermes-send="I picked orange">Orange</button>
```
"""


def has_image(messages):
    m = (messages or [{}])[-1]
    c = m.get("content")
    return m.get("role") == "user" and isinstance(c, list) and any(
        isinstance(p, dict) and p.get("type") in ("image_url", "input_image") for p in c)


def reply_for(body):
    msgs = body.get("messages") or []
    if has_image(msgs):
        # Hermes asks the model to describe an attached image
        return "(The demo model cannot see images. With a real model, a description of the image goes here.)"
    if msgs and msgs[-1].get("role") == "user" and last_user_text(msgs).lower().startswith("page:"):
        return PAGE
    if msgs and msgs[-1].get("role") == "user" and last_user_text(msgs).lower().startswith("tools:"):
        names = sorted({t.get("function", {}).get("name") or "" for t in body.get("tools") or []} - {""})
        return "Tools I was given for this message (%d): %s" % (len(names), ", ".join(names) or "none")
    if msgs and msgs[-1].get("role") == "user" and last_user_text(msgs).lower().startswith("recall:"):
        return recall(body, last_user_text(msgs)[7:].strip().split("\n")[0].strip())
    if msgs and msgs[-1].get("role") == "tool":
        out = msgs[-1].get("content")
        if isinstance(out, list):
            out = " ".join(p.get("text", "") for p in out if isinstance(p, dict))
        out = (out or "").strip()
        calls = [c for m in msgs if m.get("role") == "assistant" for c in m.get("tool_calls") or []]
        if calls and calls[-1].get("function", {}).get("name") == "memory":
            return ("Saved to memory. Start a new chat and send recall: <a word of it> to see it come back. "
                    "The memory tool said: " + out[:300])
        last = calls[-1].get("function", {}) if calls else {}
        if last.get("name") == "send_file" or (last.get("name") == "tool_call" and '"send_file"' in (last.get("arguments") or "")):
            result = send_file_result(out)
            offer = result.get("file_offer") or {}
            if result.get("status") == "offered":
                return "Here is %s. Download it from the card." % offer.get("name", "the file")
            if result.get("status") == "refused":
                return "I did not send %s: it looks like a secret. Ask for it by name if you want it anyway." % (
                    offer.get("name", "the file"))
            return "The file could not be sent: " + str(result.get("error") or out)[:300]
        what = "The search ran" if calls and calls[-1].get("function", {}).get("name") == "web_search" else "The command ran"
        return what + ". Its result: " + (out if len(out) <= 500 else out[:500] + "...")
    text = last_user_text(msgs)
    # Hermes adds notes in brackets about attachments; name the files instead of quoting the notes
    files = re.findall(r"\[The user attached a file: (.+?)\. It is saved at", text)
    images = text.count("[The user sent an image")
    text = "\n\n".join(p for p in text.split("\n\n") if not p.lstrip().startswith("[")).strip()
    quoted = text if len(text) <= 200 else text[:200] + "..."
    out = ("This is the Talaria demo model. Talaria works: the hub reached the agent, and the agent reached this "
           "model. Connect a real model in Settings, Models to get real answers. You wrote: " + quoted)
    if files or images:
        out += " You attached %s. A real model can open %s." % (
            ", ".join(files) if files else "%d image%s" % (images, "s" if images > 1 else ""),
            "them" if len(files) + images > 1 else "it")
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/health"):
            return self._json(200, {"ok": True})
        if self.path.rstrip("/") == "/v1/models":
            return self._json(200, {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "talaria", "context_length": 131072}]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            return self._json(404, {"error": {"message": "not found"}})
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        call = tool_call_for(body)
        text = "" if call else reply_for(body)
        msgs = body.get("messages") or [{}]
        print("demo-llm: %d messages, last %s, %d tools, %s" % (
            len(msgs), msgs[-1].get("role"), len(body.get("tools") or []),
            "tool call" if call else "text reply"), flush=True)
        cid, now = "chatcmpl-demo-%d" % time.time_ns(), int(time.time())
        usage = {"prompt_tokens": 10, "completion_tokens": len(text.split()), "total_tokens": 10 + len(text.split())}
        if call and not body.get("stream"):
            return self._json(200, {"id": cid, "object": "chat.completion", "created": now, "model": MODEL,
                                    "choices": [{"index": 0, "finish_reason": "tool_calls",
                                                 "message": {"role": "assistant", "content": None,
                                                             "tool_calls": [{k: v for k, v in call.items()
                                                                             if k != "index"}]}}],
                                    "usage": usage})
        if not body.get("stream"):
            return self._json(200, {"id": cid, "object": "chat.completion", "created": now, "model": MODEL,
                                    "choices": [{"index": 0, "finish_reason": "stop",
                                                 "message": {"role": "assistant", "content": text}}],
                                    "usage": usage})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def send(delta, finish=None, extra=None):
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": now, "model": MODEL,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if extra:
                chunk.update(extra)
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\n\n")
            self.wfile.flush()

        send({"role": "assistant", "content": ""})
        if call:
            send({"tool_calls": [call]})
            send({}, "tool_calls", {"usage": usage})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        for i, word in enumerate(text.split(" ")):
            send({"content": word if i == 0 else " " + word})
            time.sleep(0.02)
        send({}, "stop", {"usage": usage})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
