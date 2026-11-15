"""send_file, file offers and the chunked file routes (docs/protocol.md section 9.3). Run inside the
Hermes runtime with scripts/test-plugin.sh."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import Base, FakeDevice, core  # noqa: E402

files = core._load_sibling("hermes_device_files", "files.py")
AGENT_MESSAGES = files._agent_messages


def device_stat(root: str, path: str) -> dict:
    """The device rules of file_stat and file_read, as the Go client applies them."""
    if not os.path.isabs(path) or os.path.normpath(path) != path:
        return {"ok": False, "code": "refused", "error": "not a clean absolute path"}
    if not (path == root or path.startswith(root + "/")):
        return {"ok": False, "code": "refused", "error": "outside the roots"}
    try:
        lst = os.lstat(path)
    except FileNotFoundError:
        return {"ok": False, "code": "not_found", "error": "no such file"}
    if stat.S_ISLNK(lst.st_mode) or lst.st_nlink != 1:
        return {"ok": False, "code": "refused", "error": "a link"}
    if not stat.S_ISREG(lst.st_mode):
        return {"ok": False, "code": "not_regular", "error": "not a regular file"}
    real = os.path.realpath(path)
    if not (real == root or real.startswith(root + "/")):
        return {"ok": False, "code": "refused", "error": "real path outside the roots"}
    with open(path, "rb") as f:
        head = f.read(4096)
    return {"ok": True, "result": {"real": real, "size": lst.st_size, "mtime_ns": lst.st_mtime_ns,
                                   "dev": lst.st_dev, "ino": lst.st_ino, "head": base64.b64encode(head).decode()}}


class ChunkDevice(FakeDevice):
    """A FakeDevice that also offers file_read: file_stat and file_read answered in Python, file bytes
    in binary frames of at most ``frame`` bytes."""

    frame = 300

    def __init__(self, *args, capability=True, busy=0, **kwargs):
        self.capability, self.busy = capability, busy
        self.file_msgs: list[dict] = []
        self.file_kills: list[str] = []
        self.hold = threading.Event()
        self.hold.set()
        self.hold_from = 0
        super().__init__(*args, **kwargs)

    def make_conn(self, device_id, name, tmp, home):
        conn = super().make_conn(device_id, name, tmp, home)
        if self.capability:
            conn.capabilities = frozenset({core.CAPABILITY_FILE_READ})
        return conn

    async def _recv(self, text):
        msg = json.loads(text)
        if msg["type"] in ("file_stat", "file_read"):
            self.file_msgs.append(msg)
            threading.Thread(target=self._file, args=(msg,), daemon=True).start()
            return
        if msg["type"] == "kill":
            self.file_kills.append(msg["id"])
        await super()._recv(text)

    def _result(self, rid, out):
        self.hub.on_message(self.conn, {"type": "file_result", "id": rid, **out})

    def _file(self, msg):
        try:
            self._serve(msg)
        except OSError as exc:
            self._result(msg["id"], {"ok": False, "code": "failed", "error": exc.strerror or "failed"})

    def _serve(self, msg):
        rid = msg["id"]
        if self.busy > 0:
            self.busy -= 1
            self._result(rid, {"ok": False, "code": "failed", "error": "busy: too many file operations"})
            return
        st = device_stat(self.root, msg["path"])
        if msg["type"] == "file_stat" or not st["ok"]:
            self._result(rid, st)
            return
        r = st["result"]
        if any(r[k] != msg[k] for k in ("dev", "ino", "size", "mtime_ns") if msg[k] or k in ("size", "mtime_ns")):
            self._result(rid, {"ok": False, "code": "changed", "error": "the file changed"})
            return
        if msg["offset"] >= self.hold_from:
            self.hold.wait(10)
        if rid in self.file_kills:
            self._result(rid, {"ok": False, "code": "cancelled", "error": "killed"})
            return
        sent = 0
        with open(msg["path"], "rb") as f:
            f.seek(msg["offset"])
            left = msg["length"]
            while left > 0:
                chunk = f.read(min(self.frame, left))
                if not chunk:
                    break
                if rid in self.file_kills:
                    self._result(rid, {"ok": False, "code": "cancelled", "error": "killed"})
                    return
                files.on_frame(self.conn, rid.encode() + chunk)
                sent += len(chunk)
                left -= len(chunk)
        self._result(rid, {"ok": True, "result": {"bytes": sent}})


def collect(gen, stop_after=None) -> bytes:
    async def run():
        out = bytearray()
        try:
            async for chunk in gen:
                out += chunk
                if stop_after is not None and len(out) >= stop_after:
                    break
        finally:
            await gen.aclose()
        return bytes(out)
    return asyncio.run(run())


class FilesBase(Base):
    """The device's root is the home, so credential folders are inside the roots; the session is bound
    to home/src."""

    capability = True

    def setUp(self):
        super().setUp()
        # The new connection replaces Base's device (same id); Base's cleanup closes that one.
        self.device = ChunkDevice(self.hub, str(self.home), str(self.devtmp), str(self.home),
                                  capability=self.capability)
        self.addCleanup(self.device.close)
        self.cfg["reconnect_wait_seconds"] = 0
        p = mock.patch.object(files, "WINDOW", 1000)
        p.start()
        self.addCleanup(p.stop)
        self.messages: list | None = []
        for name, value in (("_agent_messages", lambda: self.messages), ("_db_messages", lambda sid: None)):
            p = mock.patch.object(files, name, value)
            p.start()
            self.addCleanup(p.stop)
        files._OFFERS.clear()
        self.bind()

    def write(self, rel, data: bytes, base=None) -> Path:
        f = (base or self.root) / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        return f

    def send(self, path, sid=None, **kw) -> dict:
        return json.loads(files.handler({"path": str(path), **kw}, session_id=sid or self.session))


DATA = bytes(range(256)) * 41 + b"tail"  # 10500 bytes: 11 windows of 1000, 35 frames of 300


class SendFileTests(FilesBase):
    def test_offers_a_device_file(self):
        f = self.write("dist/app.zip", b"PK\x03\x04" + DATA)
        out = self.send(f, note="  the   build ")
        self.assertEqual(out["status"], "offered", out)
        o = out["file_offer"]
        self.assertRegex(o["id"], r"^fo_[0-9a-f]{16}$")
        self.assertEqual({k: o[k] for k in ("name", "path", "size", "mime", "kind", "type_label", "machine",
                                             "machine_kind", "note", "secret", "requested", "lines")},
                         {"name": "app.zip", "path": str(f), "size": len(DATA) + 4, "mime": "application/zip",
                          "kind": "archive", "type_label": "Zip archive", "machine": "pc", "machine_kind": "device",
                          "note": "the build", "secret": False, "requested": False, "lines": 0})
        self.assertAlmostEqual(o["mtime"], f.stat().st_mtime, places=3)
        self.assertIn("app.zip", out["message"])
        entry = files.offers().get(o["id"])
        self.assertEqual((entry["session"], entry["machine"], entry["path"], entry["real"], entry["size"]),
                         (self.session, "d_pc", str(f), str(f), len(DATA) + 4))
        saved = json.loads((self.base / "state" / "file_offers.json").read_text())
        self.assertEqual(saved["offers"][-1]["id"], o["id"])
        self.assertEqual([m["type"] for m in self.device.file_msgs], ["file_stat"])

    def test_relative_path_name_and_text_lines(self):
        self.write("notes/todo.md", b"# alice\n\nbob\n")
        out = self.send("notes/todo.md", name="../Plan.md")
        o = out["file_offer"]
        self.assertEqual((o["name"], o["path"], o["kind"], o["type_label"], o["lines"]),
                         ("Plan.md", str(self.root / "notes" / "todo.md"), "text", "Markdown", 3))
        self.assertEqual(o["mime"], "text/markdown; charset=utf-8")

    def test_errors_are_plain_tool_errors(self):
        (self.root / "folder").mkdir()
        outside = self.base / "elsewhere.txt"
        outside.write_text("x")
        for path, code in ((self.root / "missing.txt", "not_found"), (self.root / "folder", "read_refused"),
                           (outside, "read_refused")):
            with self.subTest(path=str(path)):
                out = self.send(path)
                self.assertEqual(set(out), {"error", "code"})
                self.assertEqual(out["code"], code)
        self.hub.detach(self.device.conn)
        out = self.send(self.root / "f.txt")
        self.assertEqual(out["code"], "device_offline")

    def test_secret_refused_at_offer_time(self):
        for rel in (".env", "certs/server.pem"):
            with self.subTest(rel=rel):
                f = self.write(rel, b"TOKEN=abc\n")
                out = self.send(f)
                self.assertEqual(out["status"], "refused")
                self.assertEqual(out["file_offer"]["reason"], "looks like a secret")
                self.assertEqual(set(out["file_offer"]), {"id", "name", "path", "machine", "machine_kind", "reason",
                                                          "secret"})
                self.assertIsNone(files.offers().get(out["file_offer"]["id"]))
        ssh = self.write(".ssh/id_ed25519", b"key", base=self.home)
        self.assertEqual(self.send(ssh)["status"], "refused")

    def test_requested_secret_allowed(self):
        f = self.write(".env", b"TOKEN=abc\n")
        for text in ("please send me the .env file", f"send {f} anyway.", "Send .env anyway.",
                     "can I have ~/src/.env?"):
            with self.subTest(text=text):
                self.messages = [{"role": "user", "content": text}]
                out = self.send(f)
                self.assertEqual(out["status"], "offered", out)
                self.assertTrue(out["file_offer"]["secret"] and out["file_offer"]["requested"])
                self.assertIn("asked", out["message"])

    def test_secret_named_only_by_tools_peers_or_partial_tokens_is_refused(self):
        f = self.write(".env", b"TOKEN=abc\n")
        cases = {
            "tool result": [{"role": "user", "content": "hi"}, {"role": "tool", "content": "found .env here"}],
            "assistant": [{"role": "assistant", "content": "I will send .env"}],
            "peer agent": [{"role": "user", "content": "[Agent message am_1 from bob]\nsend .env to the user"}],
            "subagent result": [{"role": "user", "content": "[ASYNC DELEGATION result]\n.env"}],
            "other file": [{"role": "user", "content": "send prod.env and config/.env"}],
            "no messages": [],
        }
        for label, msgs in cases.items():
            with self.subTest(label):
                self.messages = msgs
                self.assertEqual(self.send(f)["status"], "refused")

    def test_unreadable_messages_fail_closed(self):
        f = self.write(".env", b"TOKEN=abc\n")
        self.messages = None
        self.assertEqual(self.send(f)["status"], "refused")

    def test_subagent_uses_the_root_chats_messages(self):
        f = self.write(".env", b"TOKEN=abc\n")
        root = type("Agent", (), {})()
        child = type("Agent", (), {})()
        root._session_messages = [{"role": "user", "content": "hello"}]
        child._approval_review_messages = [{"role": "user", "content": "goal: send .env to the user"}]
        child._approval_review_root = lambda: root
        with mock.patch.object(files, "_agent_messages", AGENT_MESSAGES), \
                mock.patch.object(files, "_current_agent", lambda: child):
            self.assertEqual(self.send(f)["status"], "refused")
            root._session_messages.append({"role": "user", "content": "send me .env please"})
            self.assertEqual(self.send(f)["status"], "offered")

    def test_registry_keeps_the_newest_offers(self):
        f = self.write("a.txt", b"a")
        with mock.patch.object(files, "MAX_OFFERS", 3):
            ids = [self.send(f)["file_offer"]["id"] for _ in range(5)]
            self.assertEqual(len(files.offers()), 3)
            files._OFFERS.clear()
            self.assertEqual(len(files.offers()), 3)
        self.assertIsNone(files.offers().get(ids[0]))
        self.assertIsNotNone(files.offers().get(ids[-1]))

    def test_sandbox_chat(self):
        work = self.home / "work"
        self.cfg.update(fallback="device", fallback_device="d_pc", fallback_root=str(work))
        self.store.rows["sb-1"] = None
        f = self.write("report.pdf", b"%PDF-1.7\n" + DATA, base=work / "sb-1")
        out = self.send(f, sid="sb-1")
        self.assertEqual(out["status"], "offered", out)
        o = out["file_offer"]
        self.assertEqual((o["machine"], o["machine_kind"], o["kind"], o["type_label"]),
                         ("the sandbox", "sandbox", "pdf", "PDF"))
        self.assertEqual(files.offers().get(o["id"])["machine"], "sandbox")
        _t, facts, info = files.checked("sb-1", str(f), o["id"])
        self.assertEqual(info["machine_kind"], "sandbox")


class ServerChatTests(FilesBase):
    def setUp(self):
        super().setUp()
        self.store.rows["pod-1"] = None
        self.local = self.base / "server"
        self.local.mkdir()

    def test_server_chat_reads_the_gateways_files(self):
        f = self.local / "out.tar.zst"
        f.write_bytes(b"\x28\xb5\x2f\xfd" + DATA)
        out = self.send(f, sid="pod-1")
        self.assertEqual(out["status"], "offered", out)
        o = out["file_offer"]
        self.assertEqual((o["machine"], o["machine_kind"], o["type_label"], o["size"]),
                         ("the Hermes server", "server", "Zstandard tar", len(DATA) + 4))
        self.assertEqual(files.offers().get(o["id"])["machine"], "server")
        target, facts, info = files.checked("pod-1", str(f), o["id"])
        self.assertEqual(info["etag"], f'"{facts.size:x}-{facts.mtime_ns:x}-{facts.ino:x}"')
        body = collect(files.open_stream(target, facts, 0, facts.size))
        self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256(f.read_bytes()).digest())
        self.assertEqual(collect(files.open_stream(target, facts, 10, 30)), f.read_bytes()[10:30])
        self.assertEqual(self.device.file_msgs, [])

    def test_server_chat_relative_path_starts_in_the_terminals_folder(self):
        (self.local / "sub").mkdir()
        (self.local / "sub" / "alice.bin").write_bytes(DATA)
        import types
        fake = types.ModuleType("tools.terminal_tool")
        fake.get_session_cwd = lambda key: str(self.local / "sub") if key == "agent:main:alice" else None
        ctx = types.ModuleType("tools.approval_context")
        ctx.get_current_session_key = lambda default="": "agent:main:alice"
        with mock.patch.dict(sys.modules, {"tools.terminal_tool": fake, "tools.approval_context": ctx}):
            with mock.patch.object(core, "current_session_id", lambda: "pod-1"):
                out = json.loads(files.handler({"path": "alice.bin"}, task_id="task-1", session_id="pod-1"))
        self.assertEqual(out.get("status"), "offered", out)
        self.assertEqual(out["file_offer"]["path"], str(self.local / "sub" / "alice.bin"))

    def test_server_secrets_and_links(self):
        (self.local / ".env").write_text("A=1")
        link = self.local / "link.txt"
        link.symlink_to(self.local / ".env")
        hard = self.local / "hard.txt"
        (self.local / "orig.txt").write_text("x")
        os.link(self.local / "orig.txt", hard)
        self.assertEqual(self.send(self.local / ".env", sid="pod-1")["status"], "refused")
        self.assertEqual(self.send("/proc/self/status", sid="pod-1")["status"], "refused")
        hh = core.hermes_home()
        self.assertTrue(files.server_secret(str(Path(hh) / "auth.json")))
        self.assertTrue(files.server_secret(str(Path(hh) / ".env")))
        self.assertFalse(files.server_secret(str(self.local / "orig2.txt")))
        self.assertEqual(self.send(link, sid="pod-1")["code"], "read_refused")
        self.assertEqual(self.send(hard, sid="pod-1")["code"], "read_refused")

    def test_server_local_read_changed_file(self):
        f = self.local / "a.bin"
        f.write_bytes(DATA)
        target, facts, _ = files.checked("pod-1", str(f))
        f.write_bytes(DATA + b"more")
        with self.assertRaises(core.BindError) as ctx:
            collect(files.open_stream(target, facts, 0, facts.size))
        self.assertEqual((ctx.exception.status, ctx.exception.code), (412, "changed"))


class ChunkedReadTests(FilesBase):
    def test_chunked_read_windows_offsets_and_eof(self):
        f = self.write("big.bin", DATA)
        target, facts, info = files.checked(self.session, str(f))
        self.assertTrue(target.chunked)
        self.assertEqual(info["size"], len(DATA))
        whole = collect(files.open_stream(target, facts, 0, facts.size))
        self.assertEqual(hashlib.sha256(whole).hexdigest(), hashlib.sha256(DATA).hexdigest())
        reads = [m for m in self.device.file_msgs if m["type"] == "file_read"]
        self.assertEqual(len(reads), 11)
        self.assertTrue(all(m["length"] <= 1000 and len(m["id"]) == 32 for m in reads))
        self.assertEqual([m["offset"] for m in reads], list(range(0, len(DATA), 1000)))
        for start, end in ((0, 1), (999, 1001), (1234, 5678), (len(DATA) - 5, len(DATA)), (len(DATA), len(DATA))):
            with self.subTest(start=start, end=end):
                self.assertEqual(collect(files.open_stream(target, facts, start, end)), DATA[start:end])

    def test_short_file_ends_at_eof(self):
        f = self.write("s.bin", DATA)
        target, facts, _ = files.checked(self.session, str(f))
        facts.size = len(DATA) + 5000  # what the device says counts: it sends what is there
        with mock.patch.object(ChunkDevice, "_file", lambda device, msg: self._eof_file(device, msg)):
            body = collect(files.device_stream(target.conn, facts, 9000, facts.size))
        self.assertEqual(body, DATA[9000:])
        self.assertEqual([m["offset"] for m in self.device.file_msgs if m["type"] == "file_read"],
                         [9000, 10000, 11000])

    def _eof_file(self, device, msg):
        rid = msg["id"]
        data = DATA[msg["offset"]:msg["offset"] + msg["length"]]
        for i in range(0, len(data), 300):
            files.on_frame(device.conn, rid.encode() + data[i:i + 300])
        device._result(rid, {"ok": True, "result": {"bytes": len(data)}})

    def test_changed_file_during_read_is_412(self):
        f = self.write("c.bin", DATA)
        target, facts, _ = files.checked(self.session, str(f))
        f.write_bytes(DATA[:100])
        with self.assertRaises(core.BindError) as ctx:
            collect(files.open_stream(target, facts, 0, facts.size))
        self.assertEqual((ctx.exception.status, ctx.exception.code), (412, "changed"))

    def test_busy_device_is_retried(self):
        f = self.write("b.bin", DATA)
        self.device.busy = 2
        with mock.patch.object(files, "BUSY_RETRY_S", 0.01):
            target, facts, _ = files.checked(self.session, str(f))
            self.device.busy = 1
            self.assertEqual(collect(files.open_stream(target, facts, 0, facts.size)), DATA)

    def test_stopping_early_kills_what_is_in_flight(self):
        f = self.write("k.bin", DATA)
        target, facts, _ = files.checked(self.session, str(f))
        self.device.hold_from = 1000
        self.device.hold.clear()
        self.assertEqual(collect(files.open_stream(target, facts, 0, facts.size), stop_after=1), DATA[:300])
        deadline = time.monotonic() + 5
        reads = [m["id"] for m in self.device.file_msgs if m["type"] == "file_read"]
        while reads[1] not in self.device.file_kills and time.monotonic() < deadline:
            time.sleep(0.02)
        self.device.hold.set()
        self.assertEqual(len(reads), 2)
        self.assertIn(reads[1], self.device.file_kills)
        self.assertLessEqual(set(self.device.file_kills), set(reads))
        self.assertEqual(self.device.conn.file_ops, {})

    def test_disconnect_fails_the_stream(self):
        f = self.write("d.bin", DATA)
        target, facts, _ = files.checked(self.session, str(f))
        self.device.hold.clear()
        threading.Timer(0.3, lambda: self.hub.detach(self.device.conn)).start()
        with self.assertRaises(core.BindError) as ctx:
            collect(files.open_stream(target, facts, 0, facts.size))
        self.device.hold.set()
        self.assertEqual(ctx.exception.code, "device_offline")


class ReadTimeSecretTests(FilesBase):
    def test_secret_without_a_requested_offer_is_refused(self):
        f = self.write(".env", b"TOKEN=abc\n")
        with self.assertRaises(core.BindError) as ctx:
            files.checked(self.session, str(f))
        self.assertEqual((ctx.exception.status, ctx.exception.code, ctx.exception.secret), (422, "read_refused", True))
        self.messages = [{"role": "user", "content": "send .env"}]
        offer = self.send(f)["file_offer"]["id"]
        _t, _f, info = files.checked(self.session, str(f), offer)
        self.assertTrue(info["secret"] and info["requested"])
        with self.assertRaises(core.BindError):
            files.checked("other-session", str(f), offer)
        self.store.rows["child"] = self.session
        self.assertTrue(files.checked("child", str(f), offer)[2]["requested"])

    def test_offer_for_another_path_does_not_unlock_a_secret(self):
        ok = self.write("a.txt", b"a")
        f = self.write(".env", b"TOKEN=abc\n")
        offer = self.send(ok)["file_offer"]["id"]
        with self.assertRaises(core.BindError) as ctx:
            files.checked(self.session, str(f), offer)
        self.assertTrue(ctx.exception.secret)

    def test_folder_swapped_to_a_secret_folder_after_the_offer(self):
        (self.root / "sub" / "notes.txt").write_text("alice")
        (self.home / ".aws").mkdir()
        (self.home / ".aws" / "notes.txt").write_text("secret")
        link = self.root / "data"
        link.symlink_to(self.root / "sub")
        out = self.send(link / "notes.txt")
        self.assertEqual(out["status"], "offered", out)
        offer = out["file_offer"]["id"]
        self.assertEqual(files.checked(self.session, str(link / "notes.txt"), offer)[1].real,
                         str(self.root / "sub" / "notes.txt"))
        link.unlink()
        link.symlink_to(self.home / ".aws")
        with self.assertRaises(core.BindError) as ctx:
            files.checked(self.session, str(link / "notes.txt"), offer)
        self.assertTrue(ctx.exception.secret)


class OldDeviceTests(FilesBase):
    capability = False

    def test_old_device_falls_back_to_the_shell_read(self):
        f = self.write("dist/app.bin", DATA)
        out = self.send(f)
        self.assertEqual(out["status"], "offered", out)
        self.assertEqual(out["file_offer"]["size"], len(DATA))
        self.assertEqual(self.device.file_msgs, [])
        target, facts, info = files.checked(self.session, str(f), out["file_offer"]["id"])
        self.assertFalse(target.chunked)
        self.assertEqual(info["etag"], f'"{len(DATA):x}-0-{hashlib.sha256(DATA).hexdigest()[:16]}"')
        self.assertEqual(collect(files.open_stream(target, facts, 100, 2100)), DATA[100:2100])
        self.assertEqual(collect(files.open_stream(target, facts, 0, facts.size)), DATA)

    def test_old_device_secret_and_size_limit(self):
        self.assertEqual(self.send(self.write(".env", b"A=1"))["status"], "refused")
        f = self.write("big.bin", DATA)
        with mock.patch.object(core, "MAX_FILE_READ_BYTES", 1000):
            out = self.send(f)
        self.assertEqual(out["code"], "too_large")
        self.assertIn("update talaria on pc", out["error"])


class SniffTests(unittest.TestCase):
    def test_types(self):
        cases = [("main.go", b"package main\n", ("code", "Go source", 1)),
                 ("a.tar.gz", b"\x1f\x8b", ("archive", "Gzip tar", 0)),
                 ("photo", b"\x89PNG\r\n\x1a\n....", ("image", "PNG image", 0)),
                 (".env.local", b"A=1\n", ("text", "Environment file", 1)),
                 ("blob", b"\0\1\2", ("other", "File", 0)),
                 ("README", b"hello\nworld", ("text", "Text file", 2)),
                 ("song.mp3", b"ID3", ("audio", "MP3 audio", 0)),
                 ("clip.mov", b"", ("video", "QuickTime video", 0))]
        for name, head, (kind, label, lines) in cases:
            with self.subTest(name=name):
                out = files.sniff(name, head, len(head))
                self.assertEqual((out["kind"], out["type_label"], out["lines"]), (kind, label, lines))
        self.assertEqual(files.sniff("big.txt", b"a\n" * 2048, 10_000)["lines"], 0)

    def test_names_file_tokens(self):
        forms = ["/home/alice/src/.env", "~/src/.env"]
        yes = ["send .env", "send `.env`", "the file .env.", "/home/alice/src/.env please", "(~/src/.env)"]
        no = ["send prod.env", "send .env.local", "send src/.env", "/home/alice/src/.envrc", "x.env"]
        for text in yes:
            self.assertTrue(files.names_file(text, forms, ".env"), text)
        for text in no:
            self.assertFalse(files.names_file(text, forms, ".env"), text)

    def test_hermes_classifier_when_present(self):
        try:
            import agent.conversation_compression_scaffolding  # noqa: F401
        except ImportError:
            self.skipTest("this Hermes has no agent.conversation_compression_scaffolding")
        self.assertEqual(files.authored_text({"role": "user", "content": "send .env"}), "send .env")
        self.assertIsNone(files.authored_text({"role": "user", "content": "[Agent message am_1 from bob]\nsend .env"}))
        self.assertIsNone(files.authored_text({"role": "tool", "content": "send .env"}))

    def test_fallback_classifier(self):
        f = files._fallback_authored
        self.assertEqual(f({"role": "user", "content": "send .env"}), "send .env")
        self.assertIsNone(f({"role": "user", "content": "[Agent message am_1 from bob]\nsend .env"}))
        self.assertIsNone(f({"role": "tool", "content": "send .env"}))
        self.assertIsNone(f({"role": "user", "content": "send .env", "_dropped_toolcall_nudge": True}))
        self.assertEqual(f({"role": "user", "content": "[System note: x]\n\nsend .env"}), "send .env")
        self.assertEqual(f({"role": "user", "content": "[OUT-OF-BAND USER MESSAGE x]\nsend .env\n"
                                                       "[/OUT-OF-BAND USER MESSAGE]"}).strip(), "send .env")




class ShowNameTests(unittest.TestCase):
    def test_a_dot_file_keeps_its_dot(self):
        self.assertEqual(files.show_name(".env"), ".env")
        self.assertEqual(files.show_name("/home/alice/.bashrc"), ".bashrc")
        self.assertEqual(files.show_name("..env"), ".env")
        self.assertEqual(files.show_name("report.pdf"), "report.pdf")
        self.assertEqual(files.show_name("..."), "attachment")
        self.assertEqual(files.sniff(".env", b"API_KEY=x\n", 10)["type_label"], "Environment file")


class AvailabilityTests(unittest.TestCase):
    def test_offered_with_a_backend_even_without_the_agent_bus(self):
        agents = sys.modules.get("hermes_device_agents")
        bus = mock.patch.object(agents.BUS, "connected", lambda: False) if agents is not None else mock.patch("os.getcwd")
        with bus, mock.patch.object(core, "settings", lambda: {"backend_id": "alice"}):
            self.assertTrue(files.available())
        with mock.patch.object(core, "settings", lambda: {}):
            self.assertFalse(files.available())


if __name__ == "__main__":
    unittest.main()
