"""Files of a project memory beside its index: topics and path notes.

``topics/<name>.md`` holds the detail behind the index, read on demand: front matter (``name``, ``description``,
``modified``) and free markdown, with no count or size cap besides MAX_DOC_CHARS (a sanity bound per file).
``paths/<name>.md`` is a path note: the same front matter plus ``paths``, a list of glob patterns relative to the
repository root; the plugin hands it to the agent the first time in a session that a file tool touches a match.

This module only reads and writes files under one project directory; core.py has the locking, the index, the
tool and the routes.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional

TOPICS_DIR = "topics"
PATHS_DIR = "paths"
INBOX = "inbox"
NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
MAX_DOC_CHARS = 1_000_000
READ_PAGE = 150_000
MAX_DESCRIPTION = 200
MAX_PATTERNS = 20
MAX_PATTERN = 200
INDEX_LINE_MAX = 200
POINTER_RE = re.compile(r"->\s*topic:\s*([a-z0-9][a-z0-9-]{0,63})")
_STOP = frozenset("""a an and are as at be but by for from has have in into is it its of on or that the this to
was were will with when where which who use uses used not no do does only also than then there these those they
we you our your can may must should all any each every one two new old""".split())


class Bad(ValueError):
    """A refused file change; the message is for the agent or the user."""


def valid_name(name: Any) -> bool:
    return isinstance(name, str) and bool(NAME_RE.fullmatch(name))


def clean_name(name: Any) -> str:
    """A name as given, lowercased and with spaces as dashes; Bad when it is still not a valid name."""
    if not isinstance(name, str):
        raise Bad("the name must be a string")
    out = re.sub(r"[\s_]+", "-", name.strip().lower())
    if not valid_name(out):
        raise Bad(f"{name!r} is not a valid name: use 1 to 64 lowercase letters, digits and dashes, starting "
                  "with a letter or digit")
    return out


def today() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


# --- front matter -------------------------------------------------------------------------------------

def parse(text: str) -> tuple[dict, str]:
    """``(front matter, body)`` of a topic or path note. A file without front matter is all body."""
    text = text.replace("\r\n", "\n")
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---\n", 4)
    if end < 0:
        if text.endswith("\n---"):
            end = len(text) - 4
        else:
            return {}, text
    block, body = text[4:end], text[end + 5:]
    meta: dict = {}
    try:
        import yaml
        doc = yaml.safe_load(block)
        if isinstance(doc, dict):
            meta = doc
    except Exception:
        for line in block.split("\n"):
            key, sep, value = line.partition(":")
            if sep and not line[:1].isspace():
                value = value.strip()
                try:
                    meta[key.strip()] = json.loads(value)
                except ValueError:
                    meta[key.strip()] = value.strip("\"'")
    return meta, body.lstrip("\n")


def render(meta: dict, body: str) -> str:
    """A file with front matter; values are JSON scalars or lists, which YAML reads as written."""
    lines = ["---"]
    for key in ("name", "description", "paths", "modified"):
        if key in meta and meta[key] not in (None, ""):
            value = meta[key]
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False) if not isinstance(value, str) or _needs_quote(value) else value}")
    lines.append("---")
    return "\n".join(lines) + "\n\n" + body.strip("\n") + "\n"


def _needs_quote(value: str) -> bool:
    return (not value or value != value.strip() or value[0] in "!&*[]{}|>'\"%@`#,?:-" or ": " in value
            or " #" in value or "\n" in value or value.lower() in {"true", "false", "null", "yes", "no", "on", "off"}
            or bool(re.fullmatch(r"[-+0-9.eE:]+", value)))


# --- files ----------------------------------------------------------------------------------------------

_LOCK = threading.RLock()


def _dir(proj: Path, kind: str) -> Path:
    return proj / (TOPICS_DIR if kind == "topic" else PATHS_DIR)


def doc_path(proj: Path, kind: str, name: str) -> Path:
    return _dir(proj, kind) / f"{name}.md"


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def read_doc(proj: Path, kind: str, name: str) -> Optional[dict]:
    """``{name, description, modified, paths, body, size}`` of one topic or path note, or None."""
    if not valid_name(name):
        return None
    path = doc_path(proj, kind, name)
    if path.is_symlink():
        return None
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    meta, body = parse(text)
    desc = meta.get("description")
    mod = meta.get("modified")
    doc = {"name": name, "description": " ".join(desc.split())[:MAX_DESCRIPTION] if isinstance(desc, str) else "",
           "modified": str(mod) if mod else "", "body": body, "size": len(body)}
    if kind == "path":
        doc["paths"] = patterns(meta.get("paths"))
    return doc


def list_docs(proj: Path, kind: str) -> list[dict]:
    """Every topic or path note without its body, by name."""
    try:
        files = sorted(p for p in _dir(proj, kind).glob("*.md") if p.is_file() and not p.is_symlink())
    except OSError:
        return []
    out = []
    for f in files:
        doc = read_doc(proj, kind, f.stem)
        if doc is not None:
            doc.pop("body")
            out.append(doc)
    return out


def names(proj: Path, kind: str) -> list[str]:
    try:
        return sorted(p.stem for p in _dir(proj, kind).glob("*.md") if valid_name(p.stem) and not p.is_symlink())
    except OSError:
        return []


def _check_body(body: Any) -> str:
    if not isinstance(body, str):
        raise Bad("the text must be a string")
    if len(body) > MAX_DOC_CHARS:
        raise Bad(f"the text is {len(body):,} characters; one file holds at most {MAX_DOC_CHARS:,}. Split it into "
                  "several topics.")
    return body


def _description(value: Any, fallback: str = "") -> str:
    if value is None:
        return fallback
    if not isinstance(value, str):
        raise Bad("the description must be a string")
    return " ".join(value.split())[:MAX_DESCRIPTION]


def write_doc(proj: Path, kind: str, name: str, body: str, *, description: Any = None,
              paths: Any = None) -> dict:
    """Create or overwrite a topic or path note; keeps the old description when none is given."""
    name = clean_name(name)
    body = _check_body(body)
    if not body.strip():
        raise Bad("the text must not be empty; remove the file instead")
    with _LOCK:
        old = read_doc(proj, kind, name)
        meta = {"name": name, "description": _description(description, (old or {}).get("description", "")),
                "modified": today()}
        if kind == "path":
            pats = patterns(paths) if paths is not None else (old or {}).get("paths") or []
            if not pats:
                raise Bad("a path note needs paths: one or more glob patterns relative to the repository root, "
                          "such as src/ppu/** or *.sql")
            meta["paths"] = pats
        elif not meta["description"]:
            meta["description"] = summary(body, 120)
        _write(doc_path(proj, kind, name), render(meta, body))
    return {"name": name, "created": old is None, "size": len(body.strip("\n"))}


def append_doc(proj: Path, name: str, text: str, *, description: Any = None, heading: str = "") -> dict:
    """Append a paragraph to a topic, creating it when missing."""
    name = clean_name(name)
    text = _check_body(text).strip()
    if not text:
        raise Bad("the text must not be empty")
    with _LOCK:
        old = read_doc(proj, "topic", name)
        body = (old or {}).get("body", "").rstrip("\n")
        part = (f"## {heading}\n\n" if heading else "") + text
        new = (body + "\n\n" + part) if body else part
        if len(new) > MAX_DOC_CHARS:
            raise Bad(f"topic {name} would pass {MAX_DOC_CHARS:,} characters; start a new topic")
        desc = _description(description, (old or {}).get("description", "")) or summary(text, 120)
        _write(doc_path(proj, "topic", name), render({"name": name, "description": desc, "modified": today()}, new))
    return {"name": name, "created": old is None, "size": len(new)}


def patch_doc(proj: Path, kind: str, name: str, old_text: Any, new_text: Any) -> dict:
    """Replace one span of a topic or path note; the span must occur exactly once."""
    name = clean_name(name)
    if not isinstance(old_text, str) or not old_text:
        raise Bad("old_text is required: the exact text to replace")
    if not isinstance(new_text, str):
        raise Bad("content is required: the text that replaces old_text (may be empty)")
    with _LOCK:
        doc = read_doc(proj, kind, name)
        if doc is None:
            raise Bad(f"there is no {'topic' if kind == 'topic' else 'path note'} named {name}")
        n = doc["body"].count(old_text)
        if n != 1:
            raise Bad(f"old_text occurs {n} times in {name}; it must occur exactly once. "
                      + ("Read the file and copy the exact text." if n == 0 else "Give more of the text around it."))
        body = _check_body(doc["body"].replace(old_text, new_text, 1))
        if not body.strip():
            raise Bad("the patch would leave the file empty; remove it instead")
        meta = {"name": name, "description": doc["description"], "modified": today()}
        if kind == "path":
            meta["paths"] = doc["paths"]
        _write(doc_path(proj, kind, name), render(meta, body))
    return {"name": name, "size": len(body)}


def remove_doc(proj: Path, kind: str, name: str) -> bool:
    name = clean_name(name)
    with _LOCK:
        path = doc_path(proj, kind, name)
        if not path.is_file() or path.is_symlink():
            return False
        path.unlink()
    return True


def rename_doc(proj: Path, kind: str, name: str, new: str) -> str:
    name, new = clean_name(name), clean_name(new)
    if name == new:
        return new
    with _LOCK:
        src, dst = doc_path(proj, kind, name), doc_path(proj, kind, new)
        if not src.is_file():
            raise Bad(f"there is no file named {name}")
        if dst.exists():
            raise Bad(f"{new} already exists")
        meta, body = parse(src.read_text(encoding="utf-8", errors="replace"))
        meta["name"] = new
        _write(dst, render(meta, body))
        src.unlink()
    return new


def page(body: str, offset: Any = 0, limit: Any = READ_PAGE) -> dict:
    """One page of a long text, by characters: ``{text, offset, next_offset?, total}``."""
    offset = offset if isinstance(offset, int) and offset > 0 else 0
    limit = limit if isinstance(limit, int) and 0 < limit <= READ_PAGE else READ_PAGE
    text = body[offset:offset + limit]
    out = {"text": text, "offset": offset, "total": len(body)}
    if offset + limit < len(body):
        out["next_offset"] = offset + limit
        out["note"] = (f"Only characters {offset:,} to {offset + limit:,} of {len(body):,} are shown. Read on "
                       f"with offset={offset + limit}.")
    return out


# --- text helpers --------------------------------------------------------------------------------------

def words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9][a-z0-9_.+-]*[a-z0-9]|[a-z0-9]", text.lower())
            if w not in _STOP and len(w) > 2}


def summary(text: str, limit: int = 150) -> str:
    """The first sentence or line of a text, cut to ``limit`` characters."""
    flat = text.strip().split("\n", 1)[0].strip().lstrip("#-*> ").strip()
    m = re.search(r"(?<=[.!?;])\s", flat)
    if m and m.start() >= 20:
        flat = flat[:m.start()]
    flat = " ".join(flat.split())
    if len(flat) > limit:
        cut = flat[:limit - 3].rsplit(" ", 1)[0] if " " in flat[:limit - 3] else flat[:limit - 3]
        flat = cut.rstrip(",;:") + "..."
    return flat or "note"


def name_for(text: str, taken: set[str]) -> str:
    """A new topic name from the first significant words of a text, unique among ``taken``."""
    ws = [w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in _STOP and len(w) > 1][:4]
    base = "-".join(ws)[:48].strip("-") or "note"
    name, i = base, 2
    while name in taken or name == INBOX:
        name, i = f"{base}-{i}", i + 1
    return name


def best_topic(proj: Path, text: str) -> Optional[str]:
    """The existing topic a text most likely belongs to: at least two shared words with its name and
    description, or its whole name in the text. None when nothing fits well."""
    want = words(text)
    best, score = None, 0
    for doc in list_docs(proj, "topic"):
        if doc["name"] == INBOX:
            continue
        have = words(doc["name"].replace("-", " ") + " " + doc["description"])
        s = len(want & have) + (2 if doc["name"].replace("-", " ") in text.lower() else 0)
        if s > score:
            best, score = doc["name"], s
    return best if score >= 2 else None


def pointer(line: str, name: str) -> str:
    return f"{line} -> topic: {name}"


def pointed(entries: list[str]) -> set[str]:
    return {m.group(1) for e in entries for m in POINTER_RE.finditer(e)}


def inbox_count(proj: Path) -> int:
    doc = read_doc(proj, "topic", INBOX)
    return sum(1 for line in doc["body"].split("\n") if line.startswith("## ")) if doc else 0


# --- path patterns -----------------------------------------------------------------------------------

def patterns(value: Any) -> list[str]:
    """Clean glob patterns from a list or a comma or newline separated string; Bad for a bad one."""
    if value is None:
        return []
    if isinstance(value, str):
        value = re.split(r"[,\n]", value)
    if not isinstance(value, list):
        raise Bad("paths must be a list of glob patterns")
    out = []
    for p in value:
        if not isinstance(p, str):
            raise Bad("each path pattern must be a string")
        p = p.strip()
        while p.startswith("./"):
            p = p[2:]
        if not p:
            continue
        if len(p) > MAX_PATTERN or p.startswith("/") or ".." in p.split("/"):
            raise Bad(f"{p!r} is not a pattern relative to the repository root")
        out.append(p)
    if len(out) > MAX_PATTERNS:
        raise Bad(f"a path note takes at most {MAX_PATTERNS} patterns")
    return list(dict.fromkeys(out))


_GLOB_CACHE: dict[str, re.Pattern] = {}


def _glob_re(pattern: str) -> re.Pattern:
    rx = _GLOB_CACHE.get(pattern)
    if rx is not None:
        return rx
    pat = pattern.rstrip("/") + ("/**" if pattern.endswith("/") else "")
    if "/" not in pat:
        pat = "**/" + pat  # a bare name or *.ext matches at any depth, as in .gitignore
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c == "[":
            j = pat.find("]", i + 1)
            if j < 0:
                out.append(re.escape(c))
                i += 1
            else:
                body = pat[i + 1:j].replace("\\", "\\\\")
                out.append("[" + ("^" + body[1:] if body.startswith("!") else body) + "]")
                i = j + 1
        elif c == "{":
            j = pat.find("}", i + 1)
            if j < 0:
                out.append(re.escape(c))
                i += 1
            else:
                out.append("(?:" + "|".join(re.escape(x) for x in pat[i + 1:j].split(",")) + ")")
                i = j + 1
        else:
            out.append(re.escape(c))
            i += 1
    # A pattern for a folder also covers what is inside it.
    rx = re.compile("".join(out) + "(?:/.*)?")
    if len(_GLOB_CACHE) > 2000:
        _GLOB_CACHE.clear()
    _GLOB_CACHE[pattern] = rx
    return rx


def matches(pattern: str, rel: str) -> bool:
    return bool(_glob_re(pattern).fullmatch(rel))


def matching_notes(proj: Path, rel: str) -> list[dict]:
    """Path notes (with their bodies) that have a pattern matching ``rel``, by name."""
    out = []
    for name in names(proj, "path"):
        doc = read_doc(proj, "path", name)
        if doc and any(matches(p, rel) for p in doc["paths"]):
            out.append(doc)
    return out


# --- search ----------------------------------------------------------------------------------------------

def search(proj: Path, entries: list[str], query: str, limit: int = 20) -> list[dict]:
    """Lines of the index, topics and path notes that hold every word of ``query`` (case-insensitive), or
    whose file's name or description does: ``{where, name?, line?, text}``."""
    terms = [t for t in query.lower().split() if t]
    if not terms:
        return []
    hits: list[dict] = []

    def ok(text: str) -> bool:
        low = text.lower()
        return all(t in low for t in terms)

    for e in entries:
        if ok(e):
            hits.append({"where": "index", "text": e[:400]})
    for kind in ("topic", "path"):
        for name in names(proj, kind):
            doc = read_doc(proj, kind, name)
            if doc is None:
                continue
            head = f"{name} {doc['description']} {' '.join(doc.get('paths') or [])}"
            found = False
            for n, line in enumerate(doc["body"].split("\n"), 1):
                if ok(line):
                    hits.append({"where": kind, "name": name, "line": n, "text": line.strip()[:400]})
                    found = True
                    if len(hits) >= limit:
                        return hits
            if not found and (ok(head) or ok(doc["body"])):
                hits.append({"where": kind, "name": name, "text": doc["description"] or summary(doc["body"])})
            if len(hits) >= limit:
                return hits
    return hits[:limit]
