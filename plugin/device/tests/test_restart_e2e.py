"""Commands across restarts and an update of the device daemon, end to end: the real exec route
on uvicorn and the plugin's Hub and DeviceProcess (the agent side), and a real ``talaria run``
under a systemd user service of its own, which the Go side restarts and updates mid-run.

internal/device/restarte2e starts this module with HERMES_RESTART_E2E_DIR set and drives the
daemon through files in that directory: this side writes ``port``, then ``started`` once the
commands run, and ``connected-<n>`` (the daemon's version) after each reconnect; the Go side
restarts the daemon after ``started`` and updates it after ``connected-1``. The result goes to
``result.json``. Skipped otherwise."""
from __future__ import annotations

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
from test_core import Store, core  # noqa: E402
from test_routes import plugin_api  # noqa: E402

DIR = os.environ.get("HERMES_RESTART_E2E_DIR", "")
ROOT = os.environ.get("HERMES_RESTART_E2E_ROOT", "")
DEVICE = "d_e2e"
LINES = 120


class Reader:
    """Reads a DeviceProcess's stdout as the agent's terminal tool does."""

    def __init__(self, proc):
        self.proc = proc
        self.chunks: list[str] = []
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            data = self.proc.stdout.read(1)
            if not data:
                return
            self.chunks.append(data)

    def text(self) -> str:
        return "".join(self.chunks)


@unittest.skipUnless(DIR, "run by internal/device/restarte2e with TALARIA_RESTART_E2E=1")
class RestartEndToEnd(unittest.TestCase):
    def setUp(self):
        import uvicorn
        from fastapi import FastAPI

        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.store = Store()
        self.hub = core.Hub(Path(self.tmp.name) / "bindings.json", parent_lookup=self.store.lookup)
        self.cfg = {"backend_id": "alice", "placeholder": self.tmp.name, "hub_public_key_env": "HERMES_RESTART_E2E_KEY",
                    "grace_seconds": 600}
        for p in (mock.patch.object(core, "hub", lambda: self.hub), mock.patch.object(core, "settings", lambda: self.cfg),
                  mock.patch.object(core, "grace_seconds", lambda: 600.0),
                  mock.patch.object(core, "hermes_version", lambda: "v0.22.7")):
            p.start()
            self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/device")
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        thread = threading.Thread(target=self.server.run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 10)
        self.addCleanup(setattr, self.server, "should_exit", True)
        self.wait(lambda: self.server.started, "uvicorn")
        port = self.server.servers[0].sockets[0].getsockname()[1]
        (Path(DIR) / "port").write_text(str(port))

    def wait(self, cond, what, timeout=120):
        deadline = time.monotonic() + timeout
        while not cond():
            if time.monotonic() > deadline:
                self.fail(f"timed out waiting for {what}")
            time.sleep(0.05)

    def note(self, name: str, text: str = "") -> None:
        path = Path(DIR) / name
        path.with_suffix(".tmp").write_text(text)
        path.with_suffix(".tmp").rename(path)
        print(f"[plugin] {name} {text}", flush=True)

    def reconnect(self, old, n: int):
        def back():
            d = self.hub.device(DEVICE)
            return d is not None and d is not old
        self.wait(back, f"reconnect {n}", timeout=180)
        conn = self.hub.device(DEVICE)
        self.note(f"connected-{n}", conn.client_version)
        return conn

    def test_commands_survive_restart_and_update(self):
        self.wait(lambda: self.hub.device(DEVICE) is not None, "the device to connect")
        conn = self.hub.device(DEVICE)
        self.note("connected-0", conn.client_version)
        start = lambda cmd, stdin=None: self.hub.start(DEVICE, cmd=cmd, cwd=ROOT, login=False, timeout=600, stdin=stdin)
        # A: prints a numbered line every 0.25s through both restarts, then exits 7.
        printer = Reader(start(f'for i in $(seq 1 {LINES}); do echo "line $i"; sleep 0.25; done; exit 7'))
        # B: waits for a gate made after the update, then reads its stdin.
        reader = Reader(start('echo waiting; while [ ! -e gate ]; do sleep 0.1; done; read -r l; echo "got $l"; exit 3',
                              stdin="hello from the agent\n"))
        # C: runs until the agent kills it after the update.
        victim = Reader(start('echo "pid $$"; sleep 600 & wait'))
        self.wait(lambda: printer.text().count("\n") >= 4 and "waiting" in reader.text() and "pid" in victim.text(),
                  "the commands to start")
        self.note("started", victim.text().split()[1])

        conn = self.reconnect(conn, 1)
        conn = self.reconnect(conn, 2)
        (Path(ROOT) / "gate").write_text("")
        time.sleep(0.5)
        victim.proc.kill()
        results = {}
        for name, r in (("printer", printer), ("reader", reader), ("victim", victim)):
            code = r.proc.wait(120)
            r.thread.join(10)
            results[name] = {"code": code, "output": r.text()}
        self.note("result.json", json.dumps(results))
        want_lines = "".join(f"line {i}\n" for i in range(1, LINES + 1))
        self.assertEqual(results["printer"], {"code": 7, "output": want_lines})
        self.assertEqual(results["reader"], {"code": 3, "output": "waiting\ngot hello from the agent\n"})
        self.assertEqual(results["victim"]["code"], core.EXIT_KILLED)
        self.assertTrue(results["victim"]["output"].startswith("pid "), results["victim"])


if __name__ == "__main__":
    unittest.main()
