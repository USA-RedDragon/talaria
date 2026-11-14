"""project-memory 0.6: the index plus topics plus path notes layout."""
import json
import os

import pytest

from test_project_memory import project


@pytest.fixture
def mem(pm, hermes_home, monkeypatch):
    monkeypatch.setattr(pm, "_config", lambda: {"memory": {"memory_char_limit": 600}})
    monkeypatch.setattr(pm, "_approval_on", lambda: False)
    pm._STORES.clear()
    monkeypatch.setattr(pm, "_unattended_review", lambda: False)
    monkeypatch.setattr(pm, "children_blocked", lambda: False)
    pm._LOADED.clear()
    return pm


@pytest.fixture
def slug(mem, monkeypatch):
    s = project(mem)
    monkeypatch.setattr(mem, "project_for_session", lambda sid, live: (s, ""))
    return s


def write(mem, *ops, sid="s1"):
    return json.loads(mem.handle({"action": "write", "operations": list(ops)}, session_id=sid))


def read(mem, sid="s1", **args):
    return json.loads(mem.handle({"action": "read", **args}, session_id=sid))


def fill(mem, n=4):
    for i in range(n):
        assert write(mem, {"action": "add", "content": f"Fact {i}: " + "word " * 23})["success"]


def test_an_add_that_overflows_the_index_moves_its_detail_into_a_topic(mem, slug):
    fill(mem)
    before = mem.entries(slug)
    detail = "Release flow: tag on main after green CI. " + "Never tag a bot commit, check the subject first. " * 6
    out = write(mem, {"action": "add", "content": detail})
    assert out["success"], out
    moved = out["moved_to_topics"]
    assert len(moved) == 1 and moved[0]["new_topic"]
    name = moved[0]["topic"]
    assert name.startswith("release-flow")
    assert "went to topic " + name in out["message"]
    topic = mem.L.read_doc(mem.project_dir(slug), "topic", name)
    assert detail.strip() in topic["body"]
    after = mem.entries(slug)
    assert after[:len(before)] == before and len(after) == len(before) + 1
    assert after[-1].endswith(f"-> topic: {name}") and len(after[-1]) < 200
    assert len(mem._delim().join(after)) <= 600
    assert out["warning"].startswith("The index is")  # past 80%


def test_an_overflowing_add_joins_the_topic_it_fits_and_reuses_its_pointer(mem, slug):
    write(mem, {"action": "topic_write", "topic": "gb-timing", "description": "PPU timing modes and STAT interrupts",
                "content": "# PPU\n\nMode 3 is 172 dots plus sprites."},
          {"action": "add", "content": "PPU timing rules -> topic: gb-timing"})
    fill(mem)
    out = write(mem, {"action": "add", "content": "PPU timing: STAT interrupts block while the line stays high, "
                                                 "and mode 3 grows with the window. " * 3})
    assert out["success"] and out["moved_to_topics"][0]["topic"] == "gb-timing"
    assert not out["moved_to_topics"][0]["new_topic"]
    assert sum("-> topic: gb-timing" in e for e in mem.entries(slug)) == 1  # no second pointer
    body = mem.L.read_doc(mem.project_dir(slug), "topic", "gb-timing")["body"]
    assert "Mode 3 is 172 dots" in body and "STAT interrupts block" in body


def test_when_even_the_pointer_does_not_fit_the_text_goes_to_the_inbox(mem, slug, monkeypatch):
    monkeypatch.setattr(mem, "_config", lambda: {"memory": {"memory_char_limit": 200}})
    assert write(mem, {"action": "add", "content": "x " * 95})["success"]
    out = write(mem, {"action": "add", "content": "Deploys come from the release branch, not main."})
    assert out["success"] and out["inbox"] and "needs cleanup" in out["message"]
    inbox = mem.L.read_doc(mem.project_dir(slug), "topic", "inbox")
    assert "Deploys come from the release branch" in inbox["body"]
    assert mem.L.inbox_count(mem.project_dir(slug)) == 1
    assert "inbox topic holds 1 unsorted note" in mem.render_block(slug)


def test_a_patch_that_overflows_becomes_a_pointer(mem, slug):
    fill(mem)
    out = write(mem, {"action": "patch", "old_text": "Fact 1:", "content": "Fact 1 (long): " + "detail " * 60})
    assert out["success"] and out["moved_to_topics"]
    line = next(e for e in mem.entries(slug) if "Fact 1" in e)
    assert "-> topic:" in line and len(line) < 200


def test_add_with_a_topic_always_writes_the_topic(mem, slug):
    out = write(mem, {"action": "add", "topic": "mbc-quirks", "content": "MBC1 bank 0x20 maps to 0x21."})
    assert out["success"] and out["moved_to_topics"][0]["topic"] == "mbc-quirks"
    assert mem.entries(slug) == ["MBC1 bank 0x20 maps to 0x21. -> topic: mbc-quirks"]


def test_topic_read_by_name_paging_and_search(mem, slug, monkeypatch):
    out = write(mem, {"action": "topic_write", "topic": "Gb Timing", "description": "PPU modes",
                      "content": "# PPU\n\nThe LY=LYC compare fires at dot 4.\n"},
                {"action": "path_write", "path_note": "ppu-code", "paths": ["src/ppu/**"],
                 "content": "Every change here needs the mooneye tests."},
                {"action": "add", "content": "Mooneye tests gate every release."})
    assert out["success"], out
    got = read(mem, topic="gb-timing")
    assert got["success"] and "LY=LYC compare" in got["text"] and got["description"] == "PPU modes"
    missing = read(mem, topic="timing")
    assert not missing["success"] and missing["closest"] == ["gb-timing"]
    hits = read(mem, query="mooneye TESTS")["matches"]
    assert {h["where"] for h in hits} == {"index", "path"}
    assert read(mem, query="LYC compare")["matches"][0] == {"where": "topic", "name": "gb-timing", "line": 3,
                                                            "text": "The LY=LYC compare fires at dot 4."}
    monkeypatch.setattr(mem.L, "READ_PAGE", 10)
    first = read(mem, topic="gb-timing")
    assert first["text"] == "# PPU\n\nThe" and first["next_offset"] == 10 and "offset=10" in first["note"]
    assert read(mem, topic="gb-timing", offset=10)["text"].startswith(" LY=LYC")
    listing = json.loads(mem.handle({"action": "list"}, session_id="s1"))
    assert [t["name"] for t in listing["topics"]] == ["gb-timing"] and "entries" not in listing
    assert listing["path_notes"][0]["paths"] == ["src/ppu/**"]


def test_topic_append_patch_remove(mem, slug):
    assert write(mem, {"action": "topic_append", "topic": "notes", "content": "one"})["success"]
    assert write(mem, {"action": "topic_append", "topic": "notes", "content": "two"})["success"]
    assert write(mem, {"action": "topic_patch", "topic": "notes", "old_text": "two", "content": "three"})["success"]
    assert mem.L.read_doc(mem.project_dir(slug), "topic", "notes")["body"].strip() == "one\n\nthree"
    bad = write(mem, {"action": "topic_patch", "topic": "notes", "old_text": "zzz", "content": "x"})
    assert not bad["success"] and "occurs 0 times" in bad["error"]
    assert write(mem, {"action": "topic_remove", "topic": "notes"})["success"]
    assert mem.L.names(mem.project_dir(slug), "topic") == []
    assert not write(mem, {"action": "topic_remove", "topic": "notes"})["success"]
    assert not write(mem, {"action": "path_write", "path_note": "x", "content": "no paths"})["success"]
    assert not write(mem, {"action": "topic_write", "topic": "../etc", "content": "x"})["success"]


def test_a_check_failure_writes_nothing(mem, slug):
    out = write(mem, {"action": "topic_write", "topic": "a", "content": "kept?"},
                {"action": "topic_patch", "topic": "nope", "old_text": "x", "content": "y"})
    assert not out["success"] and "Nothing was written" in out["error"]
    assert mem.L.names(mem.project_dir(slug), "topic") == []


def test_subagents_read_topics_but_cannot_write_them(mem, slug, monkeypatch):
    monkeypatch.setattr(mem, "children_blocked", lambda: True)
    mem.note_child("child-9")
    mem.L.write_doc(mem.project_dir(slug), "topic", "t", "hello")
    assert read(mem, sid="child-9", topic="t")["text"].strip() == "hello"
    out = write(mem, {"action": "topic_append", "topic": "t", "content": "x"}, sid="child-9")
    assert not out["success"] and "Subagents may not" in out["error"]


# --- the prompt -------------------------------------------------------------------------------------

def test_the_prompt_holds_only_the_index_and_names(mem, slug):
    write(mem, {"action": "topic_write", "topic": "gb-timing", "content": "SECRET-TOPIC-BODY"},
          {"action": "path_write", "path_note": "ppu-code", "paths": ["src/ppu/**"], "content": "SECRET-PATH-BODY"},
          {"action": "add", "content": "Index line one"})
    block = mem.render_block(slug)
    assert "Index line one" in block
    assert "SECRET-TOPIC-BODY" not in block and "SECRET-PATH-BODY" not in block
    assert "Topics (read one with project_memory action read topic=<name>): gb-timing" in block
    assert "Path notes (they load when you read or edit a matching file): ppu-code" in block
    assert "% full" not in block


def test_the_prompt_warns_at_80_percent(mem, slug):
    fill(mem)
    block = mem.render_block(slug)
    assert "[The index is 8" in block or "[The index is 9" in block
    assert "Writes still succeed when it is full" in block


def test_many_topic_names_are_capped(mem, slug):
    for i in range(200):
        mem.L.write_doc(mem.project_dir(slug), "topic", f"topic-number-{i:03d}", "x")
    block = mem.render_block(slug)
    assert "more (project_memory action list)" in block and len(block) < 4000


# --- path notes -------------------------------------------------------------------------------------

@pytest.mark.parametrize("pattern,path,want", [
    ("src/ppu/**", "src/ppu/fetch.rs", True),
    ("src/ppu/**", "src/ppu/a/b.rs", True),
    ("src/ppu/**", "src/ppux/a.rs", False),
    ("src/ppu", "src/ppu/a.rs", True),
    ("src/*.rs", "src/a.rs", True),
    ("src/*.rs", "src/a/b.rs", False),
    ("*.sql", "db/migrations/1.sql", True),
    ("**/*.test.ts", "web/a/b.test.ts", True),
    ("web/**/*.{ts,css}", "web/x/y.css", True),
    (".github/workflows/*", ".github/workflows/ci.yaml", True),
    ("docs/", "docs/a.md", True),
])
def test_glob_matching(pm, pattern, path, want):
    assert pm.L.matches(pattern, path) is want


def test_patterns_are_cleaned(pm):
    assert pm.L.patterns("./src/**, *.sql\n.github/*") == ["src/**", "*.sql", ".github/*"]
    for bad in (["/etc/*"], ["../x"], [3]):
        with pytest.raises(pm.L.Bad):
            pm.L.patterns(bad)


def notes_setup(mem, slug, monkeypatch):
    write(mem, {"action": "path_write", "path_note": "ppu-code", "paths": ["src/ppu/**"],
                "content": "Keep the dot-accurate loop."},
          {"action": "path_write", "path_note": "rust", "paths": ["*.rs"], "content": "Run cargo fmt."})
    monkeypatch.setattr(mem, "_session_project_cached", lambda sid: (slug, "/w/demo", "/w/demo/sub"))
    monkeypatch.setattr(mem, "offered", lambda: True)


def test_a_path_note_loads_once_when_a_matching_file_is_read(mem, slug, monkeypatch):
    notes_setup(mem, slug, monkeypatch)
    res = json.dumps({"content": "fn main() {}"})
    first = mem.on_tool_result(tool_name="read_file", args={"path": "/w/demo/src/ppu/fetch.rs"}, result=res,
                               session_id="s1")
    assert first.startswith(res)
    assert "Keep the dot-accurate loop." in first and "Run cargo fmt." in first
    assert "loaded because this touched src/ppu/fetch.rs" in first
    again = mem.on_tool_result(tool_name="read_file", args={"path": "/w/demo/src/ppu/other.rs"}, result=res,
                               session_id="s1")
    assert again is None  # once per chat
    other = mem.on_tool_result(tool_name="patch", args={"path": "/w/demo/src/ppu/fetch.rs"}, result=res,
                               session_id="s2")
    assert "Keep the dot-accurate loop." in other  # another chat loads it too


def test_path_notes_skip_other_files_tools_and_failures(mem, slug, monkeypatch):
    notes_setup(mem, slug, monkeypatch)
    res = json.dumps({"content": "x"})
    assert mem.on_tool_result(tool_name="read_file", args={"path": "/w/demo/README.md"}, result=res, session_id="s") is None
    assert mem.on_tool_result(tool_name="read_file", args={"path": "/elsewhere/src/ppu/a.rs"}, result=res,
                              session_id="s") is None
    assert mem.on_tool_result(tool_name="terminal", args={"path": "/w/demo/src/ppu/a.rs"}, result=res,
                              session_id="s") is None
    failed = json.dumps({"error": "File not found"})
    assert mem.on_tool_result(tool_name="read_file", args={"path": "/w/demo/src/ppu/a.rs"}, result=failed,
                              session_id="s") is None
    # relative to the bound folder, and V4A patches
    rel = mem.on_tool_result(tool_name="read_file", args={"path": "../src/ppu/a.rs"}, result=res, session_id="s")
    assert "Keep the dot-accurate loop." in rel
    v4a = mem.on_tool_result(tool_name="patch", args={"mode": "patch", "patch": "*** Begin Patch\n*** Update File: "
                                                       "/w/demo/lib.rs\n@@\n-a\n+b\n*** End Patch"},
                             result=res, session_id="s3")
    assert "Run cargo fmt." in v4a and "dot-accurate" not in v4a


def test_path_notes_over_budget_list_the_others(mem, slug, monkeypatch):
    notes_setup(mem, slug, monkeypatch)
    monkeypatch.setattr(mem, "PATH_NOTE_BUDGET", 300)
    out = mem.on_tool_result(tool_name="read_file", args={"path": "/w/demo/src/ppu/a.rs"}, result="ok", session_id="s")
    assert "Keep the dot-accurate loop." in out and "Other project path notes match too: rust" in out


def test_a_rewritten_path_note_loads_again(mem, slug, monkeypatch):
    notes_setup(mem, slug, monkeypatch)
    args = {"path": "/w/demo/src/ppu/a.rs"}
    assert mem.on_tool_result(tool_name="read_file", args=args, result="ok", session_id="s")
    assert mem.on_tool_result(tool_name="read_file", args=args, result="ok", session_id="s") is None
    write(mem, {"action": "path_write", "path_note": "ppu-code", "content": "New rule."})
    assert "New rule." in mem.on_tool_result(tool_name="read_file", args=args, result="ok", session_id="s")


def test_the_probe_records_the_repository_top(mem, monkeypatch):
    slug = project(mem)
    with mem._locked():
        mem._note_folder(slug, "dev1", "pc", "/w/demo/sub", "/w/demo")
    mem._TOPS.clear()
    assert mem.repo_top("dev1", "/w/demo/sub") == "/w/demo"
    assert mem.repo_top("dev1", "/w/other") == "/w/other"


# --- migration ------------------------------------------------------------------------------------

def old_store(mem, entries):
    slug = project(mem)
    meta = mem.read_meta(slug)
    meta.pop("layout")
    mem._write_json(mem.base_dir() / slug / "meta.json", meta)
    path = mem.memory_path(slug)
    path.write_text(mem._delim().join(entries), encoding="utf-8")
    return slug, path


def test_migration_splits_long_entries_keeps_a_backup_and_is_idempotent(mem, monkeypatch):
    long_one = "Deploy procedure for staging. " + "Run the migration first, then roll the pods. " * 10
    slug, path = old_store(mem, ["Short fact.", long_one])
    original = path.read_bytes()
    got = mem.entries(slug)
    assert got[0] == "Short fact."
    assert got[1] == "Deploy procedure for staging. -> topic: deploy-procedure-staging-run"
    topic = mem.L.read_doc(mem.project_dir(slug), "topic", "deploy-procedure-staging-run")
    assert topic["body"].strip() == long_one.strip()
    backups = sorted(p.name for p in path.parent.glob("MEMORY.md.bak-*"))
    assert len(backups) == 1 and (path.parent / backups[0]).read_bytes() == original
    assert mem.read_meta(slug)["layout"] == 2 and mem.read_meta(slug)["migration_backup"] == backups[0]
    after = path.read_bytes()
    assert mem.ensure_layout(slug) is None and mem.entries(slug) == got  # second load: nothing changes
    assert path.read_bytes() == after and len(list(path.parent.glob("MEMORY.md.bak-*"))) == 1


def test_migration_of_short_entries_only_marks_the_layout(mem):
    slug, path = old_store(mem, ["a", "b"])
    assert mem.entries(slug) == ["a", "b"]
    assert mem.L.names(mem.project_dir(slug), "topic") == []
    assert len(list(path.parent.glob("MEMORY.md.bak-*"))) == 1  # the old file is kept anyway
    assert mem.read_meta(slug)["layout"] == 2


def test_a_new_project_needs_no_migration(mem):
    slug = project(mem)
    assert mem.read_meta(slug)["layout"] == 2 and mem.ensure_layout(slug) is None


def test_a_failed_migration_leaves_the_store(mem, monkeypatch):
    slug, path = old_store(mem, ["x" * 300])
    monkeypatch.setattr(mem.L, "write_doc", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    assert mem.entries(slug) == ["x" * 300]
    assert mem.read_meta(slug).get("layout") is None


# --- approval -------------------------------------------------------------------------------------

def test_staged_topic_writes_replay_with_the_spill(mem, slug, monkeypatch):
    from tools import write_approval as wa
    monkeypatch.setattr(mem, "_approval_on", lambda: True)

    class Decision:
        allow, blocked, message = False, False, "Staged for approval."

    staged = []
    monkeypatch.setattr(wa, "evaluate_gate", lambda *a, **k: Decision())
    monkeypatch.setattr(wa, "current_origin", lambda: "test")
    monkeypatch.setattr(wa, "stage_write", lambda kind, payload, **k: staged.append(payload) or {"id": "p1"})
    out = write(mem, {"action": "topic_write", "topic": "t", "content": "body"},
                {"action": "add", "content": "long " * 130})
    assert out["staged"] and mem.L.names(mem.project_dir(slug), "topic") == []

    def original(p, store):
        return store.apply_batch("memory", p["operations"])

    res = mem.apply_pending(staged[0], original)
    assert res["success"] and res["moved_to_topics"]
    assert "t" in mem.L.names(mem.project_dir(slug), "topic")


def test_unattended_review_stages_topic_rewrites_but_not_appends(mem, slug, monkeypatch):
    from tools import write_approval as wa
    monkeypatch.setattr(mem, "_unattended_review", lambda: True)
    monkeypatch.setattr(wa, "current_origin", lambda: "test")
    staged = []
    monkeypatch.setattr(wa, "stage_write", lambda kind, payload, **k: staged.append(payload) or {"id": "p2"})
    assert write(mem, {"action": "topic_append", "topic": "t", "content": "x"})["success"] and not staged
    assert write(mem, {"action": "topic_remove", "topic": "t"})["staged"] and staged


# --- hub routes -------------------------------------------------------------------------------------

def test_hub_add_spills_with_a_message(mem):
    slug = project(mem)
    for i in range(3):
        mem.add(slug, f"Fact {i}: " + "word " * 20)
    out = mem.add(slug, "Long thing. " + "more " * 80)
    assert "message" in out and "went to topic" in out["message"]
    assert out["topics"] and out["project"]["topics"] == 1 and out["project"]["total"] > out["project"]["used"]


def test_hub_topic_routes(mem):
    slug = project(mem)
    created = mem.put_doc(slug, "topic", "gb-timing", {"content": "hello", "description": "d", "create": True})
    assert created["content"].strip() == "hello" and created["list"][0]["name"] == "gb-timing"
    with pytest.raises(mem.Refused) as exc:
        mem.put_doc(slug, "topic", "gb-timing", {"content": "x", "create": True})
    assert exc.value.code == "exists"
    with pytest.raises(mem.Refused) as exc:
        mem.put_doc(slug, "topic", "gb-timing", {"content": "x", "base": "not what it was"})
    assert exc.value.code == "changed"
    renamed = mem.put_doc(slug, "topic", "gb-timing", {"content": "hi", "name": "ppu", "base": "hello"})
    assert renamed["name"] == "ppu" and [t["name"] for t in renamed["list"]] == ["ppu"]
    path = mem.put_doc(slug, "path", "web", {"content": "pnpm", "paths": "web/**, *.ts"})
    assert path["paths"] == ["web/**", "*.ts"]
    with pytest.raises(mem.Refused):
        mem.put_doc(slug, "path", "bad", {"content": "x"})
    assert mem.delete_doc(slug, "topic", "ppu")["items"] == []
    with pytest.raises(mem.Refused) as exc:
        mem.doc(slug, "topic", "ppu")
    assert exc.value.status == 404
    assert os.path.exists(mem.project_dir(slug) / "paths" / "web.md")
