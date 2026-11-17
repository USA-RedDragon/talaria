"""File offers: the ``send_file`` tool offers the user a file from the machine the chat runs on (a
paired computer, the sandbox or the Hermes server), and the hub streams it through the routes
``/sessions/{sid}/files/stat`` and ``/sessions/{sid}/files/stream`` (docs/protocol.md section 9.3).

On a device with the ``file_read`` capability the plugin asks for facts with ``file_stat`` and reads
in windows with ``file_read``, whose bytes come back as binary frames that start with the request
id (section 4). An older device falls back to the base64 shell read of ``get_session_file`` (files up
to 32 MiB). A chat that runs on the Hermes server reads the gateway's own file system.

Secret files (credential paths, ``.env`` files, key files, and on the server also /proc, /sys, /dev
and mounted secrets) are offered only when the user asked for that exact file in their own words,
and read only through the offer that recorded it.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import logging
import os
import posixpath
import queue
import re
import secrets
import stat
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger("hermes_device")

TOOLSET = "device-agents"
EMOJI = "\U0001f4ce"
# The bytes of one file_read and how many run at once for one stream: at most 8 MiB in flight.
WINDOW = 4 * 1024 * 1024
OUTSTANDING = 2
HEAD_BYTES = 4096
STAT_TIMEOUT_S = 30.0
# A window that gets no frame and no result for this long ends the stream.
WINDOW_IDLE_S = 60.0
# The device runs at most 4 file operations at once per leg and answers more with failed "busy".
BUSY_RETRY_S = 0.2
BUSY_RETRIES = 50
MAX_OFFERS = 5000
MAX_STREAMS = 8
MAX_NOTE = 1000
LOCAL_CHUNK = 256 * 1024
OFFER_RE = re.compile(r"fo_[0-9a-f]{16}")
# Server paths that are secret whatever the home rules say.
SERVER_SECRET_ROOTS = ("/proc", "/sys", "/dev", "/run/secrets", "/var/run/secrets")
SECRET_REASON = "looks like a secret"
_HOME_PROBE = "/__hermes_device_hermes_home__"


def _core():
    return sys.modules["hermes_device_core"]


def _refused(message: str, *, secret: bool = False, status: int = 422, code: str = "read_refused"):
    exc = _core().BindError(status, code, message)
    exc.secret = secret
    return exc


# --- device operations ---------------------------------------------------------------------------

class FileOp:
    """One file_stat or file_read waiting for its frames and file_result. With ``loop`` the items go
    to an asyncio queue on that loop, else to a thread queue."""

    def __init__(self, conn: Any, loop: Optional[asyncio.AbstractEventLoop] = None):
        self.conn, self.loop = conn, loop
        self.id = uuid.uuid4().hex
        self.q: Any = asyncio.Queue() if loop is not None else queue.Queue()

    def put(self, item: tuple) -> None:
        if self.loop is None:
            self.q.put(item)
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.q.put_nowait(item)
            return
        try:
            self.loop.call_soon_threadsafe(self.q.put_nowait, item)
        except RuntimeError:
            logger.debug("device: file op %s lost its loop", self.id)


def _register(conn: Any, loop: Optional[asyncio.AbstractEventLoop] = None) -> FileOp:
    op = FileOp(conn, loop)
    with conn.lock:
        conn.file_ops[op.id] = op
    return op


def _forget(op: FileOp) -> bool:
    """Drop ``op``; True when it was still waiting (so a kill makes sense)."""
    with op.conn.lock:
        return op.conn.file_ops.pop(op.id, None) is not None


def on_result(conn: Any, msg: dict) -> None:
    """A file_result from the device (Hub.on_message): finishes its op."""
    rid = msg.get("id")
    if not isinstance(rid, str):
        return
    with conn.lock:
        op = conn.file_ops.pop(rid, None)
    if op is not None:
        op.put(("result", msg))


def on_frame(conn: Any, data: bytes) -> None:
    """A binary frame from the device: the 32 ASCII id bytes, then file bytes."""
    core = _core()
    if len(data) < core.FILE_ID_LEN:
        return
    rid = bytes(data[:core.FILE_ID_LEN]).decode("ascii", "replace")
    with conn.lock:
        op = conn.file_ops.get(rid)
    if op is not None:
        op.put(("frame", bytes(data[core.FILE_ID_LEN:])))


def fail_all(conn: Any, why: str) -> None:
    with conn.lock:
        ops = list(conn.file_ops.values())
        conn.file_ops.clear()
    for op in ops:
        op.put(("result", {"ok": False, "code": "lost", "error": why}))


def _kill_soon(conn: Any, rid: str) -> None:
    """Send a kill for ``rid`` without waiting, from any thread."""
    text = json.dumps({"type": _core().TYPE_KILL, "id": rid})
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    try:
        if running is conn.loop:
            task = conn.loop.create_task(conn.send_text(text))
            task.add_done_callback(lambda t: t.cancelled() or t.exception())
        else:
            asyncio.run_coroutine_threadsafe(conn.send_text(text), conn.loop)
    except Exception:
        logger.debug("device: kill of file op %s not sent", rid, exc_info=True)


async def _asend(conn: Any, msg: dict) -> None:
    core = _core()
    coro = conn.send_text(json.dumps(msg))
    if asyncio.get_running_loop() is conn.loop:
        await asyncio.wait_for(coro, core.SEND_TIMEOUT_S)
    else:
        await asyncio.wait_for(asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, conn.loop)),
                               core.SEND_TIMEOUT_S)


def _busy(msg: dict) -> bool:
    return msg.get("code") == _core().FILE_FAILED and "busy" in str(msg.get("error") or "").lower()


def _result_error(conn: Any, path: str, msg: dict):
    """The BindError for a file_result that is not ok. Messages never hold device output."""
    core = _core()
    code = msg.get("code") if isinstance(msg.get("code"), str) else core.FILE_FAILED
    where = f"device {conn.name}"
    if code == core.FILE_NOT_FOUND:
        return core.BindError(404, "not_found", f"{path} does not exist on {where}")
    if code == core.FILE_NOT_REGULAR:
        return _refused(f"{path} is not a regular file")
    if code == core.FILE_REFUSED:
        return _refused(f"{where} refused {path}: it is outside its roots, a symbolic link, or has more than "
                        f"one hard link")
    if code == core.FILE_CHANGED:
        return core.BindError(412, "changed", f"{path} changed since it was offered")
    if code == "lost":
        return core.BindError(409, "device_offline", f"{where} disconnected")
    if code == core.FILE_CANCELLED:
        return core.BindError(422, "read_failed", f"the read of {path} was cancelled")
    return core.BindError(422, "read_failed", f"{where} could not read {path}")


@dataclass
class Facts:
    """What a stat found: the path asked for, its real path and its identity."""

    path: str
    real: str
    size: int
    mtime_ns: int
    dev: int = 0
    ino: int = 0
    head: bytes = b""
    # An older device read with the base64 shell read: the whole file, and a digest for the etag.
    raw: Optional[bytes] = None
    digest: str = ""

    @property
    def mtime(self) -> float:
        return self.mtime_ns / 1e9

    @property
    def etag(self) -> str:
        if self.raw is not None:
            return f'"{self.size:x}-0-{self.digest}"'
        return f'"{self.size:x}-{self.mtime_ns:x}-{self.ino:x}"'


def _int(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def device_stat(conn: Any, path: str, timeout: float = STAT_TIMEOUT_S) -> Facts:
    """file_stat on the device. Call from a worker thread. Raises BindError."""
    core = _core()
    for _ in range(BUSY_RETRIES + 1):
        op = _register(conn)
        try:
            conn.send({"type": core.TYPE_FILE_STAT, "id": op.id, "path": path})
        except Exception as exc:
            _forget(op)
            raise core.BindError(409, "device_offline", f"could not reach device {conn.name}: {exc}") from exc
        try:
            _kind, msg = op.q.get(timeout=timeout)
        except queue.Empty:
            if _forget(op):
                _kill_soon(conn, op.id)
            raise core.BindError(422, "read_failed", f"device {conn.name} did not answer in {timeout:g}s") from None
        if msg.get("ok") is True:
            return _facts(conn, path, msg.get("result"))
        if not _busy(msg):
            raise _result_error(conn, path, msg)
        time.sleep(BUSY_RETRY_S)
    raise core.BindError(429, "busy", f"device {conn.name} is busy with other file reads; try again in a moment")


def _facts(conn: Any, path: str, result: Any) -> Facts:
    core = _core()
    bad = core.BindError(422, "read_failed", f"device {conn.name} sent an unreadable answer for {path}")
    if not isinstance(result, dict):
        raise bad
    real = result.get("real")
    nums = [_int(result.get(k)) for k in ("size", "mtime_ns", "dev", "ino")]
    if not isinstance(real, str) or not real.startswith("/") or posixpath.normpath(real) != real \
            or any(n is None for n in nums):
        raise bad
    try:
        head = base64.b64decode(result.get("head") or "", validate=True)
    except (binascii.Error, ValueError, TypeError):
        raise bad from None
    return Facts(path, real, *nums, head=head[:HEAD_BYTES])


@dataclass
class _Window:
    op: FileOp
    start: int
    length: int
    received: int = 0


async def device_stream(conn: Any, facts: Facts, offset: int, end: int) -> AsyncIterator[bytes]:
    """The bytes [offset, end) of the file ``facts`` names, read in windows of WINDOW bytes with at
    most OUTSTANDING windows in flight. Raises BindError (412 changed and others) and kills what is in
    flight when it ends early or the consumer goes away."""
    core = _core()
    loop = asyncio.get_running_loop()
    windows: deque[_Window] = deque()
    next_start, eof, retries = offset, False, 0

    async def launch(start: int, length: int) -> _Window:
        op = _register(conn, loop)
        try:
            await _asend(conn, {"type": core.TYPE_FILE_READ, "id": op.id, "path": facts.path, "offset": start,
                                "length": length, "dev": facts.dev, "ino": facts.ino, "size": facts.size,
                                "mtime_ns": facts.mtime_ns})
        except Exception as exc:
            _forget(op)
            raise core.BindError(409, "device_offline", f"could not reach device {conn.name}: {exc}") from exc
        return _Window(op, start, length)

    try:
        while windows or (next_start < end and not eof):
            while len(windows) < OUTSTANDING and next_start < end and not eof:
                length = min(WINDOW, end - next_start, core.FILE_READ_MAX_LENGTH)
                windows.append(await launch(next_start, length))
                next_start += length
            w = windows[0]
            try:
                kind, item = await asyncio.wait_for(w.op.q.get(), WINDOW_IDLE_S)
            except asyncio.TimeoutError:
                raise core.BindError(422, "read_failed",
                                     f"device {conn.name} sent nothing for {WINDOW_IDLE_S:g}s") from None
            if kind == "frame":
                if w.received + len(item) > w.length:
                    raise core.BindError(422, "read_failed", f"device {conn.name} sent more bytes than asked for")
                w.received += len(item)
                if item:
                    yield item
                continue
            windows.popleft()
            if item.get("ok") is not True:
                if _busy(item) and w.received == 0 and retries < BUSY_RETRIES:
                    retries += 1
                    await asyncio.sleep(BUSY_RETRY_S)
                    windows.appendleft(await launch(w.start, w.length))
                    continue
                raise _result_error(conn, facts.path, item)
            sent = (item.get("result") or {}).get("bytes") if isinstance(item.get("result"), dict) else None
            if _int(sent) is None or sent != w.received:
                raise core.BindError(422, "read_failed", f"device {conn.name} dropped bytes of {facts.path}")
            if w.received < w.length:
                eof = True
                for rest in windows:
                    if _forget(rest.op):
                        _kill_soon(conn, rest.op.id)
                windows.clear()
    finally:
        for w in windows:
            if _forget(w.op):
                _kill_soon(conn, w.op.id)


# --- the server's own files ----------------------------------------------------------------------

def _open_local(path: str) -> tuple[int, os.stat_result]:
    """An open descriptor of the regular file ``path`` whose last part is not a symbolic link and
    that has one hard link, and its fstat. Raises BindError."""
    core = _core()
    try:
        lst = os.lstat(path)
    except FileNotFoundError:
        raise core.BindError(404, "not_found", f"{path} does not exist on the Hermes server") from None
    except OSError as exc:
        raise core.BindError(422, "read_failed", f"{path} cannot be read: {exc.strerror}") from None
    if stat.S_ISLNK(lst.st_mode):
        raise _refused(f"{path} is a symbolic link")
    if not stat.S_ISREG(lst.st_mode):
        raise _refused(f"{path} is not a regular file")
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
                     | getattr(os, "O_NONBLOCK", 0))
    except OSError as exc:
        raise core.BindError(422, "read_failed", f"{path} cannot be opened: {exc.strerror}") from None
    st = os.fstat(fd)
    if (st.st_dev, st.st_ino) != (lst.st_dev, lst.st_ino) or not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise _refused(f"{path} changed while it was opened")
    if st.st_nlink != 1:
        os.close(fd)
        raise _refused(f"{path} has more than one hard link")
    return fd, st


def local_stat(path: str) -> Facts:
    fd, st = _open_local(path)
    try:
        head = os.pread(fd, HEAD_BYTES, 0)
    except OSError as exc:
        raise _core().BindError(422, "read_failed", f"{path} cannot be read: {exc.strerror}") from None
    finally:
        os.close(fd)
    return Facts(path, os.path.realpath(path), st.st_size, st.st_mtime_ns, st.st_dev, st.st_ino, head)


async def local_stream(facts: Facts, offset: int, end: int) -> AsyncIterator[bytes]:
    core = _core()
    fd, st = await asyncio.to_thread(_open_local, facts.path)
    try:
        if (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns) != (facts.dev, facts.ino, facts.size, facts.mtime_ns):
            raise core.BindError(412, "changed", f"{facts.path} changed since it was offered")
        pos = offset
        while pos < end:
            chunk = await asyncio.to_thread(os.pread, fd, min(LOCAL_CHUNK, end - pos), pos)
            if not chunk:
                break
            pos += len(chunk)
            yield chunk
    finally:
        os.close(fd)


async def bytes_stream(raw: bytes, offset: int, end: int) -> AsyncIterator[bytes]:
    view = memoryview(raw)
    for pos in range(offset, end, LOCAL_CHUNK):
        yield bytes(view[pos:min(end, pos + LOCAL_CHUNK)])


# --- where a session runs -----------------------------------------------------------------------

@dataclass
class Target:
    kind: str  # "device", "sandbox" or "server"
    machine: str  # what the user reads: the device's name, "the sandbox", "the Hermes server"
    machine_id: str  # the registry's machine: the device id, "sandbox" or "server"
    conn: Any = None
    res: Any = None

    @property
    def chunked(self) -> bool:
        return self.conn is not None and _core().CAPABILITY_FILE_READ in self.conn.capabilities


def target_for(session_id: str, wait: bool = False) -> Target:
    """Where the session's files are: its device (its own or an ancestor's binding), the sandbox, or
    the Hermes server for a chat that runs there. Raises BindError (409 fail_closed, device_offline)."""
    core = _core()
    try:
        res = core.upload_resolution(session_id)
    except core.BindError as exc:
        if exc.code == "runs_on_pod":
            return Target("server", "the Hermes server", "server")
        raise
    device_id = res.binding.device_id
    conn = core.hub().await_device(device_id, known=True)[0] if wait else core.hub().device(device_id)
    if conn is None:
        raise core.BindError(409, "device_offline", f"device {device_id} is not connected")
    if res.sandbox:
        return Target("sandbox", "the sandbox", "sandbox", conn, res)
    return Target("device", conn.name, conn.device_id, conn, res)


def clean_path(path: Any) -> Optional[str]:
    """An absolute, clean path of a file, or None (the rules of the read route)."""
    return _core()._clean_device_path(path)


def stat_path(target: Target, path: str) -> Facts:
    """The facts of the absolute clean ``path`` on the target. Raises BindError: 404 not_found, 409
    device_offline, 413 too_large (an older device and a file over 32 MiB), 422 read_refused for
    what is outside the device roots or not a regular file (without the secret flag)."""
    core = _core()
    if target.kind == "server":
        return local_stat(path)
    why = core.device_roots_denial(target.conn, path)
    if why:
        raise _refused(why)
    if target.chunked:
        facts = device_stat(target.conn, path)
        if core.device_roots_denial(target.conn, facts.real):
            raise _refused(f"{path} resolves to a path outside the device roots")
        return facts
    return legacy_stat(target, path)


def legacy_stat(target: Target, path: str) -> Facts:
    """An older device without file_read: the whole file through the base64 shell read."""
    core = _core()
    if not core.FILE_READS.acquire(blocking=False):
        raise core.BindError(429, "busy", f"{core.MAX_FILE_READS} file reads are running; try again in a moment")
    try:
        _name, raw, real = core.shell_read_file(target.res.session_id, path, allow_secret=True)
    except core.BindError as exc:
        if exc.status == 413:
            raise core.BindError(413, "too_large",
                                 f"{path} is larger than {core.MAX_FILE_READ_BYTES // (1024 * 1024)} MB, the most "
                                 f"this version of talaria on {target.machine} can send; update talaria on "
                                 f"{target.machine} to send larger files") from None
        raise
    finally:
        core.FILE_READS.release()
    return Facts(path, real, len(raw), 0, head=raw[:HEAD_BYTES], raw=raw,
                 digest=hashlib.sha256(raw).hexdigest()[:16])


# --- secret rules --------------------------------------------------------------------------------

def server_secret(path: str) -> bool:
    """Whether a path of the Hermes server is secret: the home rules of device reads for the server's
    home and HERMES_HOME, Hermes's own read denylist, .env and key files, and /proc, /sys, /dev and
    mounted secrets."""
    core = _core()
    p = posixpath.normpath(path)
    if any(core.is_under(p, r) for r in SERVER_SECRET_ROOTS) or core.secret_basename(p):
        return True
    try:
        from agent import file_safety
        if file_safety.get_read_block_error(p):
            return True
    except Exception:
        logger.debug("device: Hermes read denylist not available", exc_info=True)
        return True
    home = os.path.expanduser("~")
    for h in dict.fromkeys((home, os.path.realpath(home))):
        if posixpath.isabs(h) and core._home_denial(h, p, True):
            return True
    try:
        hermes_home = str(core.hermes_home())
    except Exception:
        return True
    for hh in dict.fromkeys((posixpath.normpath(hermes_home), os.path.realpath(hermes_home))):
        if core.is_under(p, hh):
            rel = p[len(hh):].lstrip("/")
            probe = posixpath.join(_HOME_PROBE, ".hermes", rel) if rel else posixpath.join(_HOME_PROBE, ".hermes")
            if core._home_denial(_HOME_PROBE, probe, True):
                return True
    return False


def is_secret(target: Target, facts: Facts) -> bool:
    core = _core()
    paths = dict.fromkeys((facts.path, facts.real))
    if target.kind == "server":
        return any(server_secret(p) for p in paths)
    return any(core.device_secret(target.conn, p) for p in paths)


# --- did the user ask for this file ---------------------------------------------------------------

_SCAFFOLD_FLAGS = ("_todo_snapshot_synthetic", "_empty_recovery_synthetic", "_verification_stop_synthetic",
                   "_pre_verify_synthetic", "_dropped_toolcall_nudge")
_STEER_OPEN, _STEER_CLOSE = "[OUT-OF-BAND USER MESSAGE", "[/OUT-OF-BAND USER MESSAGE]"
_PAGE_ANSWER = "[Answer from the page "
_LEADING_NOTE = re.compile(r"\A\[System note:[^\n]*\](?:[ \t]*\n\n|\s*\Z)")
_MEMORY = re.compile(r"\s*<\s*memory-context\s*>[\s\S]*?</\s*memory-context\s*>", re.IGNORECASE)


def _message_text(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(p.get("text") or p.get("content") or "") for p in content if isinstance(p, dict))
    return ""


def _fallback_authored(message: Any) -> Optional[str]:
    """For a Hermes without agent.conversation_compression_scaffolding: the words a person wrote in a
    user message, or None. Stricter than Hermes's classifier: any text that starts with a bracket
    (other than a steer or a page answer) is treated as runtime scaffolding."""
    if not isinstance(message, dict) or message.get("role") != "user" or any(message.get(f) for f in _SCAFFOLD_FLAGS):
        return None
    text = _message_text(message).strip()
    try:
        from gateway.message_timestamps import strip_leading_message_timestamps
        text = strip_leading_message_timestamps(text)[0]
    except Exception:
        pass
    text = _MEMORY.sub("", text).strip()
    while (note := _LEADING_NOTE.match(text)) is not None:
        text = text[note.end():].lstrip()
    if text.startswith(_STEER_OPEN):
        body = text.split("\n", 1)[1] if "\n" in text else ""
        return _fallback_authored({"role": "user", "content": body.split(_STEER_CLOSE, 1)[0]})
    if not text or "[INTERNAL NOTIFICATION" in text[-400:]:
        return None
    if text.startswith("[") and not text.startswith(_PAGE_ANSWER):
        return None
    return text


def authored_text(message: Any) -> Optional[str]:
    try:
        from agent.conversation_compression_scaffolding import user_authored_text
    except Exception:
        return _fallback_authored(message)
    try:
        return user_authored_text(message)
    except Exception:
        logger.debug("device: user_authored_text failed", exc_info=True)
        return None


def _current_agent():
    try:
        from agent.subagent_lifecycle import get_active_subagent_parent
        return get_active_subagent_parent()
    except Exception:
        return None


def _messages_of(agent: Any) -> Optional[list]:
    if agent is None:
        return None
    msgs = getattr(agent, "_approval_review_messages", None)
    if msgs is None:
        msgs = getattr(agent, "_session_messages", None)
    return list(msgs) if isinstance(msgs, list) else None


def _agent_messages() -> Optional[list]:
    """The running chat's messages: for a subagent, its root chat's (the goal is the parent's text,
    never the user's)."""
    agent = _current_agent()
    if agent is None:
        return None
    root = getattr(agent, "_approval_review_root", None)
    root = root() if callable(root) else root
    return _messages_of(root if root is not None else agent)


MAX_DB_HOPS = 20
MAX_DB_ROWS = 2000


def _db_messages(session_id: str) -> Optional[list]:
    """The stored messages of the session and its ancestors, leaving out subagent sessions (whose user
    rows are the parent agent's goal). None when the session store cannot be read."""
    try:
        from hermes_cli.goals import _get_session_db
        db = _get_session_db()
    except Exception:
        return None
    if db is None or not session_id:
        return None
    out: list = []
    sid, seen = session_id, set()
    try:
        for _ in range(MAX_DB_HOPS):
            if not sid or sid in seen:
                break
            seen.add(sid)
            row = db.get_session(sid)
            if row is None:
                break
            if str(row.get("source") or "") != "subagent":
                try:
                    rows = db.get_messages(sid, limit=MAX_DB_ROWS, latest=True)
                except TypeError:
                    rows = db.get_messages(sid)
                out.extend(r for r in rows or [] if isinstance(r, dict) and r.get("role") == "user")
            sid = str(row.get("parent_session_id") or "")
    except Exception:
        logger.debug("device: session store messages of %s not readable", session_id, exc_info=True)
        return out or None
    return out


def user_texts(session_id: str) -> Optional[list[str]]:
    """What the user wrote in this chat, from the running agent's messages and the session store;
    None when neither can be read."""
    msgs = _agent_messages()
    stored = _db_messages(session_id)
    if msgs is None and stored is None:
        return None
    texts = []
    for m in (msgs or []) + (stored or []):
        t = authored_text(m)
        if t:
            texts.append(t)
    return texts


def _token(form: str) -> re.Pattern:
    return re.compile(r"(?<![\w.~/-])" + re.escape(form) + r"(?![\w/-]|\.\w)")


def names_file(text: str, forms: list[str], base: str) -> bool:
    """Whether ``text`` names the file: one of ``forms`` (absolute and ~/ paths) or ``base`` as a whole
    token."""
    for form in [*forms, base]:
        if form and form in text and _token(form).search(text):
            return True
    return False


def file_forms(target: Target, facts: Facts) -> list[str]:
    forms = list(dict.fromkeys((facts.path, facts.real)))
    homes: list[str] = []
    if target.kind == "server":
        h = os.path.expanduser("~")
        homes = [h, os.path.realpath(h)]
    elif target.conn is not None and posixpath.isabs(target.conn.home or ""):
        homes = [posixpath.normpath(target.conn.home)]
        if target.conn.real_home:
            homes.append(target.conn.real_home)
    for p in list(forms):
        for h in homes:
            if h and h != "/" and core_is_under(p, h) and p != h:
                forms.append("~/" + p[len(h.rstrip("/")) + 1:])
    return list(dict.fromkeys(forms))


def core_is_under(path: str, root: str) -> bool:
    return _core().is_under(path, root)


def user_asked(session_id: str, target: Target, facts: Facts) -> bool:
    """Whether a real user message of this chat names the file. False when the messages cannot be
    read."""
    texts = user_texts(session_id)
    if not texts:
        return False
    forms = file_forms(target, facts)
    bases = list(dict.fromkeys(posixpath.basename(p) for p in (facts.path, facts.real)))
    return any(names_file(t, forms, b) for t in texts for b in bases)


# --- file types ---------------------------------------------------------------------------------

_EXT: dict[str, tuple[str, str, str]] = {}


def _types(kind: str, rows: str) -> None:
    for row in rows.strip().splitlines():
        exts, mime, label = (x.strip() for x in row.split("|"))
        for e in exts.split():
            _EXT[e] = (mime, kind, label)


_types("image", """
png | image/png | PNG image
jpg jpeg | image/jpeg | JPEG image
gif | image/gif | GIF image
webp | image/webp | WebP image
svg | image/svg+xml | SVG image
bmp | image/bmp | Bitmap image
ico | image/vnd.microsoft.icon | Icon
heic | image/heic | HEIC image
avif | image/avif | AVIF image
tif tiff | image/tiff | TIFF image
""")
_types("pdf", "pdf | application/pdf | PDF")
_types("audio", """
mp3 | audio/mpeg | MP3 audio
wav | audio/wav | WAV audio
ogg oga | audio/ogg | Ogg audio
opus | audio/opus | Opus audio
flac | audio/flac | FLAC audio
m4a | audio/mp4 | M4A audio
aac | audio/aac | AAC audio
""")
_types("video", """
mp4 m4v | video/mp4 | MP4 video
webm | video/webm | WebM video
mov | video/quicktime | QuickTime video
mkv | video/x-matroska | Matroska video
avi | video/x-msvideo | AVI video
""")
_types("archive", """
zip | application/zip | Zip archive
tar | application/x-tar | Tar archive
gz | application/gzip | Gzip file
tgz tar.gz | application/gzip | Gzip tar
bz2 | application/x-bzip2 | Bzip2 file
tbz2 tar.bz2 | application/x-bzip2 | Bzip2 tar
xz | application/x-xz | XZ file
txz tar.xz | application/x-xz | XZ tar
zst | application/zstd | Zstandard file
tzst tar.zst | application/zstd | Zstandard tar
7z | application/x-7z-compressed | 7-Zip archive
rar | application/vnd.rar | RAR archive
jar | application/java-archive | Java archive
deb | application/vnd.debian.binary-package | Debian package
rpm | application/x-rpm | RPM package
dmg | application/x-apple-diskimage | Disk image
iso | application/x-iso9660-image | Disc image
""")
_types("text", """
txt | text/plain | Text file
md markdown | text/markdown | Markdown
csv | text/csv | CSV
tsv | text/tab-separated-values | TSV
log | text/plain | Log file
rst | text/x-rst | reStructuredText
env | text/plain | Environment file
""")
_types("code", """
go | text/x-go | Go source
py | text/x-python | Python source
js mjs cjs | text/javascript | JavaScript source
ts | text/x-typescript | TypeScript source
tsx | text/x-typescript | TSX source
jsx | text/javascript | JSX source
rs | text/x-rust | Rust source
c | text/x-c | C source
h | text/x-c | C header
cc cpp cxx | text/x-c++ | C++ source
hpp | text/x-c++ | C++ header
java | text/x-java | Java source
kt | text/x-kotlin | Kotlin source
swift | text/x-swift | Swift source
rb | text/x-ruby | Ruby source
php | text/x-php | PHP source
cs | text/x-csharp | C# source
lua | text/x-lua | Lua source
zig | text/x-zig | Zig source
sh bash zsh | text/x-shellscript | Shell script
ps1 | text/plain | PowerShell script
sql | application/sql | SQL
css | text/css | CSS
html htm | text/html | HTML document
xml | application/xml | XML
json | application/json | JSON
jsonl ndjson | application/x-ndjson | JSON lines
yaml yml | application/yaml | YAML
toml | application/toml | TOML
ini cfg conf | text/plain | Config file
kicad_pcb kicad_sch | text/plain | KiCad file
""")
_NAMES = {"dockerfile": ("text/plain", "code", "Dockerfile"), "makefile": ("text/x-makefile", "code", "Makefile"),
          ".env": ("text/plain", "text", "Environment file")}
_KEYS = {"pem": "PEM file", "key": "Key file", "p12": "PKCS #12 file", "pfx": "PKCS #12 file"}
_MAGIC: tuple[tuple[bytes, int, tuple[str, str, str]], ...] = (
    (b"%PDF-", 0, ("application/pdf", "pdf", "PDF")),
    (b"\x89PNG\r\n\x1a\n", 0, ("image/png", "image", "PNG image")),
    (b"\xff\xd8\xff", 0, ("image/jpeg", "image", "JPEG image")),
    (b"GIF8", 0, ("image/gif", "image", "GIF image")),
    (b"PK\x03\x04", 0, ("application/zip", "archive", "Zip archive")),
    (b"\x1f\x8b", 0, ("application/gzip", "archive", "Gzip file")),
    (b"\x28\xb5\x2f\xfd", 0, ("application/zstd", "archive", "Zstandard file")),
    (b"BZh", 0, ("application/x-bzip2", "archive", "Bzip2 file")),
    (b"\xfd7zXZ\x00", 0, ("application/x-xz", "archive", "XZ file")),
    (b"7z\xbc\xaf\x27\x1c", 0, ("application/x-7z-compressed", "archive", "7-Zip archive")),
    (b"ustar", 257, ("application/x-tar", "archive", "Tar archive")),
    (b"\x7fELF", 0, ("application/x-executable", "other", "ELF executable")),
    (b"OggS", 0, ("audio/ogg", "audio", "Ogg audio")),
    (b"fLaC", 0, ("audio/flac", "audio", "FLAC audio")),
    (b"ID3", 0, ("audio/mpeg", "audio", "MP3 audio")),
    (b"ftyp", 4, ("video/mp4", "video", "MP4 video")),
    (b"\x1aE\xdf\xa3", 0, ("video/webm", "video", "WebM video")),
)


def _magic(head: bytes) -> Optional[tuple[str, str, str]]:
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ("image/webp", "image", "WebP image")
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ("audio/wav", "audio", "WAV audio")
    for sig, at, out in _MAGIC:
        if head[at:at + len(sig)] == sig:
            return out
    return None


def _text(head: bytes) -> Optional[str]:
    if b"\0" in head:
        return None
    try:
        return head.decode("utf-8")
    except UnicodeDecodeError as exc:
        if exc.start >= len(head) - 3 and len(head) >= HEAD_BYTES:
            return head[:exc.start].decode("utf-8", "replace")
        return None


def sniff(name: str, head: bytes, size: int) -> dict:
    """``{"mime", "kind", "type_label", "lines"}`` from the name's extension and the first bytes;
    ``lines`` for text and code when the whole file is in ``head``, else 0."""
    low = name.lower()
    parts = low.split(".")
    ext2 = ".".join(parts[-2:]) if len(parts) > 2 else ""
    ext = parts[-1] if len(parts) > 1 else ""
    found = _NAMES.get(low)
    if found is None and (low.startswith(".env.") or low.endswith(".env")):
        found = _NAMES[".env"]
    if found is None and ext in _KEYS:
        found = ("application/octet-stream", "other", _KEYS[ext])
    found = found or _EXT.get(ext2) or _EXT.get(ext)
    text = _text(head)
    if found is None:
        found = _magic(head)
    if found is None:
        found = ("text/plain", "text", "Text file") if text is not None and head else \
            ("application/octet-stream", "other", "File")
    mime, kind, label = found
    if kind in ("text", "code") and mime.startswith("text/") and text is not None:
        mime += "; charset=utf-8"
    lines = 0
    if kind in ("text", "code") and text is not None and size <= len(head) and text:
        lines = text.count("\n") + (0 if text.endswith("\n") else 1)
    return {"mime": mime, "kind": kind, "type_label": label, "lines": lines}


# --- offers ---------------------------------------------------------------------------------------

class Offers:
    """The offers send_file made, newest last, at most MAX_OFFERS, in file_offers.json next to
    bindings.json."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._entries: Optional[dict[str, dict]] = None

    def _load(self) -> dict[str, dict]:
        if self._entries is None:
            entries: dict[str, dict] = {}
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                for e in data.get("offers") or []:
                    if isinstance(e, dict) and isinstance(e.get("id"), str):
                        entries[e["id"]] = e
            except FileNotFoundError:
                pass
            except Exception:
                logger.warning("device: %s is unreadable; starting a new offer list", self.path, exc_info=True)
            self._entries = entries
        return self._entries

    def add(self, entry: dict) -> None:
        with self._lock:
            entries = self._load()
            entries[entry["id"]] = entry
            while len(entries) > MAX_OFFERS:
                entries.pop(next(iter(entries)))
            self._save(entries)

    def get(self, offer_id: str) -> Optional[dict]:
        if not isinstance(offer_id, str) or not OFFER_RE.fullmatch(offer_id):
            return None
        with self._lock:
            e = self._load().get(offer_id)
            return dict(e) if e else None

    def __len__(self) -> int:
        with self._lock:
            return len(self._load())

    def _save(self, entries: dict[str, dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = self.path.with_name(f".{self.path.name}.{secrets.token_hex(4)}")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"version": 1, "offers": list(entries.values())}, f)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


_OFFERS: dict[str, Offers] = {}
_OFFERS_LOCK = threading.Lock()


def offers() -> Offers:
    core = _core()
    state = getattr(core.hub(), "_state_path", None)
    path = (Path(state).parent if state else core.hermes_home() / "device") / "file_offers.json"
    with _OFFERS_LOCK:
        reg = _OFFERS.get(str(path))
        if reg is None:
            reg = _OFFERS[str(path)] = Offers(path)
        return reg


def _lineage(session_id: str) -> list[str]:
    """The session and its ancestors, as far as they can be read."""
    out, sid = [session_id], session_id
    h = _core().hub()
    for _ in range(_core().MAX_LINEAGE_HOPS):
        try:
            sid = h._parent(sid)
        except Exception:
            break
        if not sid or sid in out:
            break
        out.append(sid)
    return out


def offer_for(offer_id: str, session_id: str, path: str) -> Optional[dict]:
    """The offer ``offer_id`` when it was made in this session (or an ancestor) for ``path``."""
    entry = offers().get(offer_id) if offer_id else None
    if entry is None or entry.get("path") != path:
        return None
    return entry if entry.get("session") in _lineage(session_id) else None


# --- send_file ------------------------------------------------------------------------------------

def _human(size: int) -> str:
    n = float(size)
    for unit in ("bytes", "KB", "MB", "GB", "TB"):
        if n < 1000 or unit == "TB":
            return f"{int(n)} bytes" if unit == "bytes" else f"{n:.1f} {unit}"
        n /= 1000
    return f"{size} bytes"


def _terminal_cwd(task_id: str) -> str:
    """The server folder the chat's terminal is in now (after any cd), as Hermes's file tools read it,
    or "" when Hermes keeps none."""
    try:
        from tools.terminal_tool import get_session_cwd
    except Exception:
        return ""
    keys = []
    try:
        from tools.approval_context import get_current_session_key
        keys.append(get_current_session_key(default=""))
    except Exception:
        logger.debug("device: no session key", exc_info=True)
    keys.append(task_id or "default")
    for key in keys:
        if not key:
            continue
        try:
            cwd = get_session_cwd(key)
        except Exception:
            continue
        if isinstance(cwd, str) and os.path.isabs(cwd):
            return cwd
    return ""


def _abs_path(target: Target, session_id: str, path: str, task_id: str = "") -> str:
    core = _core()
    if target.kind != "server":
        try:
            p = core.device_abs_path(target.res, path)
        except core.DeviceError as exc:
            raise core.BindError(400, "bad_path", str(exc)) from None
    else:
        p = os.path.expanduser(path)
        if not os.path.isabs(p):
            p = os.path.join(_terminal_cwd(task_id) or core.session_cwd() or str(core.terminal_cwd() or "") or os.getcwd(), p)
        p = os.path.normpath(p)
    if clean_path(p) is None:
        raise core.BindError(400, "bad_path", f"{path} is not a path of a file")
    return p


def show_name(name: str) -> str:
    """The name the card shows: upload_name, which drops leading dots, with the one dot of a dot file
    such as .env kept, so the user sees the file's real name."""
    clean = _core().upload_name(name)
    base = str(name or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if base.startswith(".") and base.strip(".") and clean != "attachment":
        return "." + clean
    return clean


def send_file(session_id: str, path: str, name: str = "", note: str = "", task_id: str = "") -> dict:
    """The send_file tool's answer for ``path`` in the session. Raises BindError for ordinary
    errors (missing, a folder, outside the roots, offline)."""
    target = target_for(session_id, wait=True)
    absolute = _abs_path(target, session_id, path, task_id)
    facts = stat_path(target, absolute)
    shown = show_name(name or posixpath.basename(absolute))
    secret = is_secret(target, facts)
    requested = secret and user_asked(session_id, target, facts)
    offer_id = "fo_" + secrets.token_hex(8)
    if secret and not requested:
        return {"status": "refused",
                "file_offer": {"id": offer_id, "name": shown, "path": absolute, "machine": target.machine,
                               "machine_kind": target.kind, "reason": SECRET_REASON, "secret": True},
                "message": (f"Did not offer {shown}: it looks like a secret (a credential, key or environment "
                            f"file). It is sent only when the user asks for this exact file in their own message; "
                            f"tell the user that. Do not send it another way.")}
    kind = sniff(shown, facts.head, facts.size)
    offer = {"id": offer_id, "name": shown, "path": absolute, "size": facts.size, "mime": kind["mime"],
             "kind": kind["kind"], "type_label": kind["type_label"], "mtime": facts.mtime,
             "machine": target.machine, "machine_kind": target.kind, "note": note, "secret": secret,
             "requested": requested, "lines": kind["lines"]}
    offers().add({"id": offer_id, "session": session_id, "machine": target.machine_id, "path": absolute,
                  "real": facts.real, "name": shown, "size": facts.size, "mime": kind["mime"], "kind": kind["kind"],
                  "mtime": facts.mtime, "secret": secret, "requested": requested, "created": time.time()})
    message = (f"Offered {shown} ({_human(facts.size)}) from {target.machine}. The user sees a file card with a "
               f"Download button; do not paste the file's contents or a link to it.")
    if secret:
        message += " It looks like a secret; it is offered because the user asked for this file."
    return {"status": "offered", "file_offer": offer, "message": message}


SCHEMA = {
    "name": "send_file",
    "description": (
        "Offer the user a file from the machine this chat runs on (a computer, the sandbox or the Hermes "
        "server) as a download card in the Talaria hub, and as a document in Telegram. Use it when the user "
        "wants a file: a build, a report, an export, an archive, an image. Any type and size; the bytes are "
        "streamed from the machine when the user downloads, so do not paste the contents. A relative path "
        "starts in the chat's folder, ~ is the home folder. Files that look like secrets (credentials, keys, "
        "environment files) are refused unless the user asked for that exact file in their own message."),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The file to offer"},
            "name": {"type": "string", "description": "The file name the user sees (default: the file's name)"},
            "note": {"type": "string", "description": "One short line about the file, shown on the card"},
        },
        "required": ["path"],
        "additionalProperties": False,
    },
}


def _err(message: str, code: str = "") -> str:
    out = {"error": message}
    if code:
        out["code"] = code
    return json.dumps(out, ensure_ascii=False)


def handler(args: dict, task_id: str = "", session_id: str = "", **_kwargs) -> str:
    core = _core()
    args = args if isinstance(args, dict) else {}
    path, name, note = args.get("path"), args.get("name") or "", args.get("note") or ""
    if not isinstance(path, str) or not path.strip():
        return _err("path must be the path of a file", "bad_arguments")
    if not isinstance(name, str) or not isinstance(note, str):
        return _err("name and note must be text", "bad_arguments")
    sid = session_id or core.current_session_id()
    if not sid:
        return _err("this tool call has no session", "no_session")
    try:
        out = send_file(sid, path.strip(), name.strip(), " ".join(note.split())[:MAX_NOTE], task_id)
    except core.BindError as exc:
        return _err(exc.message, exc.code)
    except core.DeviceError as exc:
        return _err(str(exc), "device_error")
    except OSError as exc:
        logger.warning("device: send_file could not record an offer", exc_info=True)
        return _err(f"the offer could not be saved: {exc.strerror or exc}", "save_failed")
    return json.dumps(out, ensure_ascii=False)


# --- routes ---------------------------------------------------------------------------------------

def checked(session_id: str, path: Any, offer_id: str = "") -> tuple[Target, Facts, dict]:
    """The stat route's work, also the stream route's checks before any byte: resolve, stat, and the
    secret rules at read time. Returns ``(target, facts, info)``. Raises BindError, with ``secret``
    set on a secret refusal. Call from a worker thread."""
    core = _core()
    clean = clean_path(path)
    if clean is None:
        raise core.BindError(400, "bad_path", "path must be an absolute, clean path of a file")
    target = target_for(session_id)
    facts = stat_path(target, clean)
    entry = offer_for(offer_id, session_id, clean) if offer_id else None
    secret = is_secret(target, facts)
    requested = bool(entry and entry.get("requested") and entry.get("secret"))
    if secret and not (requested and entry.get("real") == facts.real):
        raise _refused(f"{clean} {SECRET_REASON}: it is sent only through an offer the user asked for", secret=True)
    name = entry.get("name") if entry and isinstance(entry.get("name"), str) else posixpath.basename(clean)
    kind = sniff(name, facts.head, facts.size)
    info = {"name": name, "path": clean, "real": facts.real, "size": facts.size, "mtime": facts.mtime,
            "mime": kind["mime"], "kind": kind["kind"], "type_label": kind["type_label"], "machine": target.machine,
            "machine_kind": target.kind, "etag": facts.etag, "secret": secret, "requested": requested and secret}
    return target, facts, info


_STREAMS = threading.BoundedSemaphore(MAX_STREAMS)


def stream_slot() -> bool:
    return _STREAMS.acquire(blocking=False)


def release_stream_slot() -> None:
    _STREAMS.release()


def open_stream(target: Target, facts: Facts, offset: int, end: int) -> AsyncIterator[bytes]:
    if facts.raw is not None:
        return bytes_stream(facts.raw, offset, end)
    if target.kind == "server":
        return local_stream(facts, offset, end)
    return device_stream(target.conn, facts, offset, end)


def available() -> bool:
    """check_fn: the plugin serves a hub (a backend id is set). Unlike page_publish it does not need the
    agent message bus: the hub reads offers through the plugin routes, which every hub uses."""
    return bool(_core().backend_id())


def register(ctx: Any, core: Any) -> None:
    ctx.register_tool(SCHEMA["name"], TOOLSET, SCHEMA, handler, check_fn=available,
                      description=SCHEMA["description"], emoji=EMOJI)
