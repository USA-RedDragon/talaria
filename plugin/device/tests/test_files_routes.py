"""The file offer routes (docs/protocol.md section 9.3) against the real FastAPI router, with a
scripted device on Starlette's TestClient that answers file_stat and file_read with binary frames.
Run inside the Hermes runtime with scripts/test-plugin.sh."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import Store, core  # noqa: E402
from test_files import device_stat, files  # noqa: E402
from test_routes import PATH, Signer, plugin_api  # noqa: E402

FRAME = 300
DATA = bytes(range(256)) * 41 + b"tail"


class FileDevice(threading.Thread):
    """Runs exec with bash and serves file_stat and file_read like the Go client."""

    def __init__(self, ws, root: str):
        super().__init__(daemon=True)
        self.ws, self.root = ws, root
        self.file_msgs: list[dict] = []
        self.kills: list[str] = []

    def run(self):
        while True:
            try:
                raw = self.ws.receive()
            except Exception:
                return
            if raw.get("type") == "websocket.close" or raw.get("text") is None:
                if raw.get("type") == "websocket.close":
                    return
                continue
            msg = json.loads(raw["text"])
            kind = msg.get("type")
            if kind == "exec":
                p = subprocess.run(["bash", "-c", msg["cmd"]], cwd=msg["cwd"], capture_output=True, text=True,
                                   input=msg.get("stdin"))
                if p.stdout or p.stderr:
                    self.ws.send_json({"type": "output", "id": msg["id"], "data": p.stdout + p.stderr})
                self.ws.send_json({"type": "exit", "id": msg["id"], "code": p.returncode})
            elif kind == "ping":
                self.ws.send_json({"type": "pong", "seq": msg["seq"]})
            elif kind == "kill":
                self.kills.append(msg["id"])
            elif kind in ("file_stat", "file_read"):
                self.file_msgs.append(msg)
                self.file(msg)

    def file(self, msg):
        rid = msg["id"]
        st = device_stat(self.root, msg["path"])
        if msg["type"] == "file_stat" or not st["ok"]:
            self.ws.send_json({"type": "file_result", "id": rid, **st})
            return
        r = st["result"]
        if any(r[k] != msg[k] for k in ("dev", "ino", "size", "mtime_ns")):
            self.ws.send_json({"type": "file_result", "id": rid, "ok": False, "code": "changed", "error": "changed"})
            return
        sent = 0
        with open(msg["path"], "rb") as f:
            f.seek(msg["offset"])
            left = msg["length"]
            while left > 0:
                chunk = f.read(min(FRAME, left))
                if not chunk:
                    break
                self.ws.send_bytes(rid.encode() + chunk)
                sent += len(chunk)
                left -= len(chunk)
        self.ws.send_json({"type": "file_result", "id": rid, "ok": True, "result": {"bytes": sent}})


class FileRouteTests(unittest.TestCase):
    capability = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        base = Path(os.path.realpath(self.tmp.name))
        self.home = base / "home"
        self.root = self.home / "src"
        self.root.mkdir(parents=True)
        self.store = Store()
        self.store.rows.update({"s1": None, "u1": None})
        self.hub = core.Hub(base / "state" / "bindings.json", parent_lookup=self.store.lookup)
        self.signer = Signer()
        self.cfg = {"backend_id": "alice", "placeholder": str(base / "ph"), "hub_public_key_env": "TEST_HUB_KEY",
                    "reconnect_wait_seconds": 0}
        self.messages: list = []
        patches = [mock.patch.object(core, "hub", lambda: self.hub),
                   mock.patch.object(core, "settings", lambda: self.cfg),
                   mock.patch.object(core, "hermes_version", lambda: "v0.22.7"),
                   mock.patch.object(core, "hermes_image", lambda: ""),
                   mock.patch.object(core, "hermes_base_image", lambda: ""),
                   mock.patch.object(files, "WINDOW", 1000),
                   mock.patch.object(files, "_agent_messages", lambda: self.messages),
                   mock.patch.object(files, "_db_messages", lambda sid: None),
                   mock.patch.dict(os.environ, {"TEST_HUB_KEY": self.signer.public_b64})]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        files._OFFERS.clear()
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/device")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.ws = self.client.websocket_connect(PATH, headers={"X-Hermes-Device-Assertion": self.signer.sign()})
        self.ws.__enter__()
        self.addCleanup(lambda: self.ws.__exit__(None, None, None))
        hello = {"type": "hello", "version": 3, "max_version": 3, "roots": [str(self.home)], "tmp_dir": str(self.root),
                 "home": str(self.home), "hostname": "desktop", "os": "linux", "arch": "amd64", "shell": "bash",
                 "client_version": "v0.3.0", "capabilities": ["file_read"] if self.capability else []}
        self.ws.send_json(hello)
        self.welcome = self.ws.receive_json()
        self.ws.receive_json()  # resume
        self.device = FileDevice(self.ws, str(self.home))
        self.device.start()
        self.hub.bind("s1", "d_8f2c", str(self.root))

    def write(self, rel, data=DATA) -> Path:
        f = self.root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
        return f

    def stat(self, path, sid="s1", offer=""):
        return self.client.get(f"/api/plugins/device/sessions/{sid}/files/stat",
                               params={"path": str(path), "offer": offer})

    def stream(self, path, sid="s1", **params):
        return self.client.get(f"/api/plugins/device/sessions/{sid}/files/stream",
                               params={"path": str(path), **params})

    def test_welcome_accepts_file_read(self):
        self.assertIn("file_read", self.welcome["capabilities"])

    def test_stat_shape(self):
        f = self.write("dist/app.zip", b"PK\x03\x04" + DATA)
        r = self.stat(f)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        st = f.stat()
        self.assertEqual(body, {"name": "app.zip", "path": str(f), "real": str(f), "size": st.st_size,
                                "mtime": st.st_mtime_ns / 1e9, "mime": "application/zip", "kind": "archive",
                                "type_label": "Zip archive", "machine": "desktop", "machine_kind": "device",
                                "etag": f'"{st.st_size:x}-{st.st_mtime_ns:x}-{st.st_ino:x}"', "secret": False,
                                "requested": False})

    def test_stream_whole_file_in_windows(self):
        f = self.write("big.bin")
        r = self.stream(f)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(hashlib.sha256(r.content).hexdigest(), hashlib.sha256(DATA).hexdigest())
        st = f.stat()
        self.assertEqual(r.headers["content-length"], str(len(DATA)))
        self.assertEqual(r.headers["x-talaria-file-size"], str(len(DATA)))
        self.assertAlmostEqual(float(r.headers["x-talaria-file-mtime"]), st.st_mtime_ns / 1e9, places=6)
        self.assertEqual(r.headers["etag"], f'"{st.st_size:x}-{st.st_mtime_ns:x}-{st.st_ino:x}"')
        self.assertEqual(r.headers["cache-control"], "no-store")
        reads = [m for m in self.device.file_msgs if m["type"] == "file_read"]
        self.assertEqual([m["offset"] for m in reads], list(range(0, len(DATA), 1000)))

    def test_stream_ranges(self):
        f = self.write("r.bin")
        etag = self.stat(f).json()["etag"]
        for offset, length, want in ((0, 1, DATA[:1]), (999, 2, DATA[999:1001]), (1234, 4444, DATA[1234:5678]),
                                     (len(DATA) - 3, 100, DATA[-3:]), (len(DATA), -1, b""), (5000, -1, DATA[5000:])):
            with self.subTest(offset=offset, length=length):
                r = self.stream(f, offset=offset, length=length, etag=etag)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.content, want)
                self.assertEqual(r.headers["content-length"], str(len(want)))

    def test_changed_etag_is_412(self):
        f = self.write("c.bin")
        etag = self.stat(f).json()["etag"]
        f.write_bytes(DATA + b"!")
        r = self.stream(f, etag=etag)
        self.assertEqual(r.status_code, 412)
        self.assertEqual(r.json()["error"], "changed")
        self.assertNotEqual(r.json()["etag"], etag)

    def test_error_shapes(self):
        (self.root / "folder").mkdir()
        (self.home / "other").mkdir()
        cases = [(self.stat(self.root / "missing.txt"), 404, "not_found"),
                 (self.stat("relative.txt"), 400, "bad_path"),
                 (self.stat(str(self.root) + "/../x"), 400, "bad_path"),
                 (self.stat(self.root / "folder"), 422, "read_refused"),
                 (self.stat("/etc/hostname"), 422, "read_refused"),
                 (self.stream(self.root / "missing.txt"), 404, "not_found"),
                 (self.stream(self.write("x.bin"), offset=-1), 400, "bad_range"),
                 (self.stream(self.write("x.bin"), offset=len(DATA) + 1), 416, "bad_range")]
        for r, status, code in cases:
            with self.subTest(code=code, status=status):
                self.assertEqual(r.status_code, status, r.text)
                body = r.json()
                self.assertEqual(body["error"], code)
                self.assertIsInstance(body["message"], str)
                self.assertNotIn("secret", body)
        self.cfg["fallback"] = "refuse"
        r = self.stat(self.root / "x.bin", sid="u1")
        self.assertEqual((r.status_code, r.json()["error"]), (409, "fail_closed"))

    def test_device_offline_is_409(self):
        f = self.write("x.bin")
        self.hub.detach(self.hub.device("d_8f2c"))
        for r in (self.stat(f), self.stream(f)):
            self.assertEqual((r.status_code, r.json()["error"]), (409, "device_offline"))

    def test_secret_refused_without_a_requested_offer(self):
        f = self.write(".env", b"TOKEN=abc\n")
        for r in (self.stat(f), self.stream(f), self.stream(f, offer="fo_0123456789abcdef")):
            self.assertEqual(r.status_code, 422)
            self.assertEqual(r.json(), {"error": "read_refused", "message": r.json()["message"], "secret": True})

    def test_requested_secret_streams_through_its_offer(self):
        f = self.write(".env", b"TOKEN=abc\n")
        self.messages = [{"role": "user", "content": "send me .env"}]
        with mock.patch.object(core, "current_session_id", lambda: "s1"):
            out = json.loads(files.handler({"path": str(f)}, session_id="s1"))
        self.assertEqual(out["status"], "offered", out)
        offer = out["file_offer"]["id"]
        info = self.stat(f, offer=offer).json()
        self.assertTrue(info["secret"] and info["requested"])
        r = self.stream(f, offer=offer, etag=info["etag"])
        self.assertEqual((r.status_code, r.content), (200, b"TOKEN=abc\n"))
        self.assertEqual(self.stream(f).status_code, 422)

    def test_server_chat_reads_locally(self):
        self.store.rows["pod"] = None
        f = Path(self.tmp.name) / "server-file.txt"
        f.write_text("alice\nbob\n")
        info = self.stat(f, sid="pod").json()
        self.assertEqual((info["machine"], info["machine_kind"], info["kind"]), ("the Hermes server", "server", "text"))
        r = self.stream(os.path.realpath(f), sid="pod", offset=6)
        self.assertEqual((r.status_code, r.content), (200, b"bob\n"))


class OldDeviceRouteTests(FileRouteTests):
    capability = False

    def test_welcome_accepts_file_read(self):
        self.assertNotIn("capabilities", self.welcome)

    def test_stat_shape(self):
        f = self.write("a.txt", b"alice\n")
        body = self.stat(f).json()
        self.assertEqual((body["size"], body["mtime"], body["etag"]),
                         (6, 0.0, f'"6-0-{hashlib.sha256(b"alice\n").hexdigest()[:16]}"'))
        self.assertEqual(self.device.file_msgs, [])

    def test_stream_whole_file_in_windows(self):
        f = self.write("big.bin")
        r = self.stream(f)
        self.assertEqual((r.status_code, r.content), (200, DATA))
        self.assertEqual(self.device.file_msgs, [])

    def test_too_large_names_the_computer(self):
        f = self.write("big.bin")
        with mock.patch.object(core, "MAX_FILE_READ_BYTES", 1000):
            r = self.stream(f)
        self.assertEqual(r.status_code, 413)
        self.assertIn("update talaria on desktop", r.json()["message"])


if __name__ == "__main__":
    unittest.main()
