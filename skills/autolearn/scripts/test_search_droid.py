# /// script
# dependencies = ["pytest", "python-slugify"]
# ///
"""Droid transcript indexing in search.db (TASK-10.2).

Every path is redirected into tmp_path: the persona dir, search.db, the OpenCode
database and the Droid sessions root. Nothing here may read ~/.factory or
~/.autolearn.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import autolearn
import droid_sessions

BASE = datetime(2026, 11, 11, 10, 0, 0, tzinfo=timezone.utc)
OLD_SCHEMA = """
    CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE session_text_content(
        rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL);
    CREATE VIRTUAL TABLE session_text USING fts5(
        session_id, message_id, role, text, project, timestamp,
        content=session_text_content, content_rowid=rowid);
    CREATE TABLE indexed_session(
        session_id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0, time_created INTEGER NOT NULL, time_indexed INTEGER NOT NULL);
"""


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "autolearn_home"
    persona = home / "personas" / "default"
    skills = persona / "skills"
    skills.mkdir(parents=True)
    (home / ".persona_registry.json").write_text('{"default": "default"}')
    droid_root = tmp_path / "droid_sessions"
    droid_root.mkdir()

    monkeypatch.setattr(autolearn, "DATA_HOME", home)
    monkeypatch.setattr(autolearn, "PERSONAS_DIR", home / "personas")
    monkeypatch.setattr(autolearn, "REGISTRY_FILE", home / ".persona_registry.json")
    monkeypatch.setattr(autolearn, "ACTIVE_PERSONA_DIR", persona)
    monkeypatch.setattr(autolearn, "SKILLS_DIR", skills)
    monkeypatch.setattr(autolearn, "ARCHIVE_DIR", skills / ".archive")
    monkeypatch.setattr(autolearn, "SEARCH_DB", persona / "search.db")
    monkeypatch.setattr(autolearn, "OPENCODE_DB", tmp_path / "opencode.db")
    monkeypatch.setattr(droid_sessions, "DEFAULT_ROOT", droid_root)
    monkeypatch.setenv(droid_sessions.ROOT_ENV, str(droid_root))
    return argparse.Namespace(home=home, persona=persona, root=droid_root, tmp=tmp_path,
                              search_db=persona / "search.db", opencode_db=tmp_path / "opencode.db")


def _line(obj) -> str:
    return json.dumps(obj) + "\n"


def msg_line(mid, sec, role, text, typed=True):
    m = {"role": role, "content": [{"type": "text", "text": text}]}
    if typed and role == "user":
        m["userMessageSource"] = "desktop"
    return _line({"type": "message", "id": mid, "timestamp": (BASE + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z"),
                  "seq": sec, "message": m})


def write_session(root: Path, sid: str, user_texts, *, slug="-C-work-demo", title="Demo session",
                  cwd="C:\\work\\demo-repo", start=0, typed=True) -> Path:
    d = root / slug
    d.mkdir(parents=True, exist_ok=True)
    out = [_line({"type": "session_start", "id": sid, "title": title, "cwd": cwd})]
    for i, t in enumerate(user_texts):
        out.append(msg_line(f"{sid}-u{i}", start + 2 * i, "user", t, typed=typed))
        out.append(msg_line(f"{sid}-a{i}", start + 2 * i + 1, "assistant", f"reply {i} for {sid}"))
    p = d / f"{sid}.jsonl"
    p.write_text("".join(out), encoding="utf-8")
    return p


def run_init(full=False):
    autolearn.cmd_search_init(argparse.Namespace(full=full))


def db(env) -> sqlite3.Connection:
    conn = sqlite3.connect(env.search_db)
    conn.row_factory = sqlite3.Row
    return conn


def content_count(env) -> int:
    conn = db(env)
    n = conn.execute("SELECT COUNT(*) FROM session_text_content").fetchone()[0]
    conn.close()
    return n


def fts_integrity_ok(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("INSERT INTO session_text(session_text) VALUES ('integrity-check')")
        return True
    except sqlite3.DatabaseError:
        return False


def make_opencode_db(path: Path, sessions: dict[str, list[tuple[str, str]]]):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE project(id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, project_id TEXT, time_created INTEGER);
        CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    """)
    conn.execute("INSERT INTO project VALUES ('p1', 'legacy-proj')")
    t = 1_700_000_000_000
    for sid, msgs in sessions.items():
        conn.execute("INSERT INTO session VALUES (?, ?, 'p1', ?)", [sid, f"Legacy {sid}", t])
        for i, (role, text) in enumerate(msgs):
            mid = f"{sid}-m{i}"
            conn.execute("INSERT INTO message VALUES (?, ?, ?)", [mid, sid, json.dumps({"role": role})])
            conn.execute("INSERT INTO part VALUES (?, ?, ?, ?, ?)",
                         [f"{mid}-p", mid, sid, t + i, json.dumps({"type": "text", "text": text})])
    conn.commit()
    conn.close()


# --- schema -----------------------------------------------------------------

def test_migration_is_idempotent_on_populated_opencode_style_db(env):
    conn = sqlite3.connect(env.search_db)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO session_text_content(session_id, message_id, role, text, project, timestamp) "
                 "VALUES ('ses_old', 'msg_1', 'user', 'legacy request text', 'p', 100)")
    conn.execute("INSERT INTO session_text_content(session_id, message_id, role, text, project, timestamp) "
                 "VALUES ('ses_old', 'msg_1', 'assistant', 'second part of the same message', 'p', 100)")
    conn.execute("INSERT INTO indexed_session VALUES ('ses_old', 'Old', 'p', 2, 100, 100)")
    conn.execute("INSERT INTO index_state VALUES ('last_part_time', '100')")
    conn.execute("INSERT INTO session_text(session_text) VALUES ('rebuild')")
    conn.commit()
    for _ in range(3):
        autolearn.init_search_schema(conn)
    assert conn.execute("SELECT COUNT(*) FROM session_text_content").fetchone()[0] == 2
    assert conn.execute("SELECT value FROM index_state WHERE key = 'last_part_time'").fetchone()[0] == "100"
    assert conn.execute("SELECT COUNT(*) FROM session_text WHERE session_text MATCH 'legacy'").fetchone()[0] == 1
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    assert {"idx_session_text_droid_message", "droid_file_state"} <= names
    conn.close()


def test_unique_index_covers_droid_ids_only(env):
    conn = sqlite3.connect(env.search_db)
    autolearn.init_search_schema(conn)
    ins = "INSERT INTO session_text_content(session_id, message_id, role, text, timestamp) VALUES (?, ?, 'user', 'x', 1)"
    conn.execute(ins, ["s", "msg_shared"])
    conn.execute(ins, ["s", "msg_shared"])
    conn.execute(ins, ["s", "droid:abc"])
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(ins, ["s2", "droid:abc"])
    conn.close()


# --- init -------------------------------------------------------------------

def test_init_indexes_droid_with_opencode_absent(env, capsys):
    write_session(env.root, "sess-a", ["how do I rotate the staging certificates", "and check expiry dates"],
                  title="Cert rotation", cwd="C:\\work\\cert-repo")
    assert not env.opencode_db.exists()
    run_init()
    out = capsys.readouterr().out
    assert "4 Droid messages from 1 sessions" in out

    conn = db(env)
    row = conn.execute("SELECT * FROM indexed_session WHERE session_id = 'sess-a'").fetchone()
    assert (row["title"], row["project"], row["message_count"]) == ("Cert rotation", "cert-repo", 4)
    assert row["time_created"] == int(BASE.timestamp() * 1000)
    roles = [r[0] for r in conn.execute("SELECT role FROM session_text_content ORDER BY timestamp")]
    assert roles == ["user", "assistant", "user", "assistant"]
    assert conn.execute("SELECT value FROM index_state WHERE key = 'last_droid_message_time'").fetchone()[0] == \
        str(int((BASE + timedelta(seconds=3)).timestamp() * 1000))
    assert fts_integrity_ok(conn)
    conn.close()

    autolearn.cmd_search_query(argparse.Namespace(terms="certificates", limit=5, context=0, session=None, project=None))
    assert "sess-a" in capsys.readouterr().out


def test_init_exits_1_only_when_no_source_exists(env, capsys):
    env.root.rmdir()
    with pytest.raises(SystemExit) as exc:
        run_init()
    assert exc.value.code == 1
    assert not env.search_db.exists()


def test_init_with_empty_droid_root_and_no_opencode_is_not_an_error(env, capsys):
    run_init()
    assert "up to date" in capsys.readouterr().out


def test_rerun_adds_no_rows(env, capsys):
    write_session(env.root, "sess-a", ["first request about caching layers"])
    run_init()
    n = content_count(env)
    capsys.readouterr()
    run_init()
    assert content_count(env) == n
    assert "up to date" in capsys.readouterr().out


def test_incremental_append_adds_only_new_rows(env):
    p = write_session(env.root, "sess-a", ["first request about caching layers"])
    run_init()
    with p.open("a", encoding="utf-8") as f:
        f.write(msg_line("sess-a-u9", 60, "user", "follow up about eviction policy"))
    run_init()
    conn = db(env)
    assert conn.execute("SELECT COUNT(*) FROM session_text_content").fetchone()[0] == 3
    assert conn.execute("SELECT message_count FROM indexed_session WHERE session_id = 'sess-a'").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM session_text WHERE session_text MATCH 'eviction'").fetchone()[0] == 1
    assert fts_integrity_ok(conn)
    conn.close()


def test_lost_file_state_cannot_duplicate_rows(env):
    write_session(env.root, "sess-a", ["first request about caching layers"])
    run_init()
    conn = db(env)
    conn.execute("DELETE FROM droid_file_state")
    conn.commit()
    conn.close()
    run_init()
    assert content_count(env) == 2
    conn = db(env)
    assert fts_integrity_ok(conn)
    assert conn.execute("SELECT message_count FROM indexed_session WHERE session_id = 'sess-a'").fetchone()[0] == 2
    conn.close()


def test_concurrent_indexers_produce_no_duplicates(env):
    for i in range(6):
        write_session(env.root, f"sess-{i}", [f"request number {i} about caching layers", "second line"])
    boot = sqlite3.connect(env.search_db)
    boot.execute("PRAGMA journal_mode=WAL")
    autolearn.init_search_schema(boot)
    boot.close()

    errors: list[BaseException] = []
    barrier = threading.Barrier(4, timeout=10)

    def worker():
        try:
            conn = sqlite3.connect(env.search_db, timeout=30)
            barrier.wait()
            autolearn.index_droid(conn, env.root)
            conn.close()
        except BaseException as exc:  # noqa: BLE001 - surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    conn = db(env)
    assert conn.execute("SELECT COUNT(*) FROM session_text_content").fetchone()[0] == 24
    assert conn.execute("SELECT COUNT(*) FROM indexed_session").fetchone()[0] == 6
    assert fts_integrity_ok(conn)
    conn.close()


def test_distinct_sessions_and_skipped_sessions(env):
    write_session(env.root, "sess-a", ["alpha request about caching layers"])
    write_session(env.root, "sess-b", ["beta request about caching layers"], slug="-C-work-other")
    write_session(env.root, "sess-untyped", ["delegated prompt about caching layers"], typed=False)
    for name in ("droid-transcript-reviewer", "droid-transcript-curator"):
        src = Path(__file__).resolve().parents[3] / "plugin" / "fixtures" / f"{name}.jsonl"
        if src.exists():
            (env.root / "-C-work-demo" / f"{name}.jsonl").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    (env.root / "-C-work-demo" / "sess-a.json").write_text("{}", encoding="utf-8")
    run_init()
    conn = db(env)
    sessions = {r[0] for r in conn.execute("SELECT session_id FROM indexed_session")}
    user_sessions = {r[0] for r in conn.execute("SELECT DISTINCT session_id FROM session_text_content WHERE role = 'user'")}
    conn.close()
    assert user_sessions == {"sess-a", "sess-b"}
    assert sessions == {"sess-a", "sess-b", "sess-untyped"}


def test_existing_opencode_rows_are_preserved(env):
    make_opencode_db(env.opencode_db, {"ses_oc": [("user", "legacy opencode request about backups"), ("assistant", "done")]})
    write_session(env.root, "sess-a", ["droid request about caching layers"])
    run_init()
    conn = db(env)
    assert conn.execute("SELECT COUNT(*) FROM session_text_content WHERE message_id LIKE 'droid:%'").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM session_text_content WHERE session_id = 'ses_oc'").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM session_text WHERE session_text MATCH 'backups'").fetchone()[0] == 1
    assert fts_integrity_ok(conn)
    conn.close()
    n = content_count(env)
    run_init()
    assert content_count(env) == n


def test_full_with_opencode_absent_keeps_legacy_rows_and_rebuilds_droid(env):
    conn = sqlite3.connect(env.search_db)
    conn.executescript(OLD_SCHEMA)
    conn.execute("INSERT INTO session_text_content(session_id, message_id, role, text, project, timestamp) "
                 "VALUES ('ses_old', 'msg_1', 'user', 'legacy request text', 'p', 100)")
    conn.execute("INSERT INTO indexed_session VALUES ('ses_old', 'Old', 'p', 1, 100, 100)")
    conn.execute("INSERT INTO index_state VALUES ('last_part_time', '100')")
    conn.commit()
    conn.close()
    write_session(env.root, "sess-a", ["droid request about caching layers"])
    run_init()
    run_init(full=True)
    conn = db(env)
    assert conn.execute("SELECT COUNT(*) FROM session_text_content").fetchone()[0] == 3
    assert conn.execute("SELECT COUNT(*) FROM indexed_session").fetchone()[0] == 2
    assert conn.execute("SELECT value FROM index_state WHERE key = 'last_part_time'").fetchone()[0] == "100"
    assert conn.execute("SELECT COUNT(*) FROM session_text WHERE session_text MATCH 'legacy'").fetchone()[0] == 1
    assert fts_integrity_ok(conn)
    conn.close()


def test_full_with_opencode_present_rebuilds_both(env):
    make_opencode_db(env.opencode_db, {"ses_oc": [("user", "legacy opencode request about backups")]})
    write_session(env.root, "sess-a", ["droid request about caching layers"])
    run_init()
    n = content_count(env)
    run_init(full=True)
    assert content_count(env) == n
    conn = db(env)
    assert fts_integrity_ok(conn)
    assert conn.execute("SELECT COUNT(*) FROM droid_file_state").fetchone()[0] == 1
    conn.close()


def test_status_reports_droid_state(env, capsys):
    write_session(env.root, "sess-a", ["first request about caching layers"])
    run_init()
    capsys.readouterr()
    autolearn.cmd_search_status(argparse.Namespace())
    out = capsys.readouterr().out
    assert "Droid transcripts tracked: 1" in out
    assert "Droid messages indexed: 2 across 1 sessions" in out
    assert "Last indexed message (Droid): never" not in out
