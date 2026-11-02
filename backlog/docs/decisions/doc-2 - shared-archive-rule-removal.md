---
id: doc-2
title: shared-archive-rule-removal
type: other
created_date: '2026-09-08 12:40'
---
# Decision Record: Shared rule-removal helper across all archive paths

**Task**: TASK-1
**Date**: 2026-09-08
**Status**: accepted

## Context
The task's acceptance criteria only mention `cmd_skill_archive` for rule removal. Research showed skill archiving actually occurs in three places in `autolearn.py`:
1. `cmd_skill_archive` (manual, line ~935)
2. Curator inactivity archive loop (`cmd_curator_run`, line ~1022; `archive_after_days`, default 90)
3. `prune_unused_skills` (line ~485, invoked from curator run at line ~1078; archives autolearn-created skills with `use_count == 0` past a grace period, default 60 days)

`falsify.apply_consequences` only demotes failing skills to `stale` — it never archives.

## Decision
Implement rule removal as a single shared helper (`remove_skill_rule(name)`) and call it from all three archive paths.

## Rationale
Restricting removal to the manual path would leak zombie rules whenever the curator's time-based or usage-based lifecycle paths archive a skill automatically. The two automatic paths are policy-driven hygiene (inactivity, never-used pruning), which is appropriate behavior — the gap was only that rule lifecycle did not follow it.

## Consequences
- Any future archive path must call the same helper; this is noted in the plan.
- The helper never raises — archive paths keep their existing failure semantics.
