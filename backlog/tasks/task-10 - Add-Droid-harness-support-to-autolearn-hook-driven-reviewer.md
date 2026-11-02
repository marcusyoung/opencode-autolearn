---
id: TASK-10
title: Add Droid harness support to autolearn (hook-driven reviewer)
status: To Do
assignee: []
created_date: '2026-11-02T18:34:00Z'
labels: []
dependencies: []
references:
  - https://docs.factory.ai/reference/hooks-reference
  - plugin/autolearn-cursor.mjs
priority: high
type: feature
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Droid (Factory) already picks up the shared autolearn skill from ~/.agents/skills/autolearn, but nothing triggers a review, so Droid sessions accumulate no memory, rules or skill evidence. Unlike Cursor, Droid exposes real lifecycle hooks: Stop fires as each turn ends, SessionEnd when a session closes, and PreCompact before compaction, and every payload carries session_id and transcript_path on stdin. That removes the need for the Cursor adapter transcript watcher, pid lock and Startup shortcut. Add an additive adapter in the same shape as plugin/autolearn-cursor.mjs, reusing the shared core throttle, review format and observation log, and register the hooks in ~/.factory/hooks.json without disturbing the existing Hindsight hooks. The reviewer runs headless through droid exec and needs FACTORY_API_KEY at User level; hooks inherit the Factory process environment, so a newly set key needs an app restart. The hook must never block a turn: read, spawn detached, print nothing, exit 0.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 plugin/autolearn-droid.mjs exists, imports only Node/Bun builtins plus autolearn-core.mjs and autolearn-auth.mjs, and needs no node_modules.
- [ ] #2 A single hook entry point reads the JSON payload from stdin and dispatches on hook_event_name for Stop, SessionEnd and PreCompact, exits 0 and prints nothing, so a turn is never blocked or delayed by more than a transcript read.
- [ ] #3 A Droid transcript parser reads ~/.factory/sessions/<cwd-slug>/<session_id>.jsonl, keeps only user and assistant text, and excludes hook-injected messages from the user-message count.
- [ ] #4 Review cadence is idempotent across repeated Stop firings: the absolute user-message count is recomputed per session and only lastReviewUserMsg and reviewedUpTo are persisted, so a threshold crossing fires exactly once.
- [ ] #5 PreCompact reviews the unreviewed slice before compaction, so turns that would be summarized away are still reviewed.
- [ ] #6 The adapter reuses core.throttleCheck (peek, then commit on the actual spawn) so min_interval_ms, max_reviews_per_day and identical-content dedupe stay shared with the other harnesses.
- [ ] #7 The reviewer is spawned detached via droid exec against the review file, hidden on Windows so no console flashes, with AUTOLEARN_REVIEWER=1 so the reviewer own session is never reviewed.
- [ ] #8 An auth preflight checks FACTORY_API_KEY before any file is written and records one deduped auth_missing observation, instead of leaving an orphan review file that looks like a completed run.
- [ ] #9 Hook registration is idempotent and additive: it preserves the existing SessionStart, UserPromptSubmit, Stop and Notification hooks in ~/.factory/hooks.json, and a remove mode reverses only the autolearn entries.
- [ ] #10 README gains a Droid row in the harness support table, and deploy/windows/install-windows.ps1 registers the hooks during install.
- [ ] #11 End to end, a Droid session that crosses review_threshold produces review_spawned and review_complete in personas/default/observations.jsonl.
<!-- AC:END -->
