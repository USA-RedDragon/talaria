"""Every agent session has its own shell on a device: its own exported variables, its own cwd and
its own snapshot file, even though a chat and all its subagents share one binding. Run inside the
Hermes runtime with scripts/test-plugin.sh."""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_core import Base, core  # noqa: E402


class ShellScopeTests(Base):
    def setUp(self):
        super().setUp()
        self.tl = threading.local()
        patch = unittest.mock.patch.object(
            core, "current_session_id", lambda: getattr(self.tl, "sid", None) or self.session)
        patch.start()
        self.addCleanup(patch.stop)
        self.bind()
        self.env_ = self.env()

    def spawn(self, child, parent):
        """What Hermes does when it creates a subagent session."""
        self.store.rows[child] = parent
        self.hub.note_parent(child, parent)

    def run_as(self, sid, command):
        self.tl.sid = sid
        try:
            r = self.env_.execute(command)
        finally:
            self.tl.sid = None
        return r["output"].strip()

    def snapshots(self, want=None):
        """Snapshot files on the device; the removal is a device command, so wait for ``want``."""
        end = time.monotonic() + 5
        while True:
            found = sorted(p.name for p in self.devtmp.glob("hermes-snap-*.sh"))
            if want is None or len(found) == want or time.monotonic() > end:
                return found
            time.sleep(0.05)

    def test_two_sessions_do_not_share_exports(self):
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "export LANE_A=parent; export CARGO_TARGET_DIR=/x/parent")
        self.assertEqual(self.run_as("sess-2", 'echo "${LANE_A:-unset}:${CARGO_TARGET_DIR:-unset}"'), "unset:unset")
        self.run_as("sess-2", "export LANE_B=child")
        self.assertEqual(self.run_as("sess-1", 'echo "${LANE_A}:${LANE_B:-unset}"'), "parent:unset")
        self.assertEqual(len(self.snapshots()), 2)

    def test_cd_in_one_does_not_move_the_other(self):
        self.spawn("sess-2", "sess-1")
        self.assertEqual(self.run_as("sess-1", "cd sub && pwd"), str(self.root / "sub"))
        self.assertEqual(self.run_as("sess-2", "pwd"), str(self.root))
        self.run_as("sess-2", "cd sub/.. && mkdir -p other && cd other")
        self.assertEqual(self.run_as("sess-1", "pwd"), str(self.root / "sub"))
        self.assertEqual(self.run_as("sess-2", "pwd"), str(self.root / "other"))

    def test_child_starts_from_parent_cwd_at_spawn_not_later(self):
        self.run_as("sess-1", "cd sub")
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "cd ..")
        self.assertEqual(self.run_as("sess-2", "pwd"), str(self.root / "sub"))
        self.assertEqual(self.run_as("sess-1", "pwd"), str(self.root))

    def test_child_does_not_inherit_exports_later_changes_never_cross(self):
        self.run_as("sess-1", "export BEFORE=1")
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "export AFTER=1")
        self.assertEqual(self.run_as("sess-2", 'echo "${BEFORE:-unset}:${AFTER:-unset}"'), "unset:unset")

    def test_grandchild(self):
        self.spawn("sess-2", "sess-1")
        self.spawn("sess-3", "sess-2")
        self.run_as("sess-1", "export V=one; mkdir -p other; cd other")
        self.run_as("sess-2", "export V=two")
        self.run_as("sess-3", "export V=three; cd sub")
        self.assertEqual(self.run_as("sess-1", 'echo "$V:$(basename "$PWD")"'), "one:other")
        self.assertEqual(self.run_as("sess-2", 'echo "$V"'), "two")
        self.assertEqual(self.run_as("sess-3", 'echo "$V:$(basename "$PWD")"'), "three:sub")
        self.assertEqual(len(self.snapshots()), 3)

    def test_concurrent_commands(self):
        for n in (2, 3, 4):
            self.spawn(f"sess-{n}", "sess-1")
        errors, out = [], {}

        def lane(sid):
            try:
                self.tl.sid = sid
                for i in range(5):
                    self.env_.execute(f"export N=\"{sid}-{i}\"; sleep 0.05")
                    got = self.env_.execute("echo $N")["output"].strip()
                    if got != f"{sid}-{i}":
                        errors.append((sid, i, got))
                out[sid] = self.env_.execute("echo $N")["output"].strip()
            except Exception as exc:  # noqa: BLE001
                errors.append((sid, repr(exc)))

        threads = [threading.Thread(target=lane, args=(f"sess-{n}",)) for n in (1, 2, 3, 4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(60)
        self.assertEqual(errors, [])
        self.assertEqual(out, {f"sess-{n}": f"sess-{n}-4" for n in (1, 2, 3, 4)})

    def test_sibling_and_other_router_share_nothing(self):
        other = self.env()
        self.run_as("sess-1", "export ONLY_HERE=1")
        self.assertEqual(other.execute('echo "${ONLY_HERE:-unset}"')["output"].strip(), "unset")

    def test_subagent_stop_removes_its_snapshot_only(self):
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "true")
        self.run_as("sess-2", "export X=1")
        self.assertEqual(len(self.snapshots()), 2)
        before = set(self.snapshots())
        core.subagent_stop(child_session_id="sess-2")
        self.assertEqual(len(self.snapshots(want=1)), 1)
        self.assertTrue(set(self.snapshots()) < before)
        self.assertEqual(self.run_as("sess-1", "echo ok"), "ok")

    def test_woken_subagent_keeps_its_cwd(self):
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-2", "cd sub")
        core.subagent_stop(child_session_id="sess-2")
        self.assertEqual(self.run_as("sess-2", "pwd"), str(self.root / "sub"))

    def test_router_cleanup_removes_every_snapshot(self):
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "true")
        self.run_as("sess-2", "true")
        self.env_.cleanup()
        self.assertEqual(self.snapshots(want=0), [])

    def test_idle_subagent_shell_is_dropped_but_owner_stays(self):
        self.spawn("sess-2", "sess-1")
        self.run_as("sess-1", "export KEEP=1")
        self.run_as("sess-2", "true")
        for shell in self.env_._shells.values():
            shell.last_used -= core.IDLE_SHELL_SECONDS + 10
        self.run_as("sess-1", "true")
        self.assertEqual(sorted(k[0] for k in self.env_._shells), ["sess-1"])
        self.assertEqual(self.run_as("sess-1", "echo $KEEP"), "1")
        self.assertEqual(len(self.snapshots(want=1)), 1)


if __name__ == "__main__":
    unittest.main()
