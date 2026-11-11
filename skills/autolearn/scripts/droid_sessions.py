"""Factory Droid transcript parser for the search index.

Mirrors the user/assistant filter of ``parseDroidTranscript`` in
``plugin/autolearn-droid.mjs``; both are asserted against the shared fixture in
``plugin/fixtures/`` so the two cannot drift silently.

One deliberate difference: the JS parser counts untagged user lines (``droid
exec`` and subagent prompts) so review cadence sees every turn. For recurrence
evidence only *typed* user lines (those carrying ``userMessageSource``) count,
otherwise a parent's delegation prompt would register as a second session.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Iterator

DEFAULT_ROOT = Path.home() / ".factory" / "sessions"
ROOT_ENV = "AUTOLEARN_DROID_SESSIONS"

REVIEWER_PROMPT_PREFIX = "The autolearn session review is the file at "
CURATOR_PROMPT_PREFIX = "Load the autolearn skill and follow references/curator.md"

_NOTICE_RES = [
    re.compile(r"^\s*<system-reminder>"),
    re.compile(r'^Skill "[^"]*" activated'),
    re.compile(r"^Request interrupted by user"),
    re.compile(r"^Background task completed\."),
    re.compile(r"^/[\w-]+ is running"),
]


def sessions_root() -> Path:
    override = os.environ.get(ROOT_ENV)
    return Path(override) if override else DEFAULT_ROOT


def _text_blocks(content) -> list[str]:
    if isinstance(content, str):
        return [content]
    if not isinstance(content, list):
        return []
    return [
        b["text"] for b in content
        if isinstance(b, dict) and b.get("type") == "text"
        and isinstance(b.get("text"), str) and b["text"].strip()
    ]


def _iso_to_ms(value) -> int | None:
    if not isinstance(value, str):
        return None
    try:
        return int(datetime.fromisoformat(value).timestamp() * 1000)
    except ValueError:
        return None


def parse_transcript(path: Path) -> tuple[dict, list[dict]]:
    """Return ``(meta, messages)`` for one transcript file.

    ``meta``: ``session_id`` (file stem), ``title``, ``cwd``, ``skip`` (None,
    ``"reviewer"`` or ``"curator"``). ``messages`` are the rows to index:
    typed user text and assistant text, each ``{id, role, text, ts_ms}``.
    Reviewer and curator sessions return no messages, identified by their
    opening user prompt as in ``isReviewerSession`` in autolearn-core.mjs.
    Raises ``OSError`` when the file cannot be read, so callers can retry it
    instead of recording it as an empty transcript.
    """
    path = Path(path)
    meta: dict = {"session_id": path.stem, "title": "", "cwd": "", "skip": None}
    messages: list[dict] = []
    first_user: str | None = None
    last_ts = 0
    raw = path.read_text(encoding="utf-8", errors="replace")

    # Split on "\n" only: splitlines() also breaks on U+2028/U+0085, which
    # JSON.stringify writes unescaped inside strings.
    for lineno, line in enumerate(raw.split("\n"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        kind = obj.get("type")
        if kind == "session_start":
            if isinstance(obj.get("title"), str):
                meta["title"] = obj["title"]
            if isinstance(obj.get("cwd"), str) and obj["cwd"]:
                meta["cwd"] = obj["cwd"]
            last_ts = _iso_to_ms(obj.get("timestamp")) or last_ts
            continue
        m = obj.get("message")
        if kind != "message" or not isinstance(m, dict):
            continue
        ts = _iso_to_ms(obj.get("timestamp")) or last_ts
        last_ts = ts
        role = m.get("role")
        if role == "user":
            if m.get("hookEventName"):
                continue
            typed = bool(m.get("userMessageSource"))
            texts = [t for t in _text_blocks(m.get("content"))
                     if not (_NOTICE_RES[0].match(t) if typed else any(r.match(t) for r in _NOTICE_RES))]
            if not texts:
                continue
            body = "\n\n".join(texts)
            if first_user is None:
                first_user = body
            if not typed:
                continue
        elif role == "assistant":
            texts = _text_blocks(m.get("content"))
            if not texts:
                continue
            body = "\n\n".join(texts)
        else:
            continue
        messages.append({
            "id": str(obj.get("id") or f"line{lineno}"),
            "role": role,
            "text": body,
            "ts_ms": ts,
        })

    if first_user is not None:
        if first_user.startswith(REVIEWER_PROMPT_PREFIX):
            meta["skip"] = "reviewer"
        elif first_user.startswith(CURATOR_PROMPT_PREFIX):
            meta["skip"] = "curator"
    if meta["skip"]:
        messages = []
    return meta, messages


def iter_transcripts(root: Path) -> Iterator[Path]:
    """Yield ``<root>/<cwd-slug>/<session_id>.jsonl``; ``.json``/``.bak`` siblings are ignored."""
    root = Path(root)
    try:
        slugs = sorted(root.iterdir())
    except OSError:
        return
    for slug in slugs:
        if not slug.is_dir():
            continue
        try:
            files = sorted(slug.glob("*.jsonl"))
        except OSError:
            continue
        yield from (f for f in files if f.is_file())
