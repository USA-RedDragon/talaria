"""Moves the user makes in the hub, end to end: the real PUT binding route on uvicorn, with the
plugin's Hub and its lineage rules, takes binds from the hub's own Go client (Plugin.Move) with
move assertions the hub's Go code signs (protocol.md section 9, move rules).

hub/internal/device/movee2e_test.go drives it: run it with TALARIA_MOVE_E2E_DIR set, the Go test
with the same directory. This side sets up the sessions a device may not bind (one bound to another
computer, one that follows it through a parent, one that fails closed), writes ``port`` and
``key`` (the hub public key it trusts), waits for ``done`` from the Go side, and writes where each
session resolves to ``result.json``. Skipped otherwise."""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import FakeDevice, Store, core  # noqa: E402
from test_routes import plugin_api  # noqa: E402

DIR = os.environ.get("TALARIA_MOVE_E2E_DIR", "")
# The Go side signs with the private key of this seed; the plugin trusts only its public key.
SEED = bytes(range(101, 133))
USER = "user-e2e"


@unittest.skipUnless(DIR, "run with hub/internal/device/movee2e_test.go and TALARIA_MOVE_E2E_DIR")
class MoveEndToEnd(unittest.TestCase):
    def setUp(self):
        import uvicorn
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
        from fastapi import FastAPI

        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        base = Path(os.path.realpath(self.tmp.name))
        self.root = base / "home"
        (self.root / "docgen").mkdir(parents=True)
        public = Ed25519PrivateKey.from_private_bytes(SEED).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        key = base64.b64encode(public).decode()
        self.store = Store()
        self.store.rows.update({"s-direct": None, "s-parent": None, "s-branch": "s-parent", "s-gone": None})
        self.hub = core.Hub(base / "bindings.json", parent_lookup=self.store.lookup)
        self.cfg = {"backend_id": "alice", "placeholder": str(base / "ph"), "hub_public_key_env": "TALARIA_MOVE_E2E_KEY"}
        for p in (mock.patch.object(core, "hub", lambda: self.hub), mock.patch.object(core, "settings", lambda: self.cfg),
                  mock.patch.object(core, "hermes_version", lambda: "v0.22.7"),
                  mock.patch.dict(os.environ, {"TALARIA_MOVE_E2E_KEY": key})):
            p.start()
            self.addCleanup(p.stop)
        for device_id, name in (("d_framework", "framework-13"), ("d_upstairs", "upstairs-pc")):
            dev = FakeDevice(self.hub, str(self.root), str(base), str(self.root), device_id=device_id, name=name)
            dev.conn.user = USER
            self.addCleanup(dev.close)
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/device")
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        thread = threading.Thread(target=self.server.run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 10)
        self.addCleanup(setattr, self.server, "should_exit", True)
        self.wait(lambda: self.server.started, "uvicorn")
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def wait(self, cond, what, timeout=120):
        deadline = time.monotonic() + timeout
        while not cond():
            if time.monotonic() > deadline:
                self.fail(f"timed out waiting for {what}")
            time.sleep(0.05)

    def note(self, name: str, text: str) -> None:
        path = Path(DIR) / name
        path.with_suffix(".tmp").write_text(text)
        path.with_suffix(".tmp").rename(path)

    def test_hub_moves_what_a_device_may_not_bind(self):
        docgen = str(self.root / "docgen")
        for sid in ("s-direct", "s-parent", "s-gone"):
            self.hub.bind(sid, "d_framework", docgen)
        self.hub.unbind("s-gone")
        before = {sid: self.hub.resolve(sid).state for sid in ("s-direct", "s-branch", "s-gone")}
        self.assertEqual(before, {"s-direct": "bound", "s-branch": "bound", "s-gone": "fail_closed"})
        self.note("dir", docgen)
        self.note("port", str(self.port))
        self.wait(lambda: (Path(DIR) / "done").exists(), "the Go side")
        out = {}
        for sid in ("s-direct", "s-parent", "s-branch", "s-gone"):
            res = self.hub.resolve(sid)
            out[sid] = {"state": res.state, "via": res.via,
                        "device_id": res.binding.device_id if res.binding else "",
                        "dir": res.binding.dir if res.binding else ""}
        self.note("result.json", json.dumps(out))
        self.assertEqual(out["s-parent"]["device_id"], "d_framework", "the parent of a moved branch moved")
        for sid in ("s-direct", "s-branch", "s-gone"):
            self.assertEqual((out[sid]["state"], out[sid]["via"], out[sid]["device_id"], out[sid]["dir"]),
                             ("bound", sid, "d_upstairs", docgen), sid)


if __name__ == "__main__":
    unittest.main()
