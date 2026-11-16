"""A write whose old_text matches nothing fails with the closest entries and saves nothing."""
import pytest

from test_project_memory import project
from test_project_memory_topics import write


@pytest.fixture
def mem(pm, hermes_home, monkeypatch):
    monkeypatch.setattr(pm, "_config", lambda: {"memory": {"memory_char_limit": 600}})
    monkeypatch.setattr(pm, "_approval_on", lambda: False)
    monkeypatch.setattr(pm, "_unattended_review", lambda: False)
    monkeypatch.setattr(pm, "children_blocked", lambda: False)
    pm._STORES.clear()
    pm._LOADED.clear()
    return pm


@pytest.fixture
def slug(mem, monkeypatch):
    s = project(mem)
    monkeypatch.setattr(mem, "project_for_session", lambda sid, live: (s, ""))
    return s


NOTES = ["Tests run with make test in the repo root", "Deploys come from the main branch after green CI"]


def seed(mem, slug):
    for n in NOTES:
        assert write(mem, {"action": "add", "content": n})["success"]
    return list(mem.entries(slug))


@pytest.mark.parametrize("op", [
    {"action": "remove", "old_text": "Tests run with make check"},
    {"action": "patch", "old_text": "make check", "content": "make test"},
    {"action": "replace", "old_text": "Tests run with make check", "content": "Tests run with make"},
])
def test_no_match_fails_and_saves_nothing(mem, slug, op):
    before = seed(mem, slug)
    out = write(mem, op)
    assert out["success"] is False
    assert "No entry matched" in out["error"]
    assert any("Tests run with make test" in e for e in out["closest_entries"])
    assert all(len(e) <= 120 for e in out["closest_entries"])
    assert mem.entries(slug) == before


@pytest.mark.parametrize("act", ["remove", "patch", "replace"])
def test_a_match_on_two_entries_fails_for_every_action(mem, slug, act):
    write(mem, {"action": "add", "content": "Release one is tagged by hand"})
    write(mem, {"action": "add", "content": "Release two is tagged by CI"})
    before = list(mem.entries(slug))
    out = write(mem, {"action": act, "old_text": "Release", "content": "x"})
    assert out["success"] is False
    assert len(out["closest_entries"]) == 2
    assert mem.entries(slug) == before


def test_a_failed_op_stops_the_whole_batch(mem, slug):
    before = seed(mem, slug)
    out = write(mem, {"action": "add", "content": "New fact"}, {"action": "remove", "old_text": "nothing like this"})
    assert out["success"] is False
    assert mem.entries(slug) == before


def test_topic_patch_with_no_match_fails(mem, slug):
    assert write(mem, {"action": "topic_write", "topic": "deploys", "content": "Tag main after CI."})["success"]
    out = write(mem, {"action": "topic_patch", "topic": "deploys", "old_text": "Tag staging", "content": "x"})
    assert out["success"] is False
    assert "occurs 0 times" in out["error"]
    assert "Tag main after CI." in out["closest_entries"][0]
    assert "Tag main after CI." in mem.L.read_doc(mem.project_dir(slug), "topic", "deploys")["body"]


def test_a_remove_reports_how_many(mem, slug):
    seed(mem, slug)
    write(mem, {"action": "add", "content": "Keep this one"})
    out = write(mem, {"action": "remove", "old_text": "make test"}, {"action": "remove", "old_text": "Deploys come"})
    assert out["success"] is True
    assert out["removed"] == 2
    assert "Removed 2" in out["message"]
    assert mem.entries(slug) == ["Keep this one"]


def test_a_remove_of_a_topic_that_is_missing_fails(mem, slug):
    out = write(mem, {"action": "topic_remove", "topic": "ghost"})
    assert out["success"] is False


def test_every_result_carries_the_project_name(mem, slug):
    out = write(mem, {"action": "add", "content": "A fact"})
    assert out["project_name"] == "demo"
    assert out["project"] == "github.com/alice/demo"
    import json
    assert json.loads(mem.handle({"action": "read"}, session_id="s1"))["project_name"] == "demo"
    bad = write(mem, {"action": "remove", "old_text": "nope"})
    assert bad["project_name"] == "demo"
