---
id: doc-1
title: symlinked-rule-files
type: other
created_date: '2026-09-08 12:40'
---
# Decision Record: Symlinked rule files for autolearn-created skills

**Task**: TASK-1
**Date**: 2026-09-08
**Status**: accepted

## Context
autolearn-created skills need keyword rule files in `~/.config/opencode/rules/` for the frap129/opencode-rules plugin to surface them. The rule must be removable at archive time WITHOUT deleting a user's hand-written rule with the same name. The task description originally assumed plain real files in the rules dir.

## Decision
Store the canonical `rule.md` inside the skill directory (`~/.autolearn/personas/<persona>/skills/<name>/rule.md`) and symlink it into `~/.config/opencode/rules/<name>.md`, mirroring the existing `AGENTS_SKILLS_DIR` symlink pattern (autolearn.py `cmd_skill_create`).

## Rationale
- **Structural provenance**: at archive time, the rules-dir entry is deleted only if it is a symlink resolving into the persona skills dir. A hand-written rule is a real file and can never match — no content sniffing as the primary check.
- **Reversibility**: rule content travels with the skill into `skills/.archive/` on archive.
- **Precedent**: identical pattern to how skills are linked into `~/.agents/skills`.

## Fallback
When symlink creation fails (e.g. Windows without Developer Mode / symlink privilege), write a real file into the rules dir whose frontmatter carries `created_by: autolearn`. The removal helper then falls back to a frontmatter-marker test. This is a defense-in-depth pair: symlink-target check first, marker check second.

## Consequences
- `RULES_DIR` is host-global (env `OPENCODE_RULES_DIR` overridable), not persona-aware; multi-persona name collisions are theoretical and out of scope.
- Rule-writes must be non-fatal (skill creation succeeds even if the rules dir is unwritable).
