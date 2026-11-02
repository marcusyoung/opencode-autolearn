---
id: TASK-10
title: Add Droid harness support to autolearn (hook-driven reviewer)
status: In Progress
assignee:
  - '@droid'
created_date: '2026-11-02T18:34:00Z'
updated_date: '2026-11-02T19:03:00Z'
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

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Approach
Add plugin/autolearn-droid.mjs, a hook-driven adapter shaped like plugin/autolearn-cursor.mjs. It reuses autolearn-core.mjs (ensureStore, parseConfig, formatReview, throttleCheck, spawnDetached, logObs, REVIEW_HEADING, HIDE_UV_VBS) and the dedupe helpers in autolearn-auth.mjs (readAuthState, writeAuthState, nextAuthState with scope "droid"). Droid fires real hooks, so the Cursor watcher, pid lock, slug reconstruction and Startup shortcut are not needed.

## Verified facts (2026-11-02)
- Hooks live in ~/.factory/hooks.json. Current events: SessionStart, UserPromptSubmit, Stop, Notification (Hindsight) and PreToolUse (cc-safety-net). ~/.factory/settings.json has no hooks key. Registration must append to existing event arrays, never replace them.
- Transcripts: ~/.factory/sessions/<cwd-slug>/<session_id>.jsonl. Line 1 is type=session_start (has cwd). Messages are type=message with message.role and message.content as a block array. Other line types: agent_turn_outcome, compaction_state, todo_state.
- User-role lines that are NOT genuine user messages: hook records (message.hookEventName set, content often empty), tool_result blocks, text blocks starting with "<system-reminder>", and "Skill \"x\" activated" notices. A genuine user message is a user line with at least one text block that is none of these.
- droid exec authenticates through the Droid login store: it replied "autolearn-ok" with FACTORY_API_KEY removed from the environment. Factory strips FACTORY_API_KEY, HINDSIGHT_API_KEY and SECRETCTL_PASSWORD from child processes even though they are set at User scope.
- droid has no auth status subcommand; droid doctor diagnoses auth (output format to be checked in step 3).
- review_complete is logged by the reviewer through autolearn.py log review-complete (reviewer.md), not by the adapter.

## Steps
1. Transcript parser: parseDroidTranscript(text) returns ordered {role, content} for genuine user text and assistant text only, plus cwd from session_start. Pure function, unit-tested with fixtures built from the shapes above.
2. Cadence: per-session state under personas/default/droid/<session_id>.json holding only lastReviewUserMsg and reviewedUpTo. userCount is recomputed from the transcript on every hook. Stop reviews when userCount - lastReviewUserMsg >= review_threshold. PreCompact and SessionEnd review any unreviewed slice (reviewedUpTo < messages.length) regardless of threshold. Throttle: throttleCheck(md,false) then throttleCheck(md,true) immediately before spawn; state advances only on an admitted spawn.
3. Auth preflight (see open decision): before writing any file, verify the reviewer can authenticate; on failure record one deduped auth_missing observation (trigger "droid") and exit 0.
4. Reviewer launch: droid exec --auto medium --cwd <session cwd> "<prompt naming the review file; load autolearn skill; follow references/reviewer.md>". Env adds AUTOLEARN_REVIEWER=1. On Windows route through wscript + hide-uv.vbs like the Cursor adapter so no console flashes. Log review_spawned with trigger "droid".
5. Hook entry point (--hook): read stdin JSON, exit 0 immediately if AUTOLEARN_DISABLED=1 or AUTOLEARN_REVIEWER=1, or transcript contains REVIEW_HEADING. Dispatch on hook_event_name for Stop, SessionEnd, PreCompact. Wrap everything in try/catch, print nothing, always exit 0.
6. Registration (--install / --install --remove): read ~/.factory/hooks.json, back it up, append one autolearn command entry ("node <path> --hook", timeout 30) to Stop, SessionEnd and PreCompact only if not already present (match on the autolearn-droid.mjs path), write back. --remove deletes only entries whose command references autolearn-droid.mjs and drops event keys left empty. hooksFile path overridable (AUTOLEARN_DROID_HOOKS) for tests.
7. Tests: plugin/test-droid-adapter.mjs with node --test: parser filtering, cadence idempotency across repeated Stop calls, PreCompact slice, hook registration add/idempotent/remove preserving foreign entries, auth gate dedupe. No network, no real droid.
8. Installer + docs: deploy/windows/install-windows.ps1 copies autolearn-droid.mjs + core + auth into ~/.factory/autolearn/ and runs --install; README harness table gains a Droid row.
9. End to end (AC #11): with the hooks registered, run a Droid session past review_threshold and confirm review_spawned then review_complete in observations.jsonl.

## Open decision (needs approval before step 3)
AC #8 says "checks FACTORY_API_KEY". That would always fail: the key is stripped from Factory child processes and droid exec does not need it. Proposed replacement: preflight passes if FACTORY_API_KEY is in the env, otherwise probe the login store (droid doctor, or a minimal droid exec if doctor output is not machine-readable); failures record one deduped auth_missing. AC #8 text would be updated to match.

## Risks
- Hook processes may not inherit AUTOLEARN_REVIEWER=1 from the reviewer's droid exec; the REVIEW_HEADING transcript guard is the backstop.
- A login-store probe costs time inside a hook; run it only when a review is actually due, not on every Stop.
- Stop hook timeout: the hook must finish within its timeout; all heavy work is in the detached reviewer.
- Blocks on the reviewer's permission level: --auto medium is assumed sufficient for uv run and writing ~/.autolearn; verify in step 9.

## Branching
Single branch task/TASK-10 from main with one commit per manifest row; one PR to origin main (board lives on main per the 2026-11-02 consolidation decision).

## Task Manifest

| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Create Droid transcript parser and cadence state | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | — | logic, test | Parser keeps only genuine user and assistant text, and repeated Stop evaluations over the same transcript trigger exactly one review, with tests passing |
| 2 | Add auth preflight and reviewer launch | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 1 | logic, test | A due review with failed auth writes no review file and records one auth_missing; with auth ok it spawns droid exec detached with AUTOLEARN_REVIEWER=1, with tests passing |
| 3 | Add hook entry point and dispatch | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 2 | logic, test | --hook reads stdin, handles Stop, SessionEnd and PreCompact, prints nothing and exits 0 for every input including malformed JSON |
| 4 | Add idempotent hook registration and removal | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 3 | infra, test | --install twice yields one autolearn entry per event with all foreign hooks intact, and --install --remove restores the original hooks.json content |
| 5 | Wire installer and README | deploy/windows/install-windows.ps1, README.md | 4 | infra | install-windows.ps1 deploys the adapter and registers the hooks, and README lists a Droid row in the harness table |
| 6 | Verify end to end | (no code) | 5 | test | A real Droid session crossing review_threshold logs review_spawned and review_complete in personas/default/observations.jsonl |
<!-- SECTION:PLAN:END -->
