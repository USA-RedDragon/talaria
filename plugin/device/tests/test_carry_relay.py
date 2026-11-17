"""A turn on the next gateway runs device commands while the old gateway still carries turns
(docs/protocol.md section 4.7 point 8): two gateways, each the real exec route on uvicorn with its
own Hub, and one scripted version 3 device over real WebSockets that, like ``talaria run``, keeps one
leg, parks its commands when the leg closes with 1001 and resumes them on its next connection.

Before relay.py the next gateway had no connection to the device until the old gateway handed its
processes over, so its calls waited for the device and failed (live: ``pre_tool_call plugin callback
timed out``)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import Store, core  # noqa: E402
from test_restart_e2e import Reader  # noqa: E402
from test_routes import plugin_api  # noqa: E402

DEVICE = "d_desk"
handoff = core._load_sibling("hermes_device_handoff", "handoff.py")
relay = core._load_sibling("hermes_device_relay", "relay.py")


class Device(threading.Thread):
    """A version 3 device: one leg at a time to ``url()``; on a drop it keeps its commands and
    their output and answers the next leg's resume (section 4.7, device side)."""

    def __init__(self, url, root: str):
        super().__init__(daemon=True)
        self.url, self.root = url, root
        self.lock = threading.Lock()
        self.ws = None
        self.cmds: dict[str, dict] = {}
        self.legs = 0
        self.execs: list[str] = []
        self.stopped = False

    def send(self, msg: dict) -> None:
        with self.lock:
            ws = self.ws
            if ws is None:
                return
            try:
                ws.send(json.dumps(msg))
            except Exception:
                pass

    def _emit(self, rid: str, msg: dict) -> None:
        with self.lock:
            self.cmds[rid]["log"].append(msg)
        self.send(msg)

    def _exec(self, msg: dict) -> None:
        rid = msg["id"]
        p = subprocess.Popen(["bash", "-c", msg["cmd"]], cwd=msg["cwd"], stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True)
        with self.lock:
            self.cmds[rid] = {"proc": p, "log": []}
        offset = 0
        for line in iter(p.stdout.readline, b""):
            data = line.decode()
            self._emit(rid, {"type": "output", "id": rid, "data": data, "offset": offset})
            offset += len(line)
        self._emit(rid, {"type": "exit", "id": rid, "code": p.wait()})

    def run(self):
        from websockets.sync.client import connect
        while not self.stopped:
            try:
                ws = connect(self.url(), open_timeout=5, max_size=None)
            except Exception:
                time.sleep(0.1)
                continue
            ws.send(json.dumps({"type": "hello", "version": 2, "max_version": 3, "roots": [self.root],
                                "tmp_dir": self.root, "home": self.root, "hostname": "desk", "os": "linux",
                                "arch": "amd64", "client_version": "v0.0.0-test", "name": DEVICE, "token": "t"}))
            try:
                welcome = json.loads(ws.recv(timeout=5))
                if welcome.get("type") != "welcome":
                    raise ConnectionError(welcome)
                resume = json.loads(ws.recv(timeout=5))
            except Exception:
                ws.close()
                time.sleep(0.1)
                continue
            named = {c["id"]: c["offset"] for c in resume["commands"]}
            with self.lock:
                for rid, cmd in list(self.cmds.items()):
                    if rid not in named:
                        try:
                            os.killpg(cmd["proc"].pid, 9)
                        except OSError:
                            pass
                        cmd["proc"].stdout.close()
                        del self.cmds[rid]
                self.ws = ws
                self.legs += 1
                for rid, offset in named.items():
                    for m in self.cmds[rid]["log"] if rid in self.cmds else []:
                        if m["type"] == "exit" or m["offset"] + len(m["data"].encode()) > offset:
                            ws.send(json.dumps(m))
            while True:
                try:
                    msg = json.loads(ws.recv())
                except Exception:
                    break
                if msg["type"] == "ping":
                    self.send({"type": "pong", "seq": msg["seq"]})
                elif msg["type"] == "exec":
                    self.execs.append(msg["cmd"])
                    threading.Thread(target=self._exec, args=(msg,), daemon=True).start()
                elif msg["type"] == "kill":
                    with self.lock:
                        cmd = self.cmds.get(msg["id"])
                    if cmd is not None:
                        os.killpg(cmd["proc"].pid, 9)
            with self.lock:
                self.ws = None


class Gateway:
    def __init__(self, name: str, hub):
        import uvicorn
        from fastapi import FastAPI
        self.hub = hub
        app = FastAPI()
        app.include_router(plugin_api.router, prefix="/api/plugins/device")
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True, name=name)
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.02)
        self.port = self.server.servers[0].sockets[0].getsockname()[1]

    def stop(self):
        self.server.should_exit = True
        self.thread.join(10)


class CarryRelayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)
        self.root = os.path.realpath(self.tmp.name)
        store = Store()
        state = Path(self.root) / "device" / "bindings.json"  # one HERMES_HOME for both gateways
        self.old_hub = core.Hub(state, parent_lookup=store.lookup)
        self.new_hub = core.Hub(state, parent_lookup=store.lookup)
        self.cfg = {"backend_id": "alice", "placeholder": self.root, "grace_seconds": 600,
                    "reconnect_wait_seconds": 0.5}
        self.alive = True
        # Route handlers run on their server's thread: each gateway sees its own Hub.
        def pick():
            return self.new_hub if threading.current_thread().name == "next" else self.old_hub
        for p in (mock.patch.object(core, "hub", pick), mock.patch.object(core, "settings", lambda: self.cfg),
                  mock.patch.object(core, "grace_seconds", lambda: 600.0),
                  mock.patch.object(core, "dev_static_tokens", lambda: True),
                  mock.patch.object(core, "authenticate_static", lambda name, token: True),
                  mock.patch.object(core, "hermes_version", lambda: "v0.23.1"),
                  mock.patch.object(relay, "carrier_alive", lambda: self.alive),
                  mock.patch.object(handoff, "handing_off", False),
                  mock.patch.object(relay, "_links", {}), mock.patch.object(relay, "_target", None)):
            p.start()
            self.addCleanup(p.stop)
        self.old = Gateway("old", self.old_hub)
        self.addCleanup(self.old.stop)
        self.new = Gateway("next", self.new_hub)
        self.addCleanup(self.new.stop)
        self.port = self.old.port  # the hub routes the device here until the old gateway hands off
        self.device = Device(lambda: f"ws://127.0.0.1:{self.port}{core.PLUGIN_EXEC_PATH}", self.root)
        self.device.start()
        self.addCleanup(setattr, self.device, "stopped", True)
        self.wait(lambda: self.old_hub.device(DEVICE) is not None, "the device on the old gateway")

    def wait(self, cond, what, timeout=20.0):
        deadline = time.monotonic() + timeout
        while not cond():
            if time.monotonic() > deadline:
                self.fail(f"timed out waiting for {what}")
            time.sleep(0.02)

    def start(self, hub, cmd):
        return Reader(hub.start(DEVICE, cmd=cmd, cwd=self.root, login=False, timeout=120, stdin=None))

    def finish(self, reader, timeout=30.0):
        code = reader.proc.wait(timeout)
        reader.thread.join(5)
        reader.proc.stdout.close()
        return code, reader.text()

    def test_the_next_gateway_runs_commands_while_the_old_one_carries_a_foreground_command(self):
        # The carried turn's foreground command, on the old gateway.
        carried = self.start(self.old_hub, 'for i in $(seq 1 40); do echo "old $i"; sleep 0.05; done; exit 7')
        self.wait(lambda: "old 2" in carried.text(), "the carried command to run")
        # The device's one leg is the old gateway's: the next gateway cannot reach it on its own.
        code, out = self.finish(self.start(self.new_hub, "echo too early"))
        self.assertEqual(code, core.EXIT_LOST)
        self.assertIn("not connected", out)
        # The old gateway releases the profile (Hermes calls the reattach provider).
        handoff.carry_released(("127.0.0.1", self.new.port))
        self.wait(lambda: self.new_hub.device(DEVICE) is not None, "the device on the next gateway", timeout=5)
        # A turn on the next gateway runs a command at once, with its real output and exit.
        began = time.monotonic()
        code, out = self.finish(self.start(self.new_hub, "echo from the next gateway; exit 3"))
        self.assertEqual((code, out), (3, "from the next gateway\n"))
        self.assertLess(time.monotonic() - began, 2.0)
        # One that runs across the handoff below.
        across = self.start(self.new_hub, 'for i in $(seq 1 60); do echo "new $i"; sleep 0.05; done; exit 5')
        self.wait(lambda: "new 3" in across.text(), "the next gateway's long command to run")
        # The carried command ends with its real result, on the old gateway.
        code, out = self.finish(carried)
        self.assertEqual((code, out), (7, "".join(f"old {i}\n" for i in range(1, 41))))
        # No carried tool round left: the old gateway hands over; the device's next leg goes to the
        # next gateway and resumes the command it runs for it.
        self.port = self.new.port
        handoff.prepare()
        handoff.handing_off = False  # the old process is gone; the module is shared in this test
        self.wait(lambda: self.device.legs >= 2, "the device's leg to the next gateway")
        code, out = self.finish(across)
        self.assertEqual((code, out), (5, "".join(f"new {i}\n" for i in range(1, 61))))
        self.assertIsNone(self.old_hub.device(DEVICE))
        self.assertFalse((Path(self.root) / "device" / relay.KEY_NAME).exists())

    def test_a_kill_from_the_next_gateway_reaches_the_device(self):
        handoff.carry_released(("127.0.0.1", self.new.port))
        self.wait(lambda: self.new_hub.device(DEVICE) is not None, "the device on the next gateway", timeout=5)
        victim = self.start(self.new_hub, "echo up; sleep 60")
        self.wait(lambda: "up" in victim.text(), "the command to start")
        victim.proc.kill()
        code, _out = self.finish(victim, timeout=10)
        self.assertNotEqual(code, 0)
        self.assertIsNotNone(self.old_hub.device(DEVICE))  # the old gateway's leg is untouched

    def test_the_link_needs_the_key_and_a_live_carrier(self):
        self.alive = False
        handoff.carry_released(("127.0.0.1", self.new.port))
        time.sleep(1.0)
        self.assertIsNone(self.new_hub.device(DEVICE))
        from websockets.sync.client import connect
        self.alive = True
        with connect(f"ws://127.0.0.1:{self.new.port}{core.PLUGIN_EXEC_PATH}",
                     additional_headers={relay.HEADER: "0" * 64}) as ws:  # a live carrier, a wrong key
            with self.assertRaises(Exception):
                ws.recv(timeout=5)  # refused before any hello
            self.assertEqual(ws.close_code, core.CLOSE_ASSERTION_REFUSED)
        self.assertIsNone(self.new_hub.device(DEVICE))


if __name__ == "__main__":
    unittest.main()
