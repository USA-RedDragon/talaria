"""A turn on the next gateway runs device commands while the old gateway still carries turns
(docs/protocol.md section 4.7 point 8): two gateways, each the real exec route on uvicorn with its
own Hub, and one scripted version 3 device over real WebSockets that, like ``talaria run``, keeps one
leg, parks its commands when the leg closes with 1001 and resumes them on its next connection.

Before relay.py the next gateway had no connection to the device until the old gateway handed over its
processes, so its calls waited for the device and failed (live: ``pre_tool_call plugin callback
timed out``).

The device also serves the browser leg (docs/browser.md): its Firefox extension's requests and
results ride the same exec leg, so they go over the link too. A browser call there did not wait for
a device that was away, as a terminal call does: a scheduled job's run on the next gateway got
``not_connected`` before the link was up and while the device moved over at the handoff, and a
browser call in flight at the handoff was cut."""
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
browser = None  # loaded by CarryRelayBrowserTests: a loaded but unregistered module changes the core guard


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
        self.browser_ops: list[tuple[int, str]] = []
        self.stopped = False
        self.reconnect_delay = 0.0

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

    def _browser(self, msg: dict, ws, leg: int) -> None:
        # Like talaria run: a browser request belongs to its leg, and the leg's end cancels it.
        time.sleep(float((msg.get("args") or {}).get("delay") or 0))
        with self.lock:
            if self.ws is not ws:
                return
        self.send({"type": "browser_result", "id": msg["id"], "ok": True,
                   "result": {"op": msg.get("op"), "leg": leg}})

    def run(self):
        from websockets.sync.client import connect
        while not self.stopped:
            if self.legs and self.reconnect_delay:
                time.sleep(self.reconnect_delay)
            try:
                ws = connect(self.url(), open_timeout=5, max_size=None)
            except Exception:
                time.sleep(0.1)
                continue
            ws.send(json.dumps({"type": "hello", "version": 2, "max_version": 3, "roots": [self.root],
                                "tmp_dir": self.root, "home": self.root, "hostname": "desk", "os": "linux",
                                "arch": "amd64", "client_version": "v0.0.0-test", "name": DEVICE, "token": "t",
                                "capabilities": ["browser"]}))
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
                leg = self.legs
                for rid, offset in named.items():
                    for m in self.cmds[rid]["log"] if rid in self.cmds else []:
                        if m["type"] == "exit" or m["offset"] + len(m["data"].encode()) > offset:
                            ws.send(json.dumps(m))
                ws.send(json.dumps({"type": "browser_status", "connected": True, "browser": "firefox"}))
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
                elif msg["type"] == "browser":
                    self.browser_ops.append((leg, msg["op"]))
                    threading.Thread(target=self._browser, args=(msg, ws, leg), daemon=True).start()
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


class _TwoGateways(unittest.TestCase):
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


class CarryRelayTests(_TwoGateways):
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


class CarryRelayBrowserTests(_TwoGateways):
    """The browser leg of a turn on the next gateway, chat and scheduled job, during a carry."""

    JOB = "job1"

    def setUp(self):
        global browser
        if "hermes_device_browser" not in sys.modules:
            self.addCleanup(sys.modules.pop, "hermes_device_browser", None)
        browser = core._load_sibling("hermes_device_browser", "browser.py")
        super().setUp()
        self.cfg["reconnect_wait_seconds"] = 15
        choice = {"device_id": DEVICE, "name": DEVICE, "user": ""}
        jobs = mock.Mock()
        jobs.job.side_effect = lambda job_id: dict(choice) if job_id == self.JOB else None
        jobs.session.return_value = None
        for p in (mock.patch.object(browser, "_core_ref", core), mock.patch.object(browser, "choices", lambda: jobs),
                  mock.patch.object(browser, "backend_user", lambda: ""),
                  mock.patch.object(browser, "_session_choice", lambda sid: None),
                  mock.patch.object(browser, "cron_job_id", lambda sid: self.JOB if sid == "cron_run" else "")):
            p.start()
            self.addCleanup(p.stop)

    def resolution(self, sid):
        if sid == "cron_run":
            return core.Resolution(core.STATE_NEVER_BOUND, sid)
        return core.Resolution(core.STATE_BOUND, sid, via=sid, root=sid, binding=core.Binding(
            session_id=sid, device_id=DEVICE, dir=self.root, generation="g1", bound_at=0.0))

    def on_next(self, sid, op, args=None):
        """A browser tool call of session ``sid`` on the next gateway, as its handler makes it:
        browser.target, then the operation. Returns a thread whose ``out`` is the result or the error."""
        def run():
            try:
                with mock.patch.object(browser, "resolve", lambda session_id="": (sid, self.resolution(sid))):
                    _res, conn = browser.target(sid, start=False)
                th.out = browser.call(conn, op, args or {}, 30)
            except Exception as exc:  # noqa: BLE001
                th.out = exc
        th = threading.Thread(target=run, name="next", daemon=True)
        th.out = None
        th.start()
        return th

    def result(self, th, timeout=30.0):
        th.join(timeout)
        self.assertFalse(th.is_alive(), "the browser call did not end")
        if isinstance(th.out, Exception):
            self.fail(f"the browser call failed: {th.out!r}")
        return th.out

    def released(self):
        handoff.carry_released(("127.0.0.1", self.new.port))
        self.wait(lambda: (self.new_hub.device(DEVICE) or mock.Mock(browser={})).browser.get("connected"),
                  "the device's browser on the next gateway", timeout=5)

    def hand_over(self):
        """The carrier hands its processes over: the device's next leg goes to the next gateway."""
        self.port = self.new.port
        handoff.prepare()
        handoff.handing_off = False  # the old process is gone; the module is shared in this test

    def test_browser_requests_of_the_next_gateway_go_over_the_link(self):
        self.released()
        conn = self.new_hub.device(DEVICE)
        self.assertIn(core.CAPABILITY_BROWSER, conn.capabilities)
        self.assertEqual(self.new_hub.browser_call(DEVICE, "tabs_list", {}, 10), {"op": "tabs_list", "leg": 1})
        # The carrier's own browser calls still work on the same leg.
        self.assertEqual(self.old_hub.browser_call(DEVICE, "snapshot", {}, 10), {"op": "snapshot", "leg": 1})
        self.assertEqual(self.device.legs, 1)
        for sid in ("chat", "cron_run"):
            self.assertEqual(self.result(self.on_next(sid, "navigate")), {"op": "navigate", "leg": 1})

    def test_a_job_run_on_the_next_gateway_before_the_link_waits_for_it(self):
        # The next gateway took over; its scheduler starts a job run before the carrier's link is up. The job's
        # device is no binding, so the next gateway has never seen it.
        th = self.on_next("cron_run", "navigate")
        time.sleep(0.5)
        self.assertTrue(th.is_alive(), f"the browser call did not wait for the device: {th.out!r}")
        handoff.carry_released(("127.0.0.1", self.new.port))
        self.assertEqual(self.result(th), {"op": "navigate", "leg": 1})

    def test_a_browser_call_in_flight_at_the_handoff_gets_its_result(self):
        self.released()
        calls = [self.on_next(sid, "snapshot", {"delay": 1.5}) for sid in ("chat", "cron_run")]
        self.wait(lambda: len(self.device.browser_ops) >= 2, "the browser calls to reach the device")
        time.sleep(0.2)
        mover = threading.Thread(target=self.hand_over, daemon=True)
        mover.start()
        for th in calls:
            self.assertEqual(self.result(th), {"op": "snapshot", "leg": 1})
        mover.join(10)
        self.wait(lambda: self.new_hub.device(DEVICE) is not None and self.device.legs >= 2,
                  "the device's leg to the next gateway")
        # A call after the move goes over the device's own leg to the next gateway.
        self.assertEqual(self.result(self.on_next("cron_run", "navigate")), {"op": "navigate", "leg": 2})

    def test_browser_calls_during_the_move_to_the_next_gateway_wait_for_the_device(self):
        self.released()
        self.device.reconnect_delay = 1.5
        self.hand_over()
        self.assertIsNone(self.new_hub.device(DEVICE))
        calls = [self.on_next(sid, "navigate") for sid in ("chat", "cron_run")]
        for th in calls:
            self.assertEqual(self.result(th), {"op": "navigate", "leg": 2})
        self.assertIsNone(self.old_hub.device(DEVICE))


if __name__ == "__main__":
    unittest.main()
