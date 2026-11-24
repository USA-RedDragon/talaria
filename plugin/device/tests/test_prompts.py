"""Every permission prompt of the device plugin offers Allow once, Allow in this chat, Always allow the
specific thing it names (or says why Always means nothing there) and Deny. A static scan of the plugin
sources finds any prompt call without its rule; runtime tests check what each prompt path passes. Run
inside the Hermes runtime with scripts/test-plugin.sh."""
from __future__ import annotations

import ast
import inspect
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_browser import BrowserBase, browser
from test_core import core

REPO = Path(__file__).resolve().parents[3]
SOURCES = sorted(
    [p for p in (REPO / "plugin" / "device").glob("*.py")]
    + [p for p in (REPO / "plugins").rglob("*.py") if "tests" not in p.parts]
)

ALWAYS_EXEMPT = {
    ("plugin/device/browser.py", "_confirm"): "passes its caller's exemption on",
    ("plugin/device/browser.py", "_blocked_requests"): "blocked requests that name no host",
}

EMPTY = (None, "", (), [])


def _empty(node: ast.AST) -> bool:
    if isinstance(node, ast.Constant):
        return node.value in EMPTY
    if isinstance(node, (ast.List, ast.Tuple)):
        return not node.elts
    return False


def _name(call: ast.Call) -> str:
    f = call.func
    return f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""


def _kw(call: ast.Call, name: str):
    return next((k.value for k in call.keywords if k.arg == name), None)


def _scan() -> list[str]:
    problems: list[str] = []
    for path in SOURCES:
        rel = path.relative_to(REPO).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
        owner: dict[ast.AST, str] = {}
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for sub in ast.walk(fn):
                    if sub is not fn:
                        owner[sub] = fn.name
        for node in ast.walk(tree):
            where = f"{rel}:{getattr(node, 'lineno', 0)}"
            if isinstance(node, ast.Call):
                name = _name(node)
                if name == "_confirm":
                    rules = _kw(node, "rules") if _kw(node, "rules") is not None else (
                        node.args[1] if len(node.args) > 1 else None)
                    if rules is None or _empty(rules):
                        problems.append(f"{where}: _confirm without the specific rules it allows")
                elif name == "request_elicitation_consent":
                    key = _kw(node, "remember_key")
                    if key is None or _empty(key):
                        problems.append(f"{where}: request_elicitation_consent without remember_key")
                elif name == "request_tool_approval":
                    key = _kw(node, "rule_key")
                    if key is None or _empty(key):
                        problems.append(f"{where}: request_tool_approval without rule_key")
                exempt = _kw(node, "always_exempt")
                if exempt is not None and not _empty(exempt) and (rel, owner.get(node, "")) not in ALWAYS_EXEMPT:
                    problems.append(f"{where}: always_exempt outside the allow list in test_prompts.py")
            elif isinstance(node, ast.Dict):
                keys = {k.value: v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant)}
                action = keys.get("action")
                if isinstance(action, ast.Constant) and action.value == "approve":
                    rule = keys.get("rule_key")
                    if rule is None or _empty(rule):
                        problems.append(f"{where}: an approve request without rule_key")
                exempt = keys.get("always_exempt")
                if exempt is not None and not _empty(exempt) and (rel, owner.get(node, "")) not in ALWAYS_EXEMPT:
                    problems.append(f"{where}: always_exempt outside the allow list in test_prompts.py")
    return problems


class StaticScan(unittest.TestCase):
    def test_sources_found(self):
        names = {p.name for p in SOURCES}
        self.assertTrue({"browser.py", "batch.py", "jobs.py", "mcptools.py"} <= names, names)

    def test_every_prompt_names_its_rule(self):
        self.assertEqual(_scan(), [])

    def test_scan_catches_a_bare_prompt(self):
        bad = ast.parse("def f():\n    _confirm('x')\n    _confirm('x', rules=[])\n"
                        "    request_elicitation_consent('m', 'd')\n    request_tool_approval('t', 'r')\n"
                        "    request_tool_approval('t', 'r', rule_key='')\n"
                        "    return {'action': 'approve', 'message': 'm'}\n")
        calls = [n for n in ast.walk(bad) if isinstance(n, ast.Call)]
        flagged = [c for c in calls if _name(c) == "_confirm" and (
            _kw(c, "rules") is None and len(c.args) < 2 or _kw(c, "rules") is not None and _empty(_kw(c, "rules")))]
        self.assertEqual(len(flagged), 2)
        self.assertTrue(all(_kw(c, "remember_key") is None for c in calls if _name(c) == "request_elicitation_consent"))
        self.assertTrue(all(_kw(c, "rule_key") is None or _empty(_kw(c, "rule_key"))
                            for c in calls if _name(c) == "request_tool_approval"))

    def test_exemption_sites_carry_their_reason(self):
        for (rel, fn), _why in ALWAYS_EXEMPT.items():
            text = (REPO / rel).read_text(encoding="utf-8")
            self.assertIn(f"def {fn}(", text)
        body = (REPO / "plugin/device/browser.py").read_text(encoding="utf-8")
        start = body.index("def _blocked_requests(")
        chunk = body[start:body.index("\ndef ", start + 1)]
        line = chunk[:chunk.index("exempt = \"the")].rstrip().splitlines()[-1].strip()
        self.assertTrue(line.startswith("# "), "the exemption has a one-line comment with its reason")


class HermesPromptApi(unittest.TestCase):
    """The Hermes side of the contract (patch 0175)."""

    def test_elicitation_takes_always_exempt(self):
        from tools.approval_prompt import request_elicitation_consent
        p = inspect.signature(request_elicitation_consent).parameters
        if "always_exempt" not in p:
            self.skipTest("needs Hermes patch 0175 (request_elicitation_consent always_exempt)")
        self.assertEqual(p["always_exempt"].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertEqual(p["remember_key"].kind, inspect.Parameter.KEYWORD_ONLY)


class RuntimePrompts(BrowserBase):
    """Each prompt path passes the specific rule it allows."""

    def setUp(self):
        super().setUp()
        self.confirm.stop()
        self.addCleanup(self.confirm.start)
        self.asked: list[dict] = []
        self.answer_with = "decline"

        def consent(message, description, **kw):
            self.asked.append(dict(kw, message=message))
            return self.answer_with
        self.approvals: list[dict] = []

        def tool_approval(tool_name, reason, **kw):
            self.approvals.append(dict(kw, tool_name=tool_name))
            return {"approved": False}
        for target, fake in (("tools.approval_prompt.request_elicitation_consent", consent),
                             ("tools.approval.request_tool_approval", tool_approval)):
            p = mock.patch(target, fake)
            p.start()
            self.addCleanup(p.stop)
        for name, value in (("no_user", lambda: False), ("bypass", lambda: False), ("approved", lambda k: False)):
            p = mock.patch.object(browser, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_confirm_needs_a_rule(self):
        with self.assertRaises(ValueError):
            browser._confirm("Allow?", rules=[])
        with self.assertRaises(ValueError):
            browser._confirm("Allow?", rules=["", None])
        with self.assertRaises(TypeError):
            browser._confirm("Allow?")
        self.assertEqual(self.asked, [])

    def test_confirm_offers_this_chat_and_always_under_the_rule(self):
        browser._confirm("Allow?", rules=["browser:sensitive:pay.example.org"])
        self.assertEqual(self.asked[0]["remember_key"], "plugin_rule:browser:sensitive:pay.example.org")
        self.assertNotIn("always_exempt", self.asked[0])
        self.assertIn("(or always)", self.asked[0]["message"])

    def test_confirm_passes_an_exemption_on(self):
        browser._confirm("Allow?", rules=["browser:lift-private:unnamed-host"], always_exempt="no host")
        self.assertEqual(self.asked[0]["always_exempt"], "no host")
        self.assertEqual(self.asked[0]["remember_key"], "plugin_rule:browser:lift-private:unnamed-host")
        self.assertNotIn("(or always)", self.asked[0]["message"])

    def test_batch_ask_passes_the_step_rule(self):
        runner = browser._batch().Runner.__new__(browser._batch().Runner)
        b = mock.Mock(bypass=lambda: False, no_user=lambda: False)
        b._confirm.return_value = True
        runner.b = b
        runner.ask("This step is not in the steps you approved.", ["browser:click:acme.lightning.force.com"])
        self.assertEqual(b._confirm.call_args.kwargs["rules"], ["browser:click:acme.lightning.force.com"])
        with self.assertRaises(TypeError):
            runner.ask("no rule")

    def test_ask_allow_person_check_names_the_host(self):
        conn = self.device.conn
        browser.ask_allow(conn, "navigate", "private", "10.0.0.5", "a private address")
        self.assertEqual(self.asked[-1]["remember_key"], "plugin_rule:browser:allow-private:10.0.0.5")
        browser.ask_allow(conn, "navigate", "hub", "[::1]:8443", "the hub")
        self.assertEqual(self.asked[-1]["remember_key"], "plugin_rule:browser:allow-hub:[::1]:8443")
        self.assertEqual(self.approvals, [])

    def test_ask_allow_other_check_goes_to_the_gate_with_its_rule(self):
        browser.ask_allow(self.device.conn, "navigate", "visit", "www.example.org", "another site")
        self.assertEqual(self.approvals[-1]["rule_key"], "browser:visit:example.org")
        self.assertEqual(self.asked, [])

    def test_blocked_requests_without_a_host_keep_this_chat(self):
        token = browser._IN_HANDLER.set(True)
        self.addCleanup(browser._IN_HANDLER.reset, token)
        browser._blocked_requests(self.device.conn, [{"tab_id": 7, "hosts": [], "kinds": ["private"], "count": 2}])
        self.assertEqual(self.asked[-1]["remember_key"], "plugin_rule:browser:lift-private:unnamed-host")
        self.assertTrue(self.asked[-1]["always_exempt"])
        browser._blocked_requests(self.device.conn, [{"tab_id": 7, "hosts": ["10.0.0.9"], "kinds": ["private"],
                                                      "count": 1}])
        self.assertEqual(self.asked[-1]["remember_key"], "plugin_rule:browser:lift-private:10.0.0.9")
        self.assertNotIn("always_exempt", self.asked[-1])
        browser._blocked_requests(self.device.conn, [{"tab_id": 7, "hosts": ["cdn.example.net"], "kinds": ["taint"],
                                                      "count": 1}])
        self.assertEqual(self.approvals[-1]["rule_key"], "browser:lift-taint:tab")

    def test_unreadable_address_asks_for_that_address_only(self):
        self.fake.fail["inspect"] = (core.BROWSER_FAILED, "tab is gone")
        grant, approval = browser.decide("browser_navigate", {"url": "https://x.example/a", "tab_id": 7},
                                         self.device.conn)
        self.assertRegex(approval["rule_key"], r"^browser:visit:url-[0-9a-f]{16}$")
        _, other = browser.decide("browser_navigate", {"url": "https://x.example/b", "tab_id": 7}, self.device.conn)
        self.assertNotEqual(approval["rule_key"], other["rule_key"])


class SessionSignIn(BrowserBase):
    """A sign-in grant the user gave for this chat holds in this chat and its subagents only."""

    HOST = "login.example.com"

    def login_page(self):
        self.fake.inspect = {"url": f"https://{self.HOST}/authsvc", "host": self.HOST, "top_host": self.HOST,
                             "sensitive": ["password"], "autologin": True, "top_autologin": True,
                             "target": {"kind": "field", "field": "password"}}

    def test_this_chat_grant_asks_nothing_more_and_names_the_chat(self):
        self.login_page()
        self.fake.grants[self.HOST] = {"host": self.HOST, "method": "Password", "scope": "session",
                                       "session_id": self.session}
        out = self.run_tool("browser_login", tab_id=7)
        self.assertIsNone(self.decision)
        self.assertTrue(out["submitted"])
        self.assertIn(self.session, self.last("login")["args"]["session_ids"])
        status = [r for r in self.fake.requests if r["op"] == "login_grants" and r["args"].get("action") == "status"]
        self.assertIn(self.session, status[-1]["args"]["session_ids"])

    def test_another_chats_grant_raises_the_sign_in_card(self):
        self.login_page()
        self.fake.grants[self.HOST] = {"host": self.HOST, "method": "Password", "scope": "session",
                                       "session_id": "some-other-chat"}
        self.answer = False
        self.run_tool("browser_login", tab_id=7)
        self.assertEqual(self.decision["rule_key"], f"browser:login-grant:{self.device.conn.device_id}:{self.HOST}")
        self.assertIn("login_grant", self.decision)

    def test_chat_sessions_walks_to_the_chat(self):
        parents = {"sub-2": "sub-1", "sub-1": "chat"}
        with mock.patch.object(core.hub(), "_parent", lambda s: parents.get(s)):
            self.assertEqual(browser.chat_sessions("sub-2"), ["sub-2", "sub-1", "chat"])
        with mock.patch.object(core.hub(), "_parent", mock.Mock(side_effect=core.LineageError("gone"))):
            self.assertEqual(browser.chat_sessions("sub-2"), ["sub-2"])
        self.assertEqual(browser.chat_sessions(""), [])


if __name__ == "__main__":
    unittest.main()
