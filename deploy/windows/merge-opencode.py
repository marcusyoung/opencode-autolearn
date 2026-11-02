"""Merge opencode-autolearn entries into opencode.json (Windows installer helper).

Mirrors the python block in the repo's install.sh, but is tolerant of JSONC
(trailing commas and // or /* */ comments) so it works against opencode's
config even when a human has edited it by hand. Writes strict JSON on output
(json.dump), matching install.sh's behaviour.

Does NOT write `plugin`/`plugins` entries for autolearn: local plugins in
~/.config/opencode/plugins/ are auto-discovered by opencode, so no config
entry is needed (amended 2026-09-06). Only the instructions entry and the
autolearn-reviewer agent are merged.

Run:  python3 merge-opencode.py
"""
import json
import re

PATH = r"C:\Users\myoun\.config\opencode\opencode.json"


def _strip_jsonc(text):
    """Remove // and /* */ comments (respecting string literals), then
    trailing commas before } or ]. Good enough for opencode.json."""
    out = []
    i, n = 0, len(text)
    in_str = False
    esc = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    cleaned = "".join(out)
    return re.sub(r",(\s*[}\]])", r"\1", cleaned)


def _as_list(v):
    return v if isinstance(v, list) else [v]


if __name__ == "__main__":
    if __import__("os").path.exists(PATH):
        with open(PATH, encoding="utf-8") as f:
            data = json.loads(_strip_jsonc(f.read()))
    else:
        data = {}

    changed = False

    # NOTE: no `plugin`/`plugins` entries are written for autolearn — local
    # plugins in ~/.config/opencode/plugins/ are auto-discovered by opencode.

    # Memory Insight context instruction (deduped against path variants:
    # ~-expanded, mixed separators, case differences)
    import os
    if "instructions" not in data:
        data["instructions"] = []
    instructions = _as_list(data["instructions"])
    ctx_entry = os.path.expanduser("~/.autolearn/personas/default/memory.context.md")
    ctx_norm = os.path.normpath(ctx_entry).lower()
    superseded = {
        os.path.normpath(os.path.expanduser("~/.autolearn/personas/default/memory.md")).lower(),
        os.path.normpath(os.path.expanduser("~/.autolearn/memory.md")).lower(),
    }
    kept = []
    for i in instructions:
        n = os.path.normpath(os.path.expanduser(i)).lower()
        if n in superseded or n == ctx_norm:
            changed = True
            continue
        kept.append(i)
    if ctx_entry not in kept:
        kept.append(ctx_entry)
        changed = True
    data["instructions"] = kept

    # Reviewer agent (bash:allow + write:allow => can auto-edit AGENTS.md once
    # its recurrence threshold is met). Tighten to "ask" if you don't want that.
    # The prompt points at the consolidated autolearn skill (upstream
    # consolidation 2026-09-21); the retired "Load the autolearn-reviewer skill"
    # text is replaced both on creation and on an existing agent.
    reviewer_prompt = (
        "Load the autolearn skill and follow references/reviewer.md to review "
        "the attached conversation for learning opportunities. Take immediate "
        "action: record observations, update memory, create or patch skills."
    )
    if "agent" not in data:
        data["agent"] = {}
    if "autolearn-reviewer" not in data["agent"]:
        data["agent"]["autolearn-reviewer"] = {
            "description": "Reviews past conversations for self-improvement opportunities",
            "hidden": True,
            "steps": 20,
            "prompt": reviewer_prompt,
            "permission": {
                "bash": "allow",
                "read": "allow",
                "glob": "allow",
                "grep": "allow",
                "write": "allow",
                "edit": "deny",
                "webfetch": "deny",
                "task": "deny",
                "skill": "allow",
                "external_directory": "allow",
            },
        }
        changed = True
    elif data["agent"]["autolearn-reviewer"].get("prompt") != reviewer_prompt:
        data["agent"]["autolearn-reviewer"]["prompt"] = reviewer_prompt
        changed = True

    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    print("  Updated " + PATH if changed else "  Already configured (" + PATH + ")")
