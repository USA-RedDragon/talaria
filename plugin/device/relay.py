"""Serve the next gateway's device calls over this gateway's exec legs while it carries turns
(docs/protocol.md section 4.7, point 8).

During a per-turn restart (Hermes ``gateway.restart_turn_handoff_per_turn``) the old gateway, the
carrier, keeps every device's exec leg until no carried turn is in a tool round, because a carried
foreground command still runs on it. A device has one leg, so until then the next gateway had no
connection to the device and every device call of a turn there waited for it and failed.

Now the carrier opens, for each device leg it keeps, a link to the next gateway's exec route: a
WebSocket that says ``hello`` with the device's own fields, so the next gateway serves it as the
device's connection. The carrier forwards what the next gateway sends to the device verbatim, and
sends back each device message whose request id came from the link. Everything else (its own
commands, pings, the device's acknowledgements) stays on the carrier as before. When the carrier
hands its processes over (``handoff.prepare``) or the device's leg ends, the link closes with
``1001``; the next gateway parks the link's commands, and the device's next connection, which goes to
the next gateway, resumes them (version 3).

The link authenticates with a key the carrier writes to ``$HERMES_HOME/device/carrier.json`` (mode
0600), which the next gateway accepts only while a carrier holds the Hermes carry lock.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("hermes_device")

HEADER = "X-Talaria-Carrier"
KEY_NAME = "carrier.json"
KEY_VERSION = 1
CLOSE_HANDOFF = 1001
# How long a link tries to reach the next gateway, at its start and after a drop.
CONNECT_WINDOW_S = 120.0
CONNECT_TIMEOUT_S = 5.0
SEND_TIMEOUT_S = 5.0
# Device messages for the next gateway kept while its link reconnects; output past this is dropped
# (the next gateway notes the lost bytes from the offsets).
BACKLOG_MAX = 16 * 1024 * 1024
# The handoff waits up to this long for the browser, MCP and file requests that the next gateway sent
# through a link before it closes the link: the device ends such a request with its leg, and nothing
# resumes it, so closing at once failed a browser call of a turn on the next gateway (not_connected).
CALLS_WAIT_MAX_S = 60.0
CALLS_POLL_S = 0.05

# Links of this carrier, by the conn_id of the device leg they serve.
_links: dict[str, "Link"] = {}
_target: Optional[tuple[str, int]] = None
_token = ""


def _core():
    return sys.modules["hermes_device_core"]


def _key_path(hub: Any) -> Optional[Path]:
    return hub._state_path.with_name(KEY_NAME) if hub._state_path else None


def _write_key(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"version": KEY_VERSION, "token": token, "pid": os.getpid(), "written_at": time.time()}
    fd, tmp = tempfile.mkstemp(prefix=".carrier-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def carrier_alive() -> bool:
    """Whether a carrier holds this Hermes home's carry lock (Hermes gateway/turn_carry.py)."""
    try:
        from gateway.turn_carry import carrier_alive as alive
        return bool(alive(_core().hermes_home()))
    except Exception:
        return False


def verify(value: Any) -> bool:
    """The next gateway's check of a link's ``X-Talaria-Carrier`` header."""
    if not isinstance(value, (bytes, bytearray)) or not value:
        return False
    path = _key_path(_core().hub())
    if path is None:
        return False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        token = raw.get("token") if isinstance(raw, dict) and raw.get("version") == KEY_VERSION else None
    except (OSError, ValueError):
        return False
    if not isinstance(token, str) or len(token) < 32:
        return False
    return hmac.compare_digest(bytes(value), token.encode("ascii", "replace")) and carrier_alive()


def identity(hello: dict) -> Optional[tuple[str, str, str]]:
    """``(device_id, name, user)`` from a link's hello, or None when they are not valid."""
    core = _core()
    device_id, name, user = hello.get("device_id"), hello.get("name"), hello.get("user", "")
    if not (isinstance(device_id, str) and core.DEVICE_ID_RE.fullmatch(device_id)):
        return None
    if not (isinstance(name, str) and 1 <= len(name) <= 64) or not (isinstance(user, str) and len(user) <= 256):
        return None
    return device_id, name, user


# --- the carrier --------------------------------------------------------------------------------

def carry_released(target: Any) -> None:
    """Called by Hermes once this gateway released the profile to the next one and carries its
    turns: ``target`` is the next gateway's listener (host, port). Opens a link for every device
    leg this gateway keeps."""
    global _target, _token
    core = _core()
    hub = core.hub()
    path = _key_path(hub)
    try:
        host, port = str(target[0]), int(target[1])
    except (TypeError, ValueError, IndexError):
        return
    if path is None:
        return
    _token = secrets.token_hex(32)
    _write_key(path, _token)
    _target = (host, port)
    for conn in hub.devices():
        attached(conn)


def attached(conn: Any) -> None:
    """Open a link for ``conn`` when this gateway carries (any thread)."""
    handoff = sys.modules.get("hermes_device_handoff")
    if _target is None or (handoff is not None and getattr(handoff, "handing_off", False)):
        return
    if conn.conn_id in _links:
        return
    link = Link(conn, _target, _token)
    _links[conn.conn_id] = link
    try:
        asyncio.run_coroutine_threadsafe(link.run(), conn.loop)
    except RuntimeError:
        _links.pop(conn.conn_id, None)
        logger.debug("device: exec leg loop of %s is closed", conn.device_id, exc_info=True)


def link_for(conn: Any) -> Optional["Link"]:
    return _links.get(conn.conn_id) if _links else None


async def leg_ended(conn: Any) -> None:
    """The device's leg on this gateway ended: its link ends too, so the next gateway parks the
    link's commands for the device's next connection."""
    link = _links.pop(conn.conn_id, None) if _links else None
    if link is not None:
        await link.close(CLOSE_HANDOFF, "device left the carrying gateway")


def _calls_kinds() -> frozenset:
    core = _core()
    return frozenset({core.TYPE_BROWSER, core.TYPE_BROWSER_START, core.TYPE_MCP, core.TYPE_FILE_STAT,
                      core.TYPE_FILE_READ})


def _wait_for_calls(links: list, limit: float) -> None:
    """Wait until the browser, MCP and file requests in flight on ``links`` now have their answers,
    each up to its own timeout plus BROWSER_SLACK_S, and all of them up to ``limit`` seconds. Requests
    the next gateway sends meanwhile are not waited for."""
    now = time.monotonic()
    slack = _core().BROWSER_SLACK_S
    waits = [(link, rid, min(now + limit, started + timeout + slack))
             for link in links for rid, (started, timeout) in list(link.calls.items())]
    if not waits:
        return
    logger.info("device: waiting for %d browser, MCP or file requests of the next gateway before the handoff",
                len(waits))
    for link, rid, until in waits:
        while rid in link.calls and not link.ended and time.monotonic() < until:
            time.sleep(CALLS_POLL_S)
    left = sum(1 for link, rid, _ in waits if rid in link.calls and not link.ended)
    if left:
        logger.warning("device: %d requests of the next gateway still ran at the handoff", left)


def stop() -> None:
    """The handoff (any thread): end every link and remove the key. The browser, MCP and file
    requests in flight on a link get their answers first (CALLS_WAIT_MAX_S)."""
    global _target
    _target = None
    _wait_for_calls(list(_links.values()), CALLS_WAIT_MAX_S)
    links = list(_links.values())
    _links.clear()
    for link in links:
        try:
            fut = asyncio.run_coroutine_threadsafe(link.close(CLOSE_HANDOFF, "gateway handoff"), link.conn.loop)
            fut.result(timeout=SEND_TIMEOUT_S)
        except Exception:
            logger.debug("device: link of %s did not close cleanly", link.conn.device_id, exc_info=True)
    try:
        path = _key_path(_core().hub())
        if path is not None and _token:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and raw.get("token") == _token:
                path.unlink()
    except (OSError, ValueError, KeyError):
        pass


class Link:
    """One device leg of the carrier, served to the next gateway as that device's connection."""

    def __init__(self, conn: Any, target: tuple[str, int], token: str):
        self.conn, self.target, self.token = conn, target, token
        # Request ids the next gateway sent through this link; the device's answers go back to it.
        self.ids: set[str] = set()
        # The browser, MCP and file requests among them still waiting for their answer:
        # id -> (monotonic start, timeout in seconds).
        self.calls: dict[str, tuple[float, float]] = {}
        self.ws: Any = None
        self.session: Any = None
        self.backlog: list = []
        self.backlog_bytes = 0
        self.ended = False
        self.connected = asyncio.Event()

    # device to next gateway (on the leg's loop)
    def takes(self, msg: dict) -> bool:
        rid = msg.get("id")
        return isinstance(rid, str) and rid in self.ids

    def takes_frame(self, data: bytes) -> bool:
        core = _core()
        if len(data) < core.FILE_ID_LEN:
            return False
        return bytes(data[:core.FILE_ID_LEN]).decode("ascii", "replace") in self.ids

    async def deliver(self, data: Any, msg: Optional[dict] = None) -> None:
        """Send one device message (text, or a binary frame) to the next gateway, in order."""
        core = _core()
        if msg is not None and msg.get("type") in (core.TYPE_EXIT, core.TYPE_BROWSER_RESULT, core.TYPE_MCP_RESULT,
                                                   core.TYPE_FILE_RESULT):
            self.ids.discard(msg.get("id"))
            self.calls.pop(msg.get("id"), None)
        if self.ended:
            return
        ws = self.ws
        if ws is not None and not ws.closed:
            try:
                await asyncio.wait_for(ws.send_bytes(data) if isinstance(data, (bytes, bytearray))
                                       else ws.send_str(data), SEND_TIMEOUT_S)
                return
            except Exception:
                logger.info("device: link of %s to the next gateway failed; reconnecting", self.conn.device_id)
                self.ws = None
                try:
                    await ws.close()
                except Exception:
                    pass
        size = len(data)
        if msg is not None and msg.get("type") == core.TYPE_OUTPUT and self.backlog_bytes + size > BACKLOG_MAX:
            return
        self.backlog.append(data)
        self.backlog_bytes += size

    # next gateway to device
    def _hello(self) -> dict:
        core, c = _core(), self.conn
        hello = {"type": core.TYPE_HELLO, "version": c.version, "max_version": c.version, "roots": list(c.roots),
                 "tmp_dir": c.tmp_dir, "home": c.home, "hostname": c.hostname, "os": c.os, "arch": c.arch,
                 "shell": c.shell, "client_version": c.client_version, "device_id": c.device_id, "name": c.name,
                 "user": c.user}
        if c.capabilities:
            hello["capabilities"] = sorted(c.capabilities)
        if c.mcp_servers:
            hello["mcp_servers"] = list(c.mcp_servers)
        return hello

    async def _connect(self) -> Any:
        import aiohttp
        core = _core()
        if self.session is None:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None,
                                                                               sock_connect=CONNECT_TIMEOUT_S))
        url = f"http://{self.target[0]}:{self.target[1]}{core.PLUGIN_EXEC_PATH}"
        ws = await asyncio.wait_for(self.session.ws_connect(url, headers={HEADER: self.token}, autoping=True,
                                                            max_msg_size=0), CONNECT_TIMEOUT_S)
        try:
            await ws.send_str(json.dumps(self._hello()))
            welcome = await self._receive_json(ws)
            if welcome.get("type") != core.TYPE_WELCOME or welcome.get("version") != self.conn.version:
                raise _Refused(f"unexpected answer {welcome.get('type')!r} version {welcome.get('version')!r}")
            if self.conn.version >= core.RESUME_VERSION:
                # Names the commands the next gateway kept from an earlier link; the device still runs
                # them, so their output and exit simply flow again. Never forwarded: the device would
                # kill every command of this gateway that it does not name.
                resume = await self._receive_json(ws)
                if resume.get("type") != core.TYPE_RESUME:
                    raise _Refused("no resume after the welcome")
                for entry in resume.get("commands") or []:
                    if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                        self.ids.add(entry["id"])
            if core.CAPABILITY_BROWSER in self.conn.capabilities and self.conn.browser:
                await ws.send_str(json.dumps({"type": core.TYPE_BROWSER_STATUS, **self.conn.browser}))
        except BaseException:
            await ws.close()
            raise
        return ws

    async def _receive_json(self, ws: Any) -> dict:
        import aiohttp
        core = _core()
        msg = await asyncio.wait_for(ws.receive(), core.HELLO_TIMEOUT_S)
        if msg.type != aiohttp.WSMsgType.TEXT:
            code = ws.close_code
            raise _Refused(f"closed with {code}") if code and code >= 4000 else ConnectionError(f"closed ({code})")
        out = json.loads(msg.data)
        return out if isinstance(out, dict) else {}

    async def run(self) -> None:
        import aiohttp
        core = _core()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + CONNECT_WINDOW_S
        delay = 0.2
        try:
            while not self.ended:
                try:
                    ws = await self._connect()
                except _Refused as exc:
                    logger.warning("device: the next gateway refused the link of %s: %s", self.conn.device_id, exc)
                    return
                except Exception as exc:
                    if loop.time() >= deadline:
                        logger.warning("device: could not reach the next gateway for %s: %s", self.conn.device_id, exc)
                        return
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 2.0)
                    continue
                if self.ended:
                    await ws.close(code=CLOSE_HANDOFF)
                    return
                while self.backlog:
                    item = self.backlog.pop(0)
                    self.backlog_bytes -= len(item)
                    await ws.send_bytes(item) if isinstance(item, (bytes, bytearray)) else await ws.send_str(item)
                self.ws = ws
                self.connected.set()
                logger.info("device: %s served to the next gateway over this gateway's leg", self.conn.device_id)
                delay = 0.2
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        out = json.loads(msg.data)
                    except ValueError:
                        continue
                    if not isinstance(out, dict):
                        continue
                    kind = out.get("type")
                    if kind == core.TYPE_PING:
                        await ws.send_str(json.dumps({"type": core.TYPE_PONG, "seq": out.get("seq")}))
                        continue
                    if kind in (core.TYPE_WELCOME, core.TYPE_RESUME, core.TYPE_PONG):
                        continue
                    rid = out.get("id")
                    if isinstance(rid, str):
                        self.ids.add(rid)
                        if kind in _calls_kinds():
                            self.calls[rid] = (time.monotonic(), _timeout(out))
                    await self.conn.send_text(msg.data)
                self.ws = None
                self.connected.clear()
                if ws.close_code == core.CLOSE_REPLACED or self.ended:
                    return
                deadline = loop.time() + CONNECT_WINDOW_S
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("device: link of %s ended", self.conn.device_id, exc_info=True)
        finally:
            self.ended = True
            self.connected.clear()
            if _links.get(self.conn.conn_id) is self:
                _links.pop(self.conn.conn_id, None)
            await self._close_session()

    async def close(self, code: int, reason: str) -> None:
        self.ended = True
        ws, self.ws = self.ws, None
        if ws is not None:
            try:
                await ws.close(code=code, message=reason.encode()[:120])
            except Exception:
                logger.debug("device: link close failed", exc_info=True)

    async def _close_session(self) -> None:
        session, self.session = self.session, None
        if session is not None:
            try:
                await session.close()
            except Exception:
                pass


def _timeout(msg: dict) -> float:
    """The timeout in seconds a request names, else the browser default."""
    core = _core()
    value = msg.get("timeout")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value <= 0:
        return float(core.MCP_DEFAULT_TIMEOUT_S if msg.get("type") == core.TYPE_MCP else core.BROWSER_DEFAULT_TIMEOUT_S)
    return float(value)


class _Refused(Exception):
    """The next gateway answered the link with something other than welcome and resume."""
