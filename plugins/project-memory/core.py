"""Shared core of project-memory: one curated MEMORY.md per project, for chats bound to a device folder.

A project is the git repository of the chat's bound folder (the device plugin's ``/device <device> <dir>``),
identified by its normalized origin URL (``github.com/alice/demo``), else the URL of the current branch's
upstream remote, else the URL of the only remote, else the repository's oldest root commit (``root:<sha>``). A
folder outside git is identified by device and folder (``folder:<device id>:<dir>``). A new identity with the
same root commit and repository name as a known project joins that project as an alias, so mirrors on two hosts
share one memory; a remote identity also joins a remote-less project with its root commit.

The identity is resolved on the device by a short git probe through the device plugin's hub, when the session
prompt is built and when the tool first runs in a binding; it is cached per binding generation in process and
per device folder in ``folders.json``, so the block and the tool still work while the device is offline. A
probe that takes longer than PROBE_WAIT_S finishes in the background and the cached answer is used meanwhile.

Storage under ``$HERMES_HOME/project-memories/<slug>/``: ``MEMORY.md``, the index (Hermes's own MemoryStore format
and rules, one short line per entry, budgeted and always in the prompt); ``topics/<name>.md``, the detail, read on
demand, with no count or size cap; ``paths/<name>.md``, path notes, handed to the agent when a file tool first
touches a matching file in a session; ``skills/``, project skills; ``meta.json`` (identity, aliases, root commit,
folders and devices seen). layout.py reads and writes the topics and path notes. A write that would overflow the
index never fails: the detail moves into a topic and the index keeps a one-line pointer (or, when even that does
not fit, the text goes to the ``inbox`` topic). A store from before topics is migrated once on first load (backup
first). The gateway (tool, prompt section, path-note hook) and the dashboard routes (hermes-hub's Memory page) run
in one process and share this module.
"""
from __future__ import annotations

import concurrent.futures
import contextlib
import hashlib
import importlib.util
import json
import logging
import os
import posixpath
import re
import shlex
import sys
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("project_memory")


def _load_layout():
    name = "hermes_project_memory_layout"
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("layout.py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


L = _load_layout()

PLUGIN = "project-memory"
TOOL = "project_memory"
TOOLSET = "project-memory"
SECTION_ID = "project-memory"
DEVICE_CORE = "hermes_device_core"
DIR_NAME = "project-memories"
META = "meta.json"
FOLDERS = "folders.json"
MEMORY_FILE = "MEMORY.md"
SKILLS_DIR = "skills"

KIND_REMOTE, KIND_ROOT, KIND_FOLDER = "remote", "root", "folder"
MIN_CHAR_LIMIT = 200
# A sanity bound on the notes' size. The prompt section is asked to hold the limit plus its header (SECTION_HEAD
# chars), up to what Hermes grants (plugins.max_section_chars, default 4,000). Notes past the granted size stay on
# disk and the agent reads them with the tool; render_block says how many.
MAX_CHAR_LIMIT = 32000
SECTION_HEAD = 2000
HERMES_SECTION_DEFAULT = 4000
SECTION_MARGIN = 10
_granted = HERMES_SECTION_DEFAULT  # max_chars Hermes granted at registration (see request_section_chars)
MAX_LABEL = 200
MAX_ALIASES_SHOWN = 3
RESOLVE_TIMEOUT_S = 10
PROBE_WAIT_S = 6
MAX_FOLDERS = 50
MAX_FOLDER_INDEX = 2000
MAX_CACHE = 5000
SEEN_REFRESH_S = 3600
MAX_TEXT = 64 * 1024

SHA_RE = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")
SLUG_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.~-]{0,159}")
_SLUG_BAD = re.compile(r"[^A-Za-z0-9.-]+")
_HOST_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*")
_URL_SCHEMES = frozenset({"ssh", "git+ssh", "ssh+git", "https", "http", "git"})

NOTE = ("This chat works in a project folder, so it has a project memory next to the global one. Save facts about "
        "this project (its code, rules, decisions, people involved, current state) with project_memory. Use memory "
        "only for facts about the user or rules that apply in every project. When unsure, use project_memory. "
        "Below is the project's index: keep each line short (one fact, under about 200 chars) and put detail in "
        "topics (topic_write, topic_append), which you read with project_memory action read topic=<name> when a "
        "task needs them. Rules for one folder or file type go in path notes (path_write with glob paths); they load "
        "when you read or edit a matching file.")
CHILD_NOTE = ("This task works in a project folder. Its project memory index is below; subagents can read it and "
              "its topics (project_memory action read topic=<name>) but not change them, so report new project facts "
              "in your result.")

SKILLS_NOTE = ("\n\nSKILLS: this chat's project also has project skills (skill_manage with scope='project'): "
               "knowledge about this one codebase (layout, commands, people, conventions) belongs in one, "
               "not in a global skill; a project-specific lesson found while using a global skill goes in a "
               "project skill too. Global skills stay generic: no project names, repo paths, hostnames or "
               "usernames.")

MEMORY_TOOL_NOTE = ("\n\nPROJECTS: in a chat bound to a project folder, facts about that project (its code, rules, "
                    "decisions, people involved, state) go in project_memory, not here. Use memory only for facts "
                    "about the user or rules that apply in every project. When unsure, use project_memory. "
                    "Procedures about one project are project skills (skill_manage scope='project'); global "
                    "skills must be generic.")

# Runs with /bin/sh on the device in the bound folder; prints only the lines the plugin parses. Remote URLs lose
# their credentials on the device, before they are sent.
PROBE = r"""export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 LC_ALL=C
command -v git >/dev/null 2>&1 || { echo "@@pm error git is not installed on the device"; exit 0; }
g() { git -c safe.directory='*' "$@" 2>/dev/null; }
clean() { printf '%s\n' "$1" | sed -e '/:\/\//s#^\([^:/]*://\).*@#\1#' -e '/:\/\//!s#^.*@##'; }
if ! top=$(g rev-parse --show-toplevel); then
  d=$(pwd -P)
  while :; do
    if [ -e "$d/.git" ]; then echo "@@pm error git cannot read the repository"; exit 0; fi
    [ "$d" = / ] && break
    d=$(dirname "$d")
  done
  echo "@@pm nogit"
  exit 0
fi
printf '@@pm top %s\n' "$top"
u=$(g remote get-url origin) && printf '@@pm origin %s\n' "$(clean "$u")"
b=$(g symbolic-ref -q --short HEAD) && r=$(g config --get "branch.$b.remote") && [ "$r" != . ] && u=$(g remote get-url "$r") && printf '@@pm upstream %s\n' "$(clean "$u")"
set -- $(g remote)
[ $# -eq 1 ] && u=$(g remote get-url "$1") && printf '@@pm single %s\n' "$(clean "$u")"
if [ "$(g rev-parse --is-shallow-repository)" != true ]; then
  c=$(g rev-list --max-parents=0 --reverse HEAD | head -n 1) && [ -n "$c" ] && printf '@@pm root %s\n' "$c"
fi
exit 0
"""


def probe_command() -> str:
    """The probe as one command line that runs with /bin/sh whatever the device user's shell is."""
    return "exec /bin/sh -c " + shlex.quote(PROBE)


class Refused(Exception):
    """A refused change from the hub: an HTTP status, an error code and a message for the user."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


# --- identity ------------------------------------------------------------------------------------

def normalize_remote(url: Any) -> Optional[str]:
    """``host/owner/repo`` of a git remote URL, lowercased, without scheme, credentials, port or ``.git``;
    None for a local path, a ``file:`` URL or anything that is not a remote. Credentials end at the last ``@``
    of the part before the path, even when they hold ``:`` or ``/``."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if not url or url.startswith(("/", ".", "~")) or any(c in url for c in "\n\r\t "):
        return None
    if "://" in url:
        scheme, _, rest = url.partition("://")
        if scheme.lower() not in _URL_SCHEMES:
            return None
        rest = rest.rsplit("@", 1)[-1]
        host, _, path = rest.partition("/")
        host = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    else:
        rest = url.rsplit("@", 1)[-1]
        host, sep, path = rest.partition(":")
        if not sep:
            return None
    host = host.strip().lower().rstrip(".")
    if not _HOST_RE.fullmatch(host):
        return None
    path = re.sub(r"/{2,}", "/", path.strip()).strip("/")
    if path.lower().endswith(".git"):
        path = path[:-4].rstrip("/")
    if not path or any(seg in ("", ".", "..") for seg in path.split("/")):
        return None
    return f"{host}/{path}".lower()


def parse_probe(out: str) -> dict[str, str]:
    """The probe's ``@@pm`` lines as a dict: ``nogit``, ``error``, or ``top`` and any of ``origin``,
    ``upstream``, ``single``, ``root``."""
    found: dict[str, str] = {}
    for line in (out or "").splitlines():
        if not line.startswith("@@pm "):
            continue
        key, _, value = line[5:].partition(" ")
        if key == "nogit":
            return {"nogit": "1"}
        if key == "error":
            return {"error": value.strip() or "git failed on the device"}
        if key in ("top", "origin", "upstream", "single", "root") and key not in found:
            found[key] = value.strip()
    return found


def identity_from_probe(probe: dict[str, str], device_id: str, directory: str) -> Optional[dict[str, str]]:
    """``{identity, kind, name, root}`` for a probed folder; ``{error}`` when git failed on the device; None
    when the probe said nothing usable."""
    if probe.get("error"):
        return {"error": probe["error"]}
    if probe.get("nogit"):
        return folder_identity(device_id, directory)
    top = probe.get("top") or ""
    if not top.startswith("/"):
        return None
    root = probe.get("root", "")
    root = root if SHA_RE.fullmatch(root) else ""
    for key in ("origin", "upstream", "single"):
        ident = normalize_remote(probe.get(key))
        if ident:
            return {"identity": ident, "kind": KIND_REMOTE, "name": ident.rsplit("/", 1)[-1], "root": root}
    if root:
        return {"identity": f"root:{root}", "kind": KIND_ROOT, "name": posixpath.basename(top.rstrip("/")) or top,
                "root": root}
    return folder_identity(device_id, top)


def folder_identity(device_id: str, directory: str) -> dict[str, str]:
    directory = posixpath.normpath(directory)
    return {"identity": f"folder:{device_id}:{directory}", "kind": KIND_FOLDER,
            "name": posixpath.basename(directory) or directory, "root": ""}


def _hash8(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogatepass")).hexdigest()[:8]


def slug_for(identity: str) -> str:
    """A readable, path-safe directory name for an identity: ``github.com-alice-demo``, ``root-<sha>``,
    ``<device>-home-alice-demo``. Long ones are cut and get a hash suffix. Always matches SLUG_RE."""
    if identity.startswith("root:"):
        base = "root-" + identity[5:]
    elif identity.startswith("folder:"):
        device_id, _, directory = identity[7:].partition(":")
        base = _SLUG_BAD.sub("-", device_id) + "-" + _SLUG_BAD.sub("-", directory)
    else:
        base = _SLUG_BAD.sub("-", identity)
    base = re.sub(r"\.{2,}", ".", re.sub(r"-{2,}", "-", base)).strip("-.") or "project"
    if len(base) > 120:
        base = base[:120].rstrip("-.") + "~" + _hash8(identity)
    return base


# --- storage -------------------------------------------------------------------------------------

_LOCK = threading.RLock()


def base_dir() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / DIR_NAME


def _mkdir(path: Path) -> None:
    try:
        from hermes_constants import mkdir_under_hermes_home
        mkdir_under_hermes_home(path)
    except ImportError:
        path.mkdir(parents=True, exist_ok=True)


@contextlib.contextmanager
def _locked():
    """The process lock and a file lock on ``.lock``, for meta.json and folders.json."""
    with _LOCK:
        base = base_dir()
        _mkdir(base)
        try:
            import fcntl
        except ImportError:
            yield
            return
        fd = os.open(base / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)


def _read_json(path: Path) -> Optional[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _write_json(path: Path, doc: dict) -> None:
    _mkdir(path.parent)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(doc, indent=2, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def valid_slug(slug: Any) -> bool:
    return isinstance(slug, str) and bool(SLUG_RE.fullmatch(slug)) and ".." not in slug


def read_meta(slug: str) -> Optional[dict]:
    if not valid_slug(slug):
        return None
    meta = _read_json(base_dir() / slug / META)
    return meta if meta and isinstance(meta.get("identity"), str) else None


def _all_metas() -> dict[str, dict]:
    base = base_dir()
    out: dict[str, dict] = {}
    try:
        names = sorted(p.name for p in base.iterdir() if p.is_dir())
    except OSError:
        return out
    for name in names:
        meta = read_meta(name)
        if meta is not None:
            out[name] = meta
    return out


def _identities(meta: dict) -> list[str]:
    return [meta["identity"], *[a for a in meta.get("aliases") or [] if isinstance(a, str)]]


def _same_repo(ident: dict[str, str], meta: dict) -> bool:
    """A mirror: the same root commit and repository name. A remote-less project's name is its folder's, so a
    project or identity of kind root needs only the root commit."""
    if meta.get("kind") == KIND_FOLDER or meta.get("root_commit") != ident.get("root"):
        return False
    if KIND_ROOT in (ident["kind"], meta.get("kind")):
        return True
    return str(meta.get("name") or "").lower() == ident.get("name", "").lower()


def attach(ident: dict[str, str]) -> str:
    """The slug of the project an identity belongs to, created when new. A remote or root identity of the same
    repository as a known project (``_same_repo``) joins it as an alias. Call with the lock."""
    identity, root = ident["identity"], ident.get("root", "")
    metas = _all_metas()
    for slug, meta in metas.items():
        if identity in _identities(meta):
            if root and not meta.get("root_commit") and meta.get("kind") != KIND_FOLDER:
                meta["root_commit"] = root
                _write_json(base_dir() / slug / META, meta)
            return slug
    if ident["kind"] != KIND_FOLDER and root:
        same = [slug for slug, meta in metas.items() if _same_repo(ident, meta)]
        named = [s for s in same if str(metas[s].get("name") or "").lower() == ident.get("name", "").lower()]
        pick = named[0] if named else (same[0] if len(same) == 1 else None)
        if pick is not None:
            meta = metas[pick]
            meta["aliases"] = [*(meta.get("aliases") or []), identity]
            _write_json(base_dir() / pick / META, meta)
            logger.info("project-memory: %s joined project %s as an alias", identity, pick)
            return pick
    slug = slug_for(identity)
    if slug in metas or (base_dir() / slug).exists():
        slug = slug[:150].rstrip("-.") + "~" + _hash8(identity)
    meta = {"version": 1, "identity": identity, "kind": ident["kind"], "name": ident.get("name", ""),
            "aliases": [], "root_commit": root, "folders": [], "created_at": round(time.time(), 3), "layout": LAYOUT}
    _write_json(base_dir() / slug / META, meta)
    logger.info("project-memory: new project %s", slug)
    return slug


def _folder_key(device_id: str, directory: str) -> str:
    return f"{device_id}\n{directory}"


def _note_folder(slug: str, device_id: str, device: str, directory: str, top: str = "") -> None:
    """Record the folder in the project's meta and in folders.json (with the repository's top folder, which
    path notes match against). Call with the lock."""
    now = round(time.time(), 3)
    path = base_dir() / slug / META
    meta = _read_json(path) or {}
    folders = [f for f in meta.get("folders") or [] if isinstance(f, dict)]
    old = next((f for f in folders if f.get("device_id") == device_id and f.get("dir") == directory), None)
    if old is None or old.get("device") != device or now - float(old.get("seen_at") or 0) > SEEN_REFRESH_S:
        folders = [f for f in folders if f is not old]
        folders.insert(0, {"device_id": device_id, "device": device, "dir": directory, "seen_at": now})
        meta["folders"] = folders[:MAX_FOLDERS]
        _write_json(path, meta)
    index_path = base_dir() / FOLDERS
    index = _read_json(index_path) or {}
    entries = index.get("folders") if isinstance(index.get("folders"), dict) else {}
    key = _folder_key(device_id, directory)
    if top:
        _remember(_TOPS, (device_id, directory), top)
    old_entry = entries.get(key) or {}
    if old_entry.get("project") != slug or (top and old_entry.get("top") != top):
        entries[key] = {"project": slug, "resolved_at": now, **({"top": top} if top else {})}
        if len(entries) > MAX_FOLDER_INDEX:
            keep = sorted(entries, key=lambda k: float((entries[k] or {}).get("resolved_at") or 0))
            entries = {k: entries[k] for k in keep[-MAX_FOLDER_INDEX:]}
        _write_json(index_path, {"version": 1, "folders": entries})


def repo_top(device_id: str, directory: str) -> str:
    """The repository's top folder of a device folder, as the last probe saw it; the folder itself when unknown."""
    top = _TOPS.get((device_id, directory))
    if top is None:
        entry = ((_read_json(base_dir() / FOLDERS) or {}).get("folders") or {}).get(_folder_key(device_id, directory)) or {}
        top = entry.get("top") if isinstance(entry.get("top"), str) and entry["top"].startswith("/") else ""
        _remember(_TOPS, (device_id, directory), top)
    return top or directory


def cached_folder(device_id: str, directory: str) -> Optional[str]:
    index = _read_json(base_dir() / FOLDERS) or {}
    entry = (index.get("folders") or {}).get(_folder_key(device_id, directory)) or {}
    slug = entry.get("project")
    return slug if valid_slug(slug) and read_meta(slug) is not None else None


# --- binding lookup --------------------------------------------------------------------------------

_SESSION_CACHE: dict[tuple[str, str], str] = {}
_TOPS: dict[tuple[str, str], str] = {}
_CHILDREN: set[str] = set()
_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="project-memory-probe")
_INFLIGHT: dict[tuple[str, str], concurrent.futures.Future] = {}
_INFLIGHT_LOCK = threading.Lock()


def _remember(cache: Any, key: Any, value: Any = None) -> None:
    if len(cache) >= MAX_CACHE:
        cache.clear()
    if isinstance(cache, set):
        cache.add(key)
    else:
        cache[key] = value


def device_core():
    return sys.modules.get(DEVICE_CORE)


def binding_of(session_id: str):
    """``(binding, why)``: the explicit device binding of the session's lineage (the chat itself, or the chat a
    subagent or a compressed segment came from), or None and why there is none. The implicit sandbox binding of
    an unbound chat is not a project."""
    core = device_core()
    if core is None:
        return None, "the device plugin is not loaded, so no chat has a project folder"
    if not session_id:
        return None, "this call has no session"
    res = core.hub().resolve(session_id)
    if res.state != core.STATE_BOUND or res.binding is None or getattr(res, "sandbox", False):
        return None, ("this chat is not bound to a project folder (bind it with /device <device> <dir>), so it has "
                      "no project memory; use memory for facts that apply everywhere")
    return res.binding, ""


def _device_name(core, device_id: str) -> str:
    conn = core.hub().device(device_id)
    return str(getattr(conn, "name", "") or device_id) if conn is not None else device_id


def _probe(device_id: str, directory: str) -> tuple[Optional[str], str]:
    """Run the git probe and record the answer: ``(slug, "")``, or None and why it could not."""
    core = device_core()
    if core is None or core.hub().device(device_id) is None:
        return None, "offline"
    try:
        code, out, _proc = core.hub().run(device_id, probe_command(), directory, timeout=RESOLVE_TIMEOUT_S)
    except Exception as exc:
        logger.warning("project-memory: the git probe on device %s failed: %s", device_id, type(exc).__name__)
        return None, "offline"
    if code != 0:
        logger.info("project-memory: the git probe on device %s exited %s", device_id, code)
        return None, "offline"
    probe = parse_probe(out)
    ident = identity_from_probe(probe, device_id, directory)
    top = probe.get("top", "") if str(probe.get("top", "")).startswith("/") else ""
    if ident is None:
        return None, "offline"
    if ident.get("error"):
        return None, ident["error"]
    with _locked():
        slug = attach(ident)
        _note_folder(slug, device_id, _device_name(core, device_id), directory, top)
    return slug, ""


def resolve_live(device_id: str, directory: str, wait: float = PROBE_WAIT_S) -> tuple[Optional[str], str]:
    """The probe for one device folder, waited for at most ``wait`` seconds. A slower probe keeps running and
    records its answer for the next lookup; one probe per folder runs at a time."""
    key = (device_id, directory)
    with _INFLIGHT_LOCK:
        fut = _INFLIGHT.get(key)
        if fut is None or fut.done():
            fut = _POOL.submit(_probe, device_id, directory)
            _INFLIGHT[key] = fut
    try:
        return fut.result(timeout=wait)
    except concurrent.futures.TimeoutError:
        return None, "offline"
    except Exception as exc:
        logger.warning("project-memory: resolving %s on device %s failed: %s", directory, device_id,
                       type(exc).__name__)
        return None, "offline"


def project_for_session(session_id: str, *, live: bool) -> tuple[Optional[str], str]:
    """``(slug, why)`` of the session's project. ``live`` probes the device even when this binding generation
    was resolved before (a prompt build); otherwise the cached answer is used. Falls back to the last answer
    for the folder when the device is offline or slow."""
    binding, why = binding_of(session_id)
    if binding is None:
        return None, why
    key = (binding.session_id, binding.generation)
    if not live and key in _SESSION_CACHE and read_meta(_SESSION_CACHE[key]) is not None:
        return _SESSION_CACHE[key], ""
    slug, failed = resolve_live(binding.device_id, binding.dir)
    if slug is None:
        slug = _SESSION_CACHE.get(key) or cached_folder(binding.device_id, binding.dir)
    if slug is None:
        if failed and failed != "offline":
            return None, (f"{failed} ({binding.dir} on device {binding.device_id}), so this folder's project is not "
                          "known and project memory is not available now. Nothing was read or written.")
        return None, (f"device {binding.device_id} is offline or did not answer, and the project of {binding.dir} is "
                      "not known yet, so project memory is not available now. Nothing was read or written; try "
                      "again when the device is connected.")
    _remember(_SESSION_CACHE, key, slug)
    return slug, ""


# --- the store --------------------------------------------------------------------------------------

_STORE_CLASS = None
_STORES: dict[tuple[str, str], Any] = {}


def _store_class():
    global _STORE_CLASS
    if _STORE_CLASS is None:
        from tools.memory_tool_store import MemoryStore

        class ProjectStore(MemoryStore):
            """Hermes's MemoryStore on one project's MEMORY.md (target ``memory`` only)."""

            def __init__(self, path: Path, limit: int):
                super().__init__(memory_char_limit=limit, user_char_limit=0, memory_enabled=True,
                                 user_profile_enabled=False)
                self._project_path = path

            def _path_for(self, target: str) -> Path:
                return self._project_path

        _STORE_CLASS = ProjectStore
    return _STORE_CLASS


def session_store(session_id: str, slug: str):
    """The session's store for a project, kept so Hermes's per-turn cap on failed consolidation holds."""
    limit = char_limit()
    st = _STORES.get((session_id, slug))
    if st is None or st.memory_char_limit != limit:
        st = store(slug, limit)
        _remember(_STORES, (session_id, slug), st)
    return st


def on_turn_start(session_id: str = "", **_kwargs) -> None:
    for (sid, _slug), st in list(_STORES.items()):
        if sid == session_id:
            st.reset_consolidation_failures()

def _config() -> dict:
    try:
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly()
    except Exception:
        return {}
    return cfg if isinstance(cfg, dict) else {}


def char_limit(cfg: Optional[dict] = None) -> int:
    """The plugin's ``char_limit`` setting, else the global memory_char_limit, at most MAX_CHAR_LIMIT (a sanity bound)."""
    cfg = _config() if cfg is None else cfg
    settings = (((cfg.get("plugins") or {}).get("entries") or {}).get(PLUGIN) or {}).get("settings") or {}
    value = settings.get("char_limit") if isinstance(settings, dict) else None
    if not isinstance(value, int) or isinstance(value, bool):
        mem = cfg.get("memory") if isinstance(cfg.get("memory"), dict) else {}
        value = mem.get("memory_char_limit", 2200)
        value = value if isinstance(value, int) and not isinstance(value, bool) else 2200
    return max(MIN_CHAR_LIMIT, min(value, MAX_CHAR_LIMIT))


def request_section_chars() -> int:
    """The ``max_chars`` to register the prompt section with: room for the largest note set plus its header, cut to
    what this Hermes allows (``plugins.max_section_chars``, 4,000 unless raised; a Hermes without it allows 4,000)."""
    global _granted
    wanted = MAX_CHAR_LIMIT + SECTION_HEAD
    try:
        from hermes_cli.plugins import system_prompt_section_ceiling
        ceiling = int(system_prompt_section_ceiling())
    except Exception:
        ceiling = HERMES_SECTION_DEFAULT
    _granted = max(1, min(wanted, ceiling))
    limit = char_limit()
    if _granted < limit + SECTION_HEAD:
        logger.warning("project-memory: the prompt shows at most %d chars of notes (char_limit is %d); set "
                       "plugins.max_section_chars to %d or more in Hermes's config to show all of them",
                       _granted - SECTION_HEAD, limit, limit + SECTION_HEAD)
    return _granted


def section_budget(limit: Optional[int] = None) -> int:
    """The characters the prompt block may use: the limit plus its header, at most what Hermes granted."""
    limit = char_limit() if limit is None else limit
    return min(limit + SECTION_HEAD, _granted) - SECTION_MARGIN


def memory_path(slug: str) -> Path:
    return base_dir() / slug / MEMORY_FILE


def store(slug: str, limit: Optional[int] = None):
    return _store_class()(memory_path(slug), char_limit() if limit is None else limit)


def skills_dir(slug: str) -> Optional[Path]:
    """The project's skills dir, next to its MEMORY.md (it need not exist yet); None for an unknown project."""
    return base_dir() / slug / SKILLS_DIR if valid_slug(slug) and read_meta(slug) is not None else None


def session_project(session_id: str) -> Optional[str]:
    """The slug of the session's project for the skills lookups: the cached answer, else a probe. None for a
    chat with no project folder or a device that is not known yet. Never raises."""
    try:
        slug, _why = project_for_session(session_id, live=False)
    except Exception:
        return None
    return slug


def skill_terms(slug: str) -> list[str]:
    """Words that name the project (its repository name, its aliases' repository names, its folders' names),
    which a global skill must not carry."""
    meta = read_meta(slug) or {}
    words = {str(meta.get("name") or "")}
    words.update(str(a).rsplit("/", 1)[-1] for a in meta.get("aliases") or [] if isinstance(a, str))
    for f in meta.get("folders") or []:
        if isinstance(f, dict) and isinstance(f.get("dir"), str):
            words.add(posixpath.basename(f["dir"].rstrip("/")))
    return sorted(w for w in words if len(w) >= 3 and w not in {"home", "src", "code", "repo", "project", "work"})


def skill_count(slug: str) -> int:
    root = skills_dir(slug)
    try:
        return sum(1 for _ in root.rglob("SKILL.md")) if root is not None and root.is_dir() else 0
    except OSError:
        return 0


def register_skills_provider() -> bool:
    """Tell this Hermes where a chat's project skills live (Talaria Hermes patch 0094); False on a Hermes
    without it, where skills stay global."""
    try:
        from agent.skill_utils import register_project_skills_provider
    except ImportError:
        return False
    register_project_skills_provider(session_project, skills_dir, skill_terms)
    return True


def project_dir(slug: str) -> Path:
    return base_dir() / slug


def _raw_entries(slug: str) -> list[str]:
    from tools.memory_tool_store import MemoryStore
    return list(dict.fromkeys(MemoryStore._read_file(memory_path(slug))))


def entries(slug: str) -> list[str]:
    """The index entries, after a one-time migration of a store from before topics."""
    ensure_layout(slug)
    return _raw_entries(slug)


# --- migration -----------------------------------------------------------------------------------------

LAYOUT = 2
# An index entry longer than this becomes a topic on migration; the index keeps its first sentence.
MIGRATE_MAX = 200
POINTER_SUMMARY = 150


def ensure_layout(slug: str) -> Optional[dict]:
    """Move a store from before topics to the index-plus-topics layout, once: back up MEMORY.md next to itself
    (``MEMORY.md.bak-<time>``, never deleted), keep entries of at most MIGRATE_MAX chars in the index, and turn each
    longer one into a topic with its full text, leaving its first sentence and a pointer in the index. Marked
    done in meta.json, so it runs once; running it again changes nothing. Returns what it did, or None."""
    meta = read_meta(slug)
    if meta is None or _layout_of(meta) >= LAYOUT:
        return None
    with _locked():
        meta = read_meta(slug)
        if meta is None or _layout_of(meta) >= LAYOUT:
            return None
        try:
            done = _migrate(slug)
        except Exception as exc:  # leave the store as it was; the next load tries again
            logger.warning("project-memory: migrating %s failed: %s", slug, exc)
            return None
        meta["layout"] = LAYOUT
        meta["migrated_at"] = round(time.time(), 3)
        if done.get("backup"):
            meta["migration_backup"] = done["backup"]
        _write_json(base_dir() / slug / META, meta)
    if done.get("moved"):
        logger.info("project-memory: migrated %s: %d long entries became topics (backup %s)", slug,
                    len(done["moved"]), done.get("backup"))
    return done


def _layout_of(meta: dict) -> int:
    value = meta.get("layout")
    return value if isinstance(value, int) and not isinstance(value, bool) else 1


def _migrate(slug: str) -> dict:
    path = memory_path(slug)
    if not path.exists():
        return {"moved": []}
    raw = path.read_bytes()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    backup = path.with_name(f"{MEMORY_FILE}.bak-{stamp}")
    n = 1
    while backup.exists():
        n += 1
        backup = path.with_name(f"{MEMORY_FILE}.bak-{stamp}-{n}")
    with open(backup, "xb") as fh:
        fh.write(raw)
        fh.flush()
        os.fsync(fh.fileno())
    proj = project_dir(slug)
    moved: list[str] = []

    def split(items, _limit):
        taken = set(L.names(proj, "topic"))
        out = []
        for e in items:
            if len(e) <= MIGRATE_MAX:
                out.append(e)
                continue
            name = L.name_for(e, taken)
            taken.add(name)
            L.write_doc(proj, "topic", name, e, description=L.summary(e, 120))
            moved.append(name)
            out.append(L.pointer(L.summary(e, POINTER_SUMMARY), name))
        return out, "migrated"

    if any(len(e) > MIGRATE_MAX for e in _raw_entries(slug)):
        st = store(slug, MAX_CHAR_LIMIT * 4)
        result = st._mutate("memory", split, skip_drift=True)
        if not result.get("success"):
            raise RuntimeError(f"project-memory: could not migrate {slug}: {result.get('error')}")
    return {"moved": moved, "backup": backup.name}


def _delim() -> str:
    from tools.memory_tool_store import ENTRY_DELIMITER
    return ENTRY_DELIMITER


def _label(meta: dict) -> str:
    ident = meta.get("identity", "")
    if meta.get("kind") == KIND_ROOT:
        ident = f"{meta.get('name') or 'repository'} (git repository without a remote, root commit {ident[5:17]})"
    elif meta.get("kind") == KIND_FOLDER:
        ident = ident[7:].replace(":", " folder ", 1)
    aliases = [a for a in meta.get("aliases") or [] if isinstance(a, str)]
    shown = ", ".join(aliases[:MAX_ALIASES_SHOWN])
    if len(aliases) > MAX_ALIASES_SHOWN:
        shown += f" and {len(aliases) - MAX_ALIASES_SHOWN} more"
    label = ident + (f", also {shown}" if aliases else "")
    return label if len(label) <= MAX_LABEL else label[:MAX_LABEL - 3] + "..."


def _sanitize(entry: str) -> str:
    try:
        from tools.threat_patterns import scan_for_threats
        findings = scan_for_threats(entry, scope="strict") if entry and not entry.startswith("[BLOCKED:") else None
    except Exception:
        findings = ["the threat scan failed"]
    if not findings:
        return entry
    return (f"[BLOCKED: project memory entry contained threat pattern(s): {', '.join(findings)}. Removed from the "
            f"system prompt; use project_memory remove to delete the original.]")


def render_block(slug: str, limit: Optional[int] = None, note: str = NOTE) -> str:
    """The project block for the system prompt: the note, a header with the project and usage, and the entries
    that fit the section budget, in order; an entry that does not fit is left out and counted."""
    meta = read_meta(slug)
    if meta is None:
        return ""
    limit = char_limit() if limit is None else limit
    budget = section_budget(limit)
    raw = entries(slug)
    items = [_sanitize(e) for e in raw]
    delim = _delim()
    used = len(delim.join(raw))
    sep = "═" * 46
    pct = min(100, int(used * 100 / limit)) if limit > 0 else 0
    head = f"{note}\n\n{sep}\nPROJECT MEMORY ({_label(meta)}) [index {pct}%, {used:,}/{limit:,} chars]\n{sep}\n"
    tail = _block_tail(slug, pct)
    if not items:
        return head + "(no project notes yet)" + tail
    if len(head) + len(delim.join(items)) + len(tail) <= budget:
        return head + delim.join(items) + tail
    marker = ("\n[{n} more index lines are not shown: they do not fit in the prompt. Read them with "
              "project_memory action read, then shorten them or move their detail into topics.]")
    room = budget - len(head) - len(tail) - len(marker) - 8
    shown: list[str] = []
    for item in items:
        if len(delim.join([*shown, item])) <= room:
            shown.append(item)
    return head + delim.join(shown) + marker.format(n=len(items) - len(shown)) + tail


MAX_TOPIC_LIST = 700
MAX_PATH_LIST = 400
WARN_PCT = 80


def _names_line(label: str, names: list[str], cap: int, more: str) -> str:
    out: list[str] = []
    for n in names:
        if len(", ".join([*out, n])) > cap:
            break
        out.append(n)
    rest = len(names) - len(out)
    return label + ", ".join(out) + (f" and {rest} more ({more})" if rest else "")


def _block_tail(slug: str, pct: int) -> str:
    """The lines after the index: the 80% warning, the topic names, the inbox count, the path note names."""
    proj = project_dir(slug)
    lines = []
    if pct >= WARN_PCT:
        lines.append(f"[The index is {pct}% full. Writes still succeed when it is full (the detail moves into a "
                     "topic), but merge or shorten old lines and move detail into topics when you can.]")
    topics = [n for n in L.names(proj, "topic")]
    if topics:
        lines.append(_names_line("Topics (read one with project_memory action read topic=<name>): ", topics,
                                 MAX_TOPIC_LIST, "project_memory action list"))
    inbox = L.inbox_count(proj)
    if inbox:
        lines.append(f"The inbox topic holds {inbox} unsorted note{'s' if inbox != 1 else ''} saved while the index "
                     "was full: sort them into topics and index lines, then remove them from the inbox.")
    paths = L.names(proj, "path")
    if paths:
        lines.append(_names_line("Path notes (they load when you read or edit a matching file): ", paths,
                                 MAX_PATH_LIST, "project_memory action list"))
    return ("\n\n" + "\n".join(lines)) if lines else ""


def section(info: Any) -> str:
    """The plugin system prompt section: rendered once per session and at each prompt rebuild."""
    session_id = str((info or {}).get("session_id") or "")
    if not offered():
        return ""
    try:
        slug, _why = project_for_session(session_id, live=True)
        if not slug:
            return ""
        child = children_blocked() and is_child(session_id)
    except Exception as exc:
        logger.warning("project-memory: could not find the project of session %s: %s", session_id,
                       type(exc).__name__)
        return ""
    return render_block(slug, note=(CHILD_NOTE if child else NOTE) + ("" if child else SKILLS_NOTE))


# --- the tool ---------------------------------------------------------------------------------------

def _tool_error(message: str, **extra) -> str:
    return json.dumps({"success": False, "error": message, **extra}, ensure_ascii=False)


def children_blocked() -> bool:
    """Subagents may not write project memory while Hermes keeps them from writing the global memory."""
    try:
        from tools.delegate_tool_toolsets import DELEGATE_BLOCKED_TOOLS
    except Exception:
        return True
    return "memory" in DELEGATE_BLOCKED_TOOLS


def note_child(child_session_id: Any = None, **_kwargs) -> None:
    if isinstance(child_session_id, str) and child_session_id:
        _remember(_CHILDREN, child_session_id)


def is_child(session_id: str) -> bool:
    """A delegate subagent's session (or a compressed segment of one, which keeps its source). True when the
    session store cannot tell, so a write is refused rather than allowed."""
    if session_id in _CHILDREN:
        return True
    try:
        from hermes_cli.goals import _get_session_db
        db = _get_session_db()
        row = db.get_session(session_id) if db is not None else None
    except Exception:
        return True
    return isinstance(row, dict) and row.get("source") == "subagent"


def _unattended_review() -> bool:
    try:
        from tools.skill_provenance import is_unattended_review
        return bool(is_unattended_review())
    except Exception:
        return False


def _approval_setting(cfg: Optional[dict] = None) -> Optional[bool]:
    """The plugin's ``write_approval`` setting: True, False, or None when unset (or not a bool)."""
    cfg = _config() if cfg is None else cfg
    plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    entry = (plugins.get("entries") or {}).get(PLUGIN) if isinstance(plugins.get("entries"), dict) else None
    settings = entry.get("settings") if isinstance(entry, dict) else None
    value = settings.get("write_approval") if isinstance(settings, dict) else None
    return value if isinstance(value, bool) else None


def _approval_on() -> bool:
    """Whether a new project write waits for approval: the plugin's ``write_approval`` when set, else Hermes's
    ``memory.write_approval``. Writes already staged stay staged either way."""
    setting = _approval_setting()
    if setting is False:
        return False
    try:
        from tools import write_approval as wa
        if setting is True:
            return True
        return bool(wa.write_approval_enabled(wa.MEMORY))
    except Exception:
        return False


INDEX_ACTIONS = ("add", "patch", "replace", "remove")
WRITE_ACTIONS = INDEX_ACTIONS  # the index operations, as before topics
FILE_ACTIONS = ("topic_write", "topic_append", "topic_patch", "topic_remove", "path_write", "path_remove")
ALL_ACTIONS = INDEX_ACTIONS + FILE_ACTIONS
DESTRUCTIVE = ("patch", "replace", "remove", "topic_write", "topic_patch", "topic_remove", "path_write",
               "path_remove")
# The target of a staged project write in Hermes's memory approval queue. Hermes's own replay refuses it, so a
# process without this plugin can never apply a project write to the global MEMORY.md.
PENDING_TARGET = "project"


def _op_line(op: dict) -> str:
    act, content, old = op.get("action", "?"), op.get("content") or "", op.get("old_text") or ""
    topic, note = op.get("topic") or "", op.get("path_note") or ""
    if act == "remove":
        return f"- remove: {old}"
    if act == "patch":
        return f"- patch span '{old}' -> '{content}' (rest of the entry is kept)"
    if act == "replace":
        return f"- replace entry matching '{old}' with: {content}"
    if act == "add" and topic:
        return f"- add to topic {topic} (with a pointer in the index): {content}"
    if act == "topic_write":
        return f"- write topic {topic}: {content}"
    if act == "topic_append":
        return f"- append to topic {topic}: {content}"
    if act == "topic_patch":
        return f"- patch topic {topic}: '{old}' -> '{content}'"
    if act == "topic_remove":
        return f"- delete topic {topic}"
    if act == "path_write":
        return f"- write path note {note} for {', '.join(op.get('paths') or []) or 'its patterns'}: {content}"
    if act == "path_remove":
        return f"- delete path note {note}"
    return f"- {act}: {content}"


def _pin(st, operations: list) -> dict:
    """The index operations of a batch with the full entry each replace, patch or remove selects now, as Hermes
    pins its own staged writes; file operations pass through. The budget is not checked: the write moves detail
    into a topic when the index is full."""
    index_ops = [op for op in operations if op.get("action") in INDEX_ACTIONS and not op.get("topic")]
    pinned = st.resolve_batch_entries("memory", index_ops) if index_ops else {"success": True, "matched_entries": []}
    if not pinned.get("success"):
        matched = []
        for op in index_ops:
            if op.get("action") == "add":
                matched.append(None)
                continue
            one = st.resolve_entry("memory", op.get("old_text") or "", op.get("action"))
            if not one.get("success"):
                return one
            matched.append(one["matched_entry"])
        pinned = {"success": True, "matched_entries": matched}
    it = iter(pinned["matched_entries"])
    out = []
    for op in operations:
        entry = next(it) if op.get("action") in INDEX_ACTIONS and not op.get("topic") else None
        out.append(op if entry is None else {**op, "matched_entry": entry})
    return {"success": True, "operations": out}


def _stage(st, slug: str, project: str, operations: list, *, summary: str, message: str,
           origin: Optional[str] = None) -> dict:
    """Stage a batch in Hermes's memory approval queue (``/memory pending`` and the hub's approval controls),
    pinned to the entries it selects now."""
    from tools import write_approval as wa
    pinned = _pin(st, operations)
    if not pinned.get("success"):
        return pinned
    payload = {"action": "batch", "target": PENDING_TARGET, "project": slug, "project_identity": project,
               "operations": pinned["operations"]}
    record = wa.stage_write(wa.MEMORY, payload, summary=summary[:200], origin=origin or wa.current_origin())
    return {"success": True, "staged": True, "pending_id": record["id"], "project": project, "message": message}


def _gate(st, slug: str, project: str, operations: list) -> Optional[dict]:
    """The same rules as Hermes's memory tool: unattended background review stages changes and deletions;
    with memory.write_approval on, a write is approved inline, staged for approval, or refused when the user
    denies it. None lets the write go ahead."""
    detail = "\n".join(_op_line(op) for op in operations)
    label = f"project memory {project}"
    if _unattended_review() and any(op.get("action") in DESTRUCTIVE for op in operations):
        try:
            return _stage(st, slug, project, operations,
                          summary=f"background review consolidation (batch on {label}): {detail}",
                          message=("Background review may not change or delete project memory entries unattended. "
                                   "The proposed batch was staged for the user's approval (/memory pending)."),
                          origin="background_review")
        except Exception:
            logger.warning("project-memory: could not stage a background-review batch; denying", exc_info=True)
            return {"success": False, "error": "Background review may not change or delete project memory "
                                               "entries; add and topic_append are still available."}
    if not _approval_on():
        return None
    from tools import write_approval as wa
    summary = f"apply {len(operations)} op(s) to {label}"
    decision = wa.evaluate_gate(wa.MEMORY, inline_summary=summary, inline_detail=detail)
    if decision.allow:
        return None
    if decision.blocked:
        return {"success": False, "error": decision.message, "project": project}
    return _stage(st, slug, project, operations, summary=f"{summary}: {detail[:120]}", message=decision.message)


# --- applying a write ------------------------------------------------------------------------------------

def _check_ops(slug: str, operations: list) -> Optional[str]:
    """Why a batch cannot run, checked before anything is written; None when it can."""
    proj = project_dir(slug)
    for i, op in enumerate(operations, 1):
        act = op.get("action")
        pos = f"Operation {i} ({act})"
        try:
            if act in ("topic_write", "topic_append", "topic_patch", "topic_remove") or (act == "add" and op.get("topic")):
                name = L.clean_name(op.get("topic"))
            if act in ("path_write", "path_remove"):
                name = L.clean_name(op.get("path_note"))
            if act in ("topic_write", "topic_append", "path_write"):
                if not isinstance(op.get("content"), str) or not op["content"].strip():
                    return f"{pos}: content is required."
                if len(op["content"]) > L.MAX_DOC_CHARS:
                    return f"{pos}: content is longer than {L.MAX_DOC_CHARS:,} characters; split it into topics."
            if act == "path_write":
                old = L.read_doc(proj, "path", name)
                if not L.patterns(op.get("paths")) and not (old and old["paths"]):
                    return (f"{pos}: paths is required for a new path note: glob patterns relative to the repository "
                            "root, such as [\"src/ppu/**\", \"*.sql\"].")
            if act == "topic_patch":
                doc = L.read_doc(proj, "topic", name)
                if doc is None:
                    return f"{pos}: there is no topic named {name}. Use topic_write to create it."
                old_text = op.get("old_text")
                n = doc["body"].count(old_text) if isinstance(old_text, str) and old_text else 0
                if n != 1:
                    return (f"{pos}: old_text occurs {n} times in topic {name}; it must occur exactly once. Read the "
                            "topic and copy the exact text.")
            if act in ("topic_remove", "path_remove"):
                kind = "topic" if act == "topic_remove" else "path"
                if L.read_doc(proj, kind, name) is None:
                    return f"{pos}: there is no {'topic' if kind == 'topic' else 'path note'} named {name}."
        except L.Bad as exc:
            return f"{pos}: {exc}"
    return None


def _apply_file_op(slug: str, op: dict) -> str:
    proj = project_dir(slug)
    act = op["action"]
    if act == "topic_write":
        r = L.write_doc(proj, "topic", op["topic"], op["content"], description=op.get("description"))
        return f"{'Created' if r['created'] else 'Rewrote'} topic {r['name']} ({r['size']:,} chars)."
    if act == "topic_append":
        r = L.append_doc(proj, op["topic"], op["content"], description=op.get("description"))
        return f"{'Created' if r['created'] else 'Appended to'} topic {r['name']} ({r['size']:,} chars)."
    if act == "topic_patch":
        r = L.patch_doc(proj, "topic", op["topic"], op.get("old_text"), op.get("content") or "")
        return f"Patched topic {r['name']}."
    if act == "topic_remove":
        L.remove_doc(proj, "topic", op["topic"])
        return f"Deleted topic {L.clean_name(op['topic'])}."
    if act == "path_write":
        r = L.write_doc(proj, "path", op["path_note"], op["content"], description=op.get("description"),
                        paths=op.get("paths"))
        _forget_path_note(L.clean_name(op["path_note"]))
        return f"{'Created' if r['created'] else 'Rewrote'} path note {r['name']}."
    if act == "path_remove":
        L.remove_doc(proj, "path", op["path_note"])
        return f"Deleted path note {L.clean_name(op['path_note'])}."
    raise L.Bad(f"unknown action {act}")


def _over_budget() -> bool:
    try:
        from tools.memory_tool_store import FAILURE_CLASS
        return FAILURE_CLASS.get() in ("over_budget", "retry_cap")
    except Exception:
        return False


def _usage(st, slug: str) -> tuple[int, int, int]:
    used = len(_delim().join(_raw_entries(slug)))
    limit = st.memory_char_limit
    return used, limit, (min(100, int(used * 100 / limit)) if limit > 0 else 0)


def _entry_after(st, op: dict) -> tuple[Optional[str], Optional[str]]:
    """``(entry selected now, its text after this replace or patch)``; Nones when it selects nothing."""
    entry = op.get("matched_entry")
    if entry is None:
        found = st.resolve_entry("memory", op.get("old_text") or "", op.get("action"))
        if not found.get("success"):
            return None, None
        entry = found["matched_entry"]
    if op.get("action") == "replace":
        return entry, (op.get("content") or "").strip()
    from tools.memory_tool_store import _patch_entry
    after, _msg, _cls = _patch_entry(entry, op.get("old_text") or "", op.get("content") or "")
    return entry, after


def _spill(slug: str, st, ops: list, apply_index, *, forced_only: bool) -> dict:
    """Write an index batch that does not fit (or adds with a ``topic``): each add's text, and each replace's or
    patch's resulting entry, goes into a topic (the one named, else the existing topic it fits best, else a new
    one) and the index gets a one-line pointer instead (none when the index already points to that topic). When
    even the pointers do not fit, the texts go to the inbox topic and only the deletions are applied."""
    proj = project_dir(slug)
    current = _raw_entries(slug)
    has_pointer = L.pointed(current)
    plan, moves, taken = [], [], set(L.names(proj, "topic"))
    for op in ops:
        act = op.get("action")
        spill = act == "add" and op.get("topic") or (not forced_only and act in ("add", "replace", "patch"))
        if not spill:
            plan.append(op)
            continue
        if act == "add":
            entry, text = None, (op.get("content") or "").strip()
        else:
            entry, text = _entry_after(st, op)
            if entry is None or not text:
                plan.append(op)  # let the store report the miss
                continue
        name = L.clean_name(op["topic"]) if op.get("topic") else (L.best_topic(proj, text) or L.name_for(text, taken))
        taken.add(name)
        line = L.pointer(L.summary(text, POINTER_SUMMARY), name)
        moves.append({"topic": name, "text": text, "entry": entry, "line": line, "new": name not in L.names(proj, "topic")})
        if act == "add":
            if name not in has_pointer:
                plan.append({"action": "add", "content": line})
                has_pointer.add(name)
        else:
            plan.append({"action": "replace", "old_text": entry, "content": line, "matched_entry": entry})
    fits = True
    if plan:
        dry = st.resolve_batch_entries("memory", plan)
        fits = bool(dry.get("success"))
        if not fits and (forced_only or not _over_budget()):
            return dry  # a miss, an ambiguous match or a refused text; or the caller retries with every text
    if fits:
        for m in moves:
            L.append_doc(proj, m["topic"], m["text"], heading=L.today())
        result = dict(apply_index(plan)) if plan else {"success": True, "message": "Saved in topics."}
        if not result.get("success"):
            return result
        result["moved_to_topics"] = [{"topic": m["topic"], "new_topic": m["new"], "index_line": m["line"]}
                                     for m in moves]
        used, limit, pct = _usage(st, slug)
        what = "; ".join(f"topic {m['topic']}{' (new)' if m['new'] else ''}" for m in moves)
        why = "as asked" if forced_only else f"because the index would have gone over {limit:,} chars"
        result["message"] = (f"Saved. The detail went to {what} {why}, and the index keeps a one-line pointer "
                             f"(index now {used:,}/{limit:,} chars). " + ("Merge or shorten older index lines "
                                                                          "when you can." if pct >= WARN_PCT else ""))
        return result
    # Even the pointers do not fit: keep every text in the inbox and apply only the deletions.
    for op in ops:
        act = op.get("action")
        if act in ("add", "replace", "patch"):
            entry, text = (None, (op.get("content") or "").strip()) if act == "add" else _entry_after(st, op)
            if not text:
                continue
            body = text + (f"\n\n(meant to replace the index line: {entry})" if entry else "")
            L.append_doc(proj, L.INBOX, body, heading=f"{L.today()} unsorted",
                         description="Notes saved while the index was full; sort them into topics")
    removes = [op for op in ops if op.get("action") == "remove"]
    result = dict(apply_index(removes)) if removes else {"success": True}
    if not result.get("success"):
        return result
    used, limit, _pct = _usage(st, slug)
    result["inbox"] = True
    result["message"] = (f"Saved to the inbox topic: the index is full ({used:,}/{limit:,} chars) and could not "
                         "take even a one-line pointer. The index needs cleanup now: merge or remove stale lines, "
                         "move detail into topics, then sort the inbox (project_memory action read topic=inbox).")
    return result


def write_ops(slug: str, st, operations: list, apply_index=None) -> dict:
    """Apply a batch: file operations first, then the index operations as one all-or-nothing batch, moving
    detail into topics when the index would overflow. ``apply_index`` runs an index batch (the store's own by
    default; Hermes's replay for a staged write)."""
    apply_index = apply_index or (lambda ops: st.apply_batch("memory", ops))
    why = _check_ops(slug, operations)
    if why:
        return {"success": False, "error": why + " Nothing was written."}
    notes_done = [_apply_file_op(slug, op) for op in operations if op.get("action") in FILE_ACTIONS]
    index_ops = [op for op in operations if op.get("action") in INDEX_ACTIONS]
    forced = [op for op in index_ops if op.get("action") == "add" and op.get("topic")]
    plain = [{k: v for k, v in op.items() if k in ("action", "content", "old_text", "matched_entry")}
             for op in index_ops]
    if not index_ops:
        result = {"success": True}
    elif forced:
        result = _spill(slug, st, index_ops, apply_index, forced_only=True)
        if not result.get("success") and _over_budget():
            result = _spill(slug, st, index_ops, apply_index, forced_only=False)
    else:
        result = dict(apply_index(plain))
        if not result.get("success") and _over_budget():
            result = _spill(slug, st, plain, apply_index, forced_only=False)
    result = dict(result)
    if notes_done:
        result["files"] = notes_done
        if result.get("success") and not index_ops:
            result["message"] = " ".join(notes_done)
        elif not result.get("success"):
            result["error"] = (str(result.get("error") or "") + " The file operations before it were applied: "
                               + " ".join(notes_done))
    if result.get("success"):
        used, limit, pct = _usage(st, slug)
        result["usage"] = f"{pct}%, {used:,}/{limit:,} chars"
        if pct >= WARN_PCT and not result.get("inbox"):
            result["warning"] = (f"The index is {pct}% full. Keep its lines short: merge or remove stale lines and "
                                 "move detail into topics (topic_write, then a short index line).")
    return result


def apply_pending(payload: dict, original) -> dict:
    """Replay a staged project write on its project, with Hermes's own replay rules for the index operations."""
    slug = payload.get("project")
    if not valid_slug(slug) or read_meta(slug) is None:
        return {"success": False, "error": f"The project of this pending write ({payload.get('project_identity') or slug}) "
                                           "no longer exists; nothing was applied. Reject it."}
    st = store(slug)
    ops = [op for op in payload.get("operations") or [] if isinstance(op, dict)]
    if all(op.get("action") in INDEX_ACTIONS and not op.get("topic") for op in ops):
        apply_index = lambda index_ops: original({**payload, "target": "memory", "operations": index_ops}, st)  # noqa: E731
        result = dict(apply_index(ops))
        if not result.get("success") and _over_budget():
            result = _spill(slug, st, ops, apply_index, forced_only=False)
        return result
    return write_ops(slug, st, ops, apply_index=lambda index_ops: original(
        {**payload, "target": "memory", "operations": index_ops}, st))


def install_pending_replay() -> None:
    """Route staged project writes in Hermes's memory approval replay to their project, once."""
    try:
        from tools import memory_tool
    except Exception:
        return
    original = memory_tool.apply_memory_pending
    if getattr(original, "_project_memory", False):
        return

    def apply_memory_pending(payload, store):
        if isinstance(payload, dict) and payload.get("target") == PENDING_TARGET:
            return apply_pending(payload, original)
        return original(payload, store)

    apply_memory_pending._project_memory = True
    apply_memory_pending.__doc__ = original.__doc__
    memory_tool.apply_memory_pending = apply_memory_pending


def _files_listing(slug: str) -> dict:
    proj = project_dir(slug)
    pointed = L.pointed(_raw_entries(slug))
    topics = [{**t, "in_index": t["name"] in pointed} for t in L.list_docs(proj, "topic")]
    return {"topics": topics, "path_notes": L.list_docs(proj, "path"), "inbox": L.inbox_count(proj)}


def _read(slug: str, meta: dict, st, args: dict) -> dict:
    project = meta.get("identity", slug)
    proj = project_dir(slug)
    for key, kind, label in (("topic", "topic", "topic"), ("path_note", "path", "path note")):
        if args.get(key):
            try:
                name = L.clean_name(args[key])
            except L.Bad as exc:
                return {"success": False, "error": str(exc)}
            doc = L.read_doc(proj, kind, name)
            if doc is None:
                have = L.names(proj, kind)
                close = [n for n in have if name in n or n in name or L.words(n.replace("-", " ")) & L.words(name.replace("-", " "))]
                return {"success": False, "error": f"There is no {label} named {name}.",
                        **({"closest": close[:10]} if close else {}), f"{kind}s": have[:200]}
            out = {"success": True, "project": project, label.replace(" ", "_"): name,
                   "description": doc["description"], "modified": doc["modified"]}
            if kind == "path":
                out["paths"] = doc["paths"]
            out.update(L.page(doc["body"], args.get("offset"), args.get("limit")))
            return out
    if args.get("query"):
        query = str(args["query"])[:200]
        hits = L.search(proj, _raw_entries(slug), query)
        return {"success": True, "project": project, "query": query, "matches": hits,
                **({} if hits else {"note": "Nothing matches every word. Try fewer or other words."})}
    items = entries(slug)
    used = len(_delim().join(items))
    out = {"success": True, "project": project, "aliases": meta.get("aliases") or [], "entries": items,
           "usage": f"{used:,}/{st.memory_char_limit:,} chars", **_files_listing(slug)}
    if args.get("action") == "list":
        out.pop("entries")
    return out


def handle(args: Any, **kwargs) -> str:
    """The project_memory tool."""
    args = args if isinstance(args, dict) else {}
    session_id = kwargs.get("session_id") or ""
    if not session_id:
        core = device_core()
        session_id = core.current_session_id() if core is not None else ""
    action = args.get("action") or ("write" if args.get("operations") else "read")
    if action not in ("read", "list", "write"):
        return _tool_error(f"Unknown action {action!r}. Use read, list, or write with operations.")
    operations = args.get("operations")
    if action == "write":
        if not isinstance(operations, list) or not operations or not all(isinstance(o, dict) for o in operations):
            return _tool_error("write needs operations: a list of {action, ...}; a single change is a one-item list.")
        if any(o.get("action") not in ALL_ACTIONS for o in operations):
            return _tool_error("Each operation's action must be one of: " + ", ".join(ALL_ACTIONS) + ".")
        if children_blocked() and is_child(session_id):
            return _tool_error("Subagents may not write project memory, as they may not write memory. Report the "
                               "fact in your result; the parent agent can save it.")
    slug, why = project_for_session(session_id, live=False)
    if slug is None:
        return _tool_error(why)
    ensure_layout(slug)
    meta = read_meta(slug) or {}
    project = meta.get("identity", slug)
    st = session_store(session_id, slug)
    if action != "write":
        return json.dumps(_read(slug, meta, st, {**args, "action": action}), ensure_ascii=False)
    try:
        from tools.memory_tool_store import FAILURE_CLASS
        token = FAILURE_CLASS.set("other")
    except Exception:
        FAILURE_CLASS, token = None, None
    try:
        held = _gate(st, slug, project, operations)
        if held is not None:
            return json.dumps(held, ensure_ascii=False)
        result = write_ops(slug, st, operations)
    except L.Bad as exc:
        result = {"success": False, "error": str(exc)}
    finally:
        if FAILURE_CLASS is not None:
            FAILURE_CLASS.reset(token)
    result = dict(result)
    result.pop("target", None)
    result["project"] = project
    return json.dumps(result, ensure_ascii=False)


SCHEMA = {
    "name": TOOL,
    "description": (
        "Notes for the project this chat works in: the git repository of the chat's bound device folder (every "
        "clone, worktree and mirror of it shares one memory). Three parts:\n"
        "- the INDEX: short lines, one fact each (under about 200 chars), shown in the system prompt of every chat "
        "in this project; it has a char budget.\n"
        "- TOPICS: named markdown files for the detail behind the index, any number and any length; only their "
        "names are in the prompt. Read one with action 'read' and topic=<name> when a task needs it.\n"
        "- PATH NOTES: rules for one folder or file type, with glob 'paths' relative to the repository root; one is "
        "added to a tool result the first time in a chat that you read or edit a matching file.\n\n"
        "PREFER THIS over memory for anything about the project: its code, rules, conventions, decisions, people "
        "involved, current state. Use memory only for facts about the user or rules that apply in every project. "
        "Procedures (how to build, release, debug something here) belong in project skills (skill_manage "
        "scope='project'), not here.\n\n"
        "WRITE: action 'write' with 'operations'. Index: add, patch (old_text span -> content), replace (whole entry "
        "matching old_text), remove; add with 'topic' puts the content in that topic and a one-line pointer in the "
        "index. Topics: topic_write (whole text, optional description), topic_append, topic_patch (old_text -> "
        "content), topic_remove. Path notes: path_write (path_note, paths, content), path_remove. Writes never fail "
        "for size: when the index would overflow, the detail moves into a topic and the index keeps a pointer, and "
        "the result says where it went. Keep index lines short; when the result warns that the index is 80% full, "
        "merge or remove stale lines and move detail into topics.\n\n"
        "READ: 'read' gives the index, the topics and the path notes; topic=<name> or path_note=<name> reads one "
        "(long ones in pages: offset); query=<words> searches the index, topics and path notes. 'list' lists the "
        "topics and path notes.\n\n"
        "Works only in chats bound to a project folder (/device <device> <dir>); elsewhere it refuses. "
        "SKIP: trivial or easily re-discovered facts, task progress, temporary TODO state."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["read", "list", "write"],
                       "description": "'read' the index (or one topic, path note or search), 'list' the topics and "
                                      "path notes, 'write' applies operations."},
            "topic": {"type": "string", "description": "For 'read': the topic to read."},
            "path_note": {"type": "string", "description": "For 'read': the path note to read."},
            "query": {"type": "string", "description": "For 'read': words to find in the index, topics and path notes."},
            "offset": {"type": "integer", "description": "For reading a long topic: the character to start at."},
            "operations": {
                "type": "array",
                "description": "For 'write': changes in order; the index operations apply as one all-or-nothing "
                               "batch after the topic and path note operations.",
                "items": {
                    "type": "object",
                    "properties": {
                        "action": {"type": "string", "enum": list(ALL_ACTIONS)},
                        "content": {"type": "string",
                                    "description": "add: the new index line (or, with topic, the detail); replace: "
                                                   "the whole new entry; patch and topic_patch: the text that replaces "
                                                   "old_text; topic_write and path_write: the whole text; "
                                                   "topic_append: the text to add."},
                        "old_text": {"type": "string",
                                     "description": "patch, replace, remove: text from one index entry; topic_patch: "
                                                    "the exact text to replace, occurring once."},
                        "topic": {"type": "string",
                                  "description": "Topic name (lowercase letters, digits, dashes) for the topic_* "
                                                 "actions, or for add to put the content in that topic."},
                        "description": {"type": "string",
                                        "description": "topic_write, topic_append, path_write: one line saying what "
                                                       "is in it."},
                        "path_note": {"type": "string", "description": "Path note name for path_write and path_remove."},
                        "paths": {"type": "array", "items": {"type": "string"},
                                  "description": "path_write: glob patterns relative to the repository root, such as "
                                                 "src/ppu/** or *.sql (a pattern without a slash matches at any depth)."},
                    },
                    "required": ["action"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["action"],
    },
}


def offered() -> bool:
    """check_fn: the built-in memory store is on and the device plugin is loaded."""
    if device_core() is None:
        return False
    try:
        from tools.memory_tool import get_builtin_memory_store_flags
        return bool(get_builtin_memory_store_flags()[0])
    except Exception:
        return True


def extend_memory_schema() -> None:
    """Add the project rule to the built-in memory tool's description, once."""
    try:
        from tools import memory_tool
    except Exception:
        return
    desc = memory_tool.MEMORY_SCHEMA.get("description", "")
    if MEMORY_TOOL_NOTE.strip() not in desc:
        memory_tool.MEMORY_SCHEMA["description"] = desc + MEMORY_TOOL_NOTE


# --- path notes ---------------------------------------------------------------------------------------

PATH_TOOLS = ("read_file", "write_file", "patch")
# The most characters of path notes added to one tool result; the rest are named, to read with the tool.
PATH_NOTE_BUDGET = 6000
_V4A_FILE = re.compile(r"^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$", re.M)
_LOADED: dict[str, set[str]] = {}
_LOADED_LOCK = threading.Lock()


def _forget_path_note(name: str) -> None:
    """A rewritten path note loads again in chats that already saw it."""
    with _LOADED_LOCK:
        for seen in _LOADED.values():
            seen.discard(name)


def _tool_paths(tool_name: str, args: dict) -> list[str]:
    path = args.get("path")
    if isinstance(path, str) and path.strip():
        return [path.strip()]
    if tool_name == "patch" and isinstance(args.get("patch"), str):
        return [m.group(1).strip() for m in _V4A_FILE.finditer(args["patch"])]
    return []


def _relative(path: str, top: str, base: str) -> Optional[str]:
    """``path`` relative to the repository top, or None when it is outside it (or not a plain device path)."""
    if path.startswith("~") or "\\" in path:
        return None
    full = posixpath.normpath(path if path.startswith("/") else posixpath.join(base, path))
    top = posixpath.normpath(top)
    if full == top or not full.startswith(top.rstrip("/") + "/"):
        return None
    return full[len(top.rstrip("/")) + 1:]


def _session_project_cached(session_id: str):
    """``(slug, top, dir)`` of the session's project from what is known, without a device probe; None when not
    known yet."""
    binding, _why = binding_of(session_id)
    if binding is None:
        return None
    slug = _SESSION_CACHE.get((binding.session_id, binding.generation)) or cached_folder(binding.device_id, binding.dir)
    if slug is None:
        return None
    return slug, repo_top(binding.device_id, binding.dir), binding.dir


def path_notes_for(session_id: str, slug: str, top: str, base: str, tool_name: str, args: dict) -> str:
    """The path notes to add to a tool result: each matching note not yet seen in this session, up to
    PATH_NOTE_BUDGET chars, then the names of the others. Marks them seen."""
    proj = project_dir(slug)
    if not L.names(proj, "path"):
        return ""
    rels = [r for r in (_relative(p, top, base) for p in _tool_paths(tool_name, args)) if r]
    if not rels:
        return ""
    with _LOADED_LOCK:
        if len(_LOADED) >= MAX_CACHE:
            _LOADED.clear()
        seen = _LOADED.setdefault(session_id, set())
        found: list[tuple[str, dict]] = []
        for rel in rels:
            for doc in L.matching_notes(proj, rel):
                if doc["name"] not in seen and all(doc["name"] != d["name"] for _r, d in found):
                    found.append((rel, doc))
        for _rel, doc in found:
            seen.add(doc["name"])
    if not found:
        return ""
    parts, used, more = [], 0, []
    for rel, doc in found:
        head = (f"[Project path note {doc['name']} (paths {', '.join(doc['paths'])}), loaded because this touched "
                f"{rel}. It loads once per chat; read it again with project_memory action read path_note={doc['name']}.]\n")
        room = PATH_NOTE_BUDGET - used - len(head)
        body = _sanitize(doc["body"].strip())
        if room >= len(body):
            parts.append(head + body)
            used += len(head) + len(body)
        elif not parts and room > 500:
            cut = body[:room - 200]
            parts.append(head + cut + f"\n[Only the start of this path note is shown. Read the rest with project_memory "
                                      f"action read path_note={doc['name']} offset={len(cut)}.]")
            used = PATH_NOTE_BUDGET
        else:
            more.append(doc["name"])
    if more:
        parts.append(f"[Other project path notes match too: {', '.join(more)}. Read them with project_memory action "
                     "read path_note=<name>.]")
    return "\n\n".join(parts)


def _failed(result: str) -> bool:
    """A tool result that reports an error; path notes wait for a call that worked."""
    if not result.lstrip().startswith("{"):
        return False
    try:
        doc = json.loads(result)
    except ValueError:
        return False
    return isinstance(doc, dict) and bool(doc.get("error")) and doc.get("success") is not True


def on_tool_result(tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "",
                   **_kwargs) -> Optional[str]:
    """transform_tool_result hook: add matching path notes to a file tool's result. Never raises; never probes."""
    if tool_name not in PATH_TOOLS or not isinstance(result, str) or not isinstance(args, dict) or not session_id:
        return None
    try:
        if _failed(result) or not offered():
            return None
        known = _session_project_cached(session_id)
        if known is None:
            return None
        slug, top, base = known
        text = path_notes_for(session_id, slug, top, base, tool_name, args)
    except Exception as exc:
        logger.warning("project-memory: path notes for %s failed: %s", tool_name, type(exc).__name__)
        return None
    return (result + "\n\n" + text) if text else None


# --- hub routes ---------------------------------------------------------------------------------------

def project_json(slug: str, meta: dict, limit: int) -> dict:
    items = entries(slug)
    proj = project_dir(slug)
    topics, paths = L.list_docs(proj, "topic"), L.list_docs(proj, "path")
    used = len(_delim().join(items))
    folders = []
    for f in meta.get("folders") or []:
        if isinstance(f, dict) and isinstance(f.get("dir"), str):
            folders.append({"device_id": str(f.get("device_id") or ""),
                            "device": str(f.get("device") or f.get("device_id") or ""),
                            "dir": f["dir"], "seen_at": float(f.get("seen_at") or 0)})
    root = meta.get("root_commit")
    return {"id": slug, "identity": meta["identity"], "kind": meta.get("kind") or KIND_REMOTE,
            "name": str(meta.get("name") or slug),
            "aliases": [a for a in meta.get("aliases") or [] if isinstance(a, str)],
            "root_commit": root if isinstance(root, str) and SHA_RE.fullmatch(root) else "",
            "folders": folders, "skills": skill_count(slug), "count": len(items), "used": used, "limit": limit,
            "topics": len(topics), "path_notes": len(paths), "inbox": L.inbox_count(proj),
            "total": used + sum(t["size"] for t in topics) + sum(x["size"] for x in paths)}


def list_projects() -> dict:
    limit = char_limit()
    projects = [project_json(slug, meta, limit) for slug, meta in _all_metas().items()]
    projects.sort(key=lambda p: (p["name"].lower(), p["identity"]))
    return {"projects": projects}


def _meta_or_404(slug: str) -> dict:
    meta = read_meta(slug)
    if meta is None:
        raise Refused(404, "unknown_project", "There is no such project memory.")
    return meta


def notes(slug: str) -> dict:
    """One project's notes in the shape of the device plugin's GET /memory, plus ``project``."""
    meta = _meta_or_404(slug)
    limit = char_limit()
    items = entries(slug)
    return {"approval": False, "pending": [], "project": project_json(slug, meta, limit),
            "targets": {"memory": {"file": str(memory_path(slug)), "limit": limit,
                                   "used": len(_delim().join(items)), "enabled": True, "entries": items},
                        "user": {"file": "", "limit": 0, "used": 0, "enabled": False, "entries": []}},
            **_files_listing(slug)}


# --- project skills routes ---------------------------------------------------------------------------

SKILL_FILE = "SKILL.md"
MAX_SKILL_VIEW = 200_000


def _frontmatter(text: str) -> dict[str, str]:
    """The ``name`` and ``description`` of a SKILL.md front matter; empty strings when it has none."""
    out = {"name": "", "description": ""}
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return out
    block = []
    for line in lines[1:]:
        if line.strip() == "---":
            break
        block.append(line)
    try:
        import yaml
        doc = yaml.safe_load("\n".join(block))
    except Exception:
        doc = None
    if not isinstance(doc, dict):  # no PyYAML, or unreadable YAML: take the one-line scalars
        doc = {}
        for line in block:
            key, sep, value = line.partition(":")
            if sep and key in out and not line[:1].isspace():
                doc[key] = value.strip().strip("\"'")
    if isinstance(doc, dict):
        for key in out:
            if isinstance(doc.get(key), str):
                out[key] = " ".join(doc[key].split())
    return out


def _disabled_skills() -> set[str]:
    cfg = _config()
    skills = cfg.get("skills") if isinstance(cfg.get("skills"), dict) else {}
    disabled = skills.get("disabled")
    return {str(n) for n in disabled} if isinstance(disabled, list) else set()


def _project_skills(slug: str) -> list[dict]:
    """Each skill under the project's skills dir: its name, the folder it sits in, its description, whether it
    is on (Hermes keeps one off-list of skill names for global and project skills alike)."""
    root = skills_dir(slug)
    if root is None or not root.is_dir():
        return []
    off = _disabled_skills()
    found = []
    try:
        mds = sorted(root.rglob(SKILL_FILE))
    except OSError:
        return []
    for md in mds:
        rel = md.parent.relative_to(root)
        if md.is_symlink() or any(part.startswith(".") for part in rel.parts) or not rel.parts:
            continue
        try:
            head = _frontmatter(md.read_text(encoding="utf-8", errors="replace")[:20000])
        except OSError:
            continue
        name = head["name"] or rel.name
        found.append({"name": name, "path": rel.as_posix(), "description": head["description"],
                      "enabled": name not in off})
    found.sort(key=lambda s: (s["name"].lower(), s["path"]))
    return found


def project_skills(slug: str) -> dict:
    meta = _meta_or_404(slug)
    return {"project": {"id": slug, "identity": meta["identity"], "name": str(meta.get("name") or slug)},
            "skills": _project_skills(slug)}


def _skill_dir(slug: str, name: Any) -> tuple[Path, dict]:
    _meta_or_404(slug)
    if not isinstance(name, str) or not name.strip():
        raise Refused(400, "bad_request", "the skill name must not be empty")
    for s in _project_skills(slug):
        if name in (s["name"], s["path"]):
            root = skills_dir(slug)
            path = (root / s["path"]).resolve()
            if root.resolve() not in path.parents:
                break
            return path, s
    raise Refused(404, "unknown_skill", "This project has no such skill.")


def project_skill(slug: str, name: Any) -> dict:
    """One project skill with its SKILL.md text (cut at MAX_SKILL_VIEW characters) and the other files in it."""
    path, s = _skill_dir(slug, name)
    try:
        text = (path / SKILL_FILE).read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise Refused(404, "unknown_skill", "This project has no such skill.")
    files = sorted(p.relative_to(path).as_posix() for p in path.rglob("*")
                   if p.is_file() and p.name != SKILL_FILE and not p.is_symlink())[:50]
    return {**s, "content": text[:MAX_SKILL_VIEW], "truncated": len(text) > MAX_SKILL_VIEW, "files": files}


def delete_project_skill(slug: str, name: Any) -> dict:
    """Delete a project skill's folder (and the category folder it leaves empty); answer with the project's skills."""
    import shutil
    path, _s = _skill_dir(slug, name)
    root = skills_dir(slug).resolve()
    with _LOCK:
        shutil.rmtree(path)
        parent = path.parent
        while parent != root and root in parent.parents:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    try:
        from agent.prompt_builder import clear_skills_system_prompt_cache
        clear_skills_system_prompt_cache(clear_snapshot=True)
    except Exception:
        pass
    return project_skills(slug)


def _check_text(*texts: Any) -> None:
    for t in texts:
        if not isinstance(t, str) or not t.strip():
            raise Refused(400, "bad_request", "the text must not be empty")
        if len(t) > MAX_TEXT:
            raise Refused(413, "too_large", "the text is too long")


def _failure(failure: str, limit: int, error: str) -> tuple[int, str, str]:
    if failure in {"over_budget", "retry_cap"}:
        return 409, "over_limit", (f"That would put this project's notes over their limit of {limit:,} characters. "
                                   "Shorten or delete a note first.")
    if failure in {"stale_entry", "no_match", "ambiguous"}:
        return 409, "changed", "The project's notes changed since you opened them. Reload and try again."
    if failure == "scan_blocked":
        return 422, "blocked", f"Hermes refused this text: {error}"
    if failure == "would_empty":
        return 409, "would_empty", "The notes cannot be emptied in one edit. Delete the last notes one at a time."
    return 409, failure or "refused", error or "Hermes did not accept that change"


def _apply(slug: str, call) -> dict:
    from tools.memory_tool_store import FAILURE_CLASS
    st = store(slug)
    token = FAILURE_CLASS.set("other")
    try:
        result = call(st)
        failure = FAILURE_CLASS.get()
    finally:
        FAILURE_CLASS.reset(token)
    if not result.get("success"):
        raise Refused(*_failure(failure, st.memory_char_limit, str(result.get("error") or "")))
    return notes(slug)


def _apply_spilling(slug: str, ops: list) -> dict:
    """An index change from the hub that moves detail into a topic when the index is full, as the tool does;
    the answer carries ``message`` saying where it went."""
    from tools.memory_tool_store import FAILURE_CLASS
    st = store(slug)
    token = FAILURE_CLASS.set("other")
    try:
        result = write_ops(slug, st, ops)
        failure = FAILURE_CLASS.get()
    finally:
        FAILURE_CLASS.reset(token)
    if not result.get("success"):
        raise Refused(*_failure(failure, st.memory_char_limit, str(result.get("error") or "")))
    out = notes(slug)
    if result.get("moved_to_topics") or result.get("inbox"):
        out["message"] = _hub_message(result)
    return out


def _hub_message(result: dict) -> str:
    if result.get("inbox"):
        return ("The index is full, so this was saved in the inbox topic. Shorten or delete some index lines, then "
                "sort the inbox.")
    moved = result.get("moved_to_topics") or []
    names = ", ".join(m["topic"] + (" (new)" if m.get("new_topic") else "") for m in moved)
    return f"The index was full, so the text went to topic {names} and the index got a one-line pointer."


def add(slug: str, content: Any) -> dict:
    _meta_or_404(slug)
    _check_text(content)
    return _apply_spilling(slug, [{"action": "add", "content": content.strip()}])


def edit(slug: str, entry: Any, content: Any) -> dict:
    _meta_or_404(slug)
    _check_text(entry, content)
    if content.strip() == entry.strip():
        return notes(slug)
    return _apply_spilling(slug, [{"action": "replace", "old_text": entry, "content": content.strip(),
                                   "matched_entry": entry}])


# --- topics and path notes routes ----------------------------------------------------------------------

def _kind(kind: str) -> str:
    if kind not in ("topic", "path"):
        raise Refused(404, "not_found", "unknown kind")
    return kind


def _doc_or_404(slug: str, kind: str, name: Any) -> dict:
    doc = L.read_doc(project_dir(slug), kind, name) if isinstance(name, str) else None
    if doc is None:
        raise Refused(404, "unknown_" + kind, f"This project has no such {'topic' if kind == 'topic' else 'path note'}.")
    return doc


def docs(slug: str, kind: str) -> dict:
    """The topics (``kind`` topic) or path notes (``path``) of a project, without their text."""
    _meta_or_404(slug)
    listing = _files_listing(slug)
    return {"items": listing["topics"] if _kind(kind) == "topic" else listing["path_notes"], "inbox": listing["inbox"]}


def doc(slug: str, kind: str, name: Any) -> dict:
    """One topic or path note with its text (cut at MAX_SKILL_VIEW characters)."""
    _meta_or_404(slug)
    d = _doc_or_404(slug, _kind(kind), name)
    body = d.pop("body")
    return {**d, "content": body[:MAX_SKILL_VIEW], "truncated": len(body) > MAX_SKILL_VIEW}


def put_doc(slug: str, kind: str, name: Any, body: dict) -> dict:
    """Create or change a topic or path note from the hub: ``content``, and ``description``, ``paths`` (path
    notes), ``name`` (a new name); ``base`` (the text the editor started from) refuses a change made meanwhile."""
    _meta_or_404(slug)
    _kind(kind)
    content = body.get("content")
    _check_text(content)
    proj = project_dir(slug)
    try:
        name = L.clean_name(name)
        new = L.clean_name(body["name"]) if body.get("name") else name
        old = L.read_doc(proj, kind, name)
        if body.get("create") and old is not None:
            raise Refused(409, "exists", f"There is already a {'topic' if kind == 'topic' else 'path note'} named {name}.")
        base = body.get("base")
        if old is not None and isinstance(base, str) and base.strip() != old["body"].strip():
            raise Refused(409, "changed", "This changed since you opened it. Reload and try again.")
        if old is None and body.get("base") is not None:
            raise Refused(409, "changed", "This was deleted since you opened it. Reload and try again.")
        with _LOCK:
            if new != name and old is not None:
                L.rename_doc(proj, kind, name, new)
            L.write_doc(proj, kind, new, content, description=body.get("description"),
                        paths=body.get("paths") if kind == "path" else None)
    except L.Bad as exc:
        raise Refused(400, "bad_request", str(exc))
    if kind == "path":
        _forget_path_note(new)
    return {**doc(slug, kind, new), "list": docs(slug, kind)["items"]}


def delete_doc(slug: str, kind: str, name: Any) -> dict:
    _meta_or_404(slug)
    _doc_or_404(slug, _kind(kind), name)
    L.remove_doc(project_dir(slug), kind, name)
    return docs(slug, kind)


def remove(slug: str, entry: Any) -> dict:
    _meta_or_404(slug)
    _check_text(entry)
    return _apply(slug, lambda st: st.remove("memory", entry, entry))


def parse_text(text: str) -> list[str]:
    """Entries of a whole-file edit: lines that hold only § separate entries."""
    out, cur = [], []
    for line in text.replace("\r\n", "\n").split("\n"):
        if line.strip() == "§":
            out.append("\n".join(cur).strip())
            cur = []
        else:
            cur.append(line)
    out.append("\n".join(cur).strip())
    return list(dict.fromkeys(e for e in out if e))


def replace_all(slug: str, text: Any, base: Any) -> dict:
    """A whole-file edit as one all-or-nothing batch, with the device plugin's rules: entries of ``base`` that
    the text no longer has are removed (pinned), new ones are added, and a meanwhile change fails as changed."""
    _meta_or_404(slug)
    if not isinstance(text, str) or len(text) > MAX_TEXT:
        raise Refused(413 if isinstance(text, str) else 400, "bad_request", "the text is too long or missing")
    if not isinstance(base, list) or not all(isinstance(e, str) for e in base) or len(base) > 10000:
        raise Refused(400, "bad_request", 'the body must have "base", the list of entries the editor showed')
    current, new = entries(slug), parse_text(text)
    base = [e.strip() for e in base if e.strip()]
    gone = [e for e in base if e not in new]
    ops: list[dict[str, Any]] = [{"action": "remove", "old_text": e, "matched_entry": e} for e in gone]
    ops += [{"action": "add", "content": e} for e in new if e not in base]
    if not ops:
        return notes(slug)
    if current and not new and set(current) <= set(gone):
        raise Refused(*_failure("would_empty", char_limit(), ""))
    return _apply(slug, lambda st: st.apply_batch("memory", ops))


def pending() -> dict:
    """The staged project writes in Hermes's memory approval queue, with their project, for the hub to show next
    to the global pending writes."""
    from tools import write_approval as wa
    out = []
    for rec in wa.list_pending(wa.MEMORY):
        payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
        if payload.get("target") != PENDING_TARGET:
            continue
        slug = payload.get("project")
        meta = read_meta(slug) if valid_slug(slug) else None
        out.append({"id": str(rec.get("id") or ""), "project": slug if isinstance(slug, str) else "",
                    "identity": (meta or {}).get("identity") or str(payload.get("project_identity") or slug or "")})
    return {"pending": out}
