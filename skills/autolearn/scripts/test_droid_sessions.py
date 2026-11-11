# /// script
# dependencies = ["pytest"]
# ///
"""Tests for droid_sessions.py against the fixtures shared with plugin/test-droid-adapter.mjs."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import droid_sessions

FIXTURES = Path(__file__).resolve().parents[3] / "plugin" / "fixtures"

pytestmark = pytest.mark.skipif(
    not FIXTURES.is_dir(), reason="plugin/fixtures not present (skill installed without the repo)"
)


def _expected() -> dict:
    return json.loads((FIXTURES / "droid-transcript.expected.json").read_text(encoding="utf-8"))


def test_shared_fixture_matches_expected():
    exp = _expected()
    meta, msgs = droid_sessions.parse_transcript(FIXTURES / "droid-transcript.jsonl")
    assert meta["session_id"] == "droid-transcript"
    assert meta["title"] == exp["title"]
    assert meta["cwd"] == exp["cwd"]
    assert meta["skip"] is None
    indexed = [m for m in exp["messages"] if m["typed"] or m["role"] == "assistant"]
    assert msgs == [{"id": m["id"], "role": m["role"], "text": m["text"], "ts_ms": m["ts_ms"]} for m in indexed]


def test_untagged_user_prompt_is_not_indexed():
    exp = _expected()
    untagged = [m["text"] for m in exp["messages"] if m["role"] == "user" and not m["typed"]]
    assert untagged, "fixture must contain an untagged user prompt"
    _, msgs = droid_sessions.parse_transcript(FIXTURES / "droid-transcript.jsonl")
    assert not any(m["text"] in untagged for m in msgs)


def test_reminder_inside_typed_message_is_stripped_but_text_kept():
    _, msgs = droid_sessions.parse_transcript(FIXTURES / "droid-transcript.jsonl")
    assert "Also check\n\nthe expiry dates." in [m["text"] for m in msgs]
    assert not any("system-reminder" in m["text"] for m in msgs)


@pytest.mark.parametrize("name,reason", [
    ("droid-transcript-reviewer.jsonl", "reviewer"),
    ("droid-transcript-curator.jsonl", "curator"),
])
def test_reviewer_and_curator_sessions_are_skipped(name, reason):
    meta, msgs = droid_sessions.parse_transcript(FIXTURES / name)
    assert meta["skip"] == reason
    assert msgs == []


def test_quoted_reviewer_text_in_later_message_does_not_skip(tmp_path):
    p = tmp_path / "s.jsonl"
    lines = [
        {"type": "message", "id": "a", "timestamp": "2026-11-11T10:00:00.000Z",
         "message": {"role": "user", "userMessageSource": "desktop",
                     "content": [{"type": "text", "text": "How should I deploy this?"}]}},
        {"type": "message", "id": "b", "timestamp": "2026-11-11T10:00:01.000Z",
         "message": {"role": "user", "userMessageSource": "desktop",
                     "content": [{"type": "text", "text": droid_sessions.REVIEWER_PROMPT_PREFIX + "x"}]}},
    ]
    p.write_text("\n".join(json.dumps(x) for x in lines), encoding="utf-8")
    meta, msgs = droid_sessions.parse_transcript(p)
    assert meta["skip"] is None
    assert len(msgs) == 2


def test_malformed_and_missing_files_do_not_raise(tmp_path):
    p = tmp_path / "bad.jsonl"
    p.write_text("{not json\n\n42\nnull\n[1]\n", encoding="utf-8")
    assert droid_sessions.parse_transcript(p)[1] == []
    meta, msgs = droid_sessions.parse_transcript(tmp_path / "missing.jsonl")
    assert msgs == [] and meta["session_id"] == "missing"


def test_iso_timestamp_converts_to_epoch_ms():
    assert droid_sessions._iso_to_ms("2026-11-11T10:00:02.250Z") == 1794391202250
    assert droid_sessions._iso_to_ms("garbage") is None
    assert droid_sessions._iso_to_ms(None) is None


def test_iter_transcripts_only_yields_jsonl_in_slug_dirs(tmp_path):
    slug = tmp_path / "-C-work-demo"
    slug.mkdir()
    shutil.copy(FIXTURES / "droid-transcript.jsonl", slug / "aaa.jsonl")
    (slug / "aaa.json").write_text("{}", encoding="utf-8")
    (slug / "aaa.jsonl.bak").write_text("x", encoding="utf-8")
    (tmp_path / "stray.jsonl").write_text("x", encoding="utf-8")
    assert [p.name for p in droid_sessions.iter_transcripts(tmp_path)] == ["aaa.jsonl"]
    assert list(droid_sessions.iter_transcripts(tmp_path / "nope")) == []


def test_root_override(monkeypatch, tmp_path):
    monkeypatch.setenv(droid_sessions.ROOT_ENV, str(tmp_path))
    assert droid_sessions.sessions_root() == tmp_path
    monkeypatch.delenv(droid_sessions.ROOT_ENV)
    assert droid_sessions.sessions_root() == droid_sessions.DEFAULT_ROOT
