---
id: TASK-10
title: Add Droid harness support to autolearn (hook-driven reviewer)
status: In Progress
assignee:
  - '@droid'
created_date: '2026-11-02T18:34:00Z'
updated_date: '2026-11-02T19:48:00Z'
labels: []
dependencies: []
references:
  - https://docs.factory.ai/reference/hooks-reference
  - plugin/autolearn-cursor.mjs
documentation:
  - backlog/decisions/doc-3 - droid-auth-preflight.md
priority: high
type: feature
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Droid (Factory) already picks up the shared autolearn skill from ~/.agents/skills/autolearn, but nothing triggers a review, so Droid sessions accumulate no memory, rules or skill evidence. Unlike Cursor, Droid exposes real lifecycle hooks: Stop fires as each turn ends, SessionEnd when a session closes, and PreCompact before compaction, and every payload carries session_id and transcript_path on stdin. That removes the need for the Cursor adapter transcript watcher, pid lock and Startup shortcut. Add an additive adapter in the same shape as plugin/autolearn-cursor.mjs, reusing the shared core throttle, review format and observation log, and register the hooks in ~/.factory/hooks.json without disturbing the existing Hindsight and cc-safety-net hooks. The reviewer runs headless through droid exec, which authenticates with FACTORY_API_KEY when present and otherwise with the stored Droid login (see decision doc droid-auth-preflight). The hook must never block a turn: read, spawn detached, print nothing, exit 0.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 plugin/autolearn-droid.mjs exists, imports only Node/Bun builtins plus autolearn-core.mjs and autolearn-auth.mjs, and needs no node_modules.
- [x] #2 A single hook entry point reads the JSON payload from stdin and dispatches on hook_event_name for Stop, SessionEnd and PreCompact, exits 0 and prints nothing, so a turn is never blocked or delayed by more than a transcript read.
- [x] #3 A Droid transcript parser reads ~/.factory/sessions/<cwd-slug>/<session_id>.jsonl, keeps only user and assistant text, and excludes hook-injected messages from the user-message count.
- [x] #4 Review cadence is idempotent across repeated Stop firings: the absolute user-message count is recomputed per session and only lastReviewUserMsg and reviewedUpTo are persisted, so a threshold crossing fires exactly once.
- [x] #5 PreCompact reviews the unreviewed slice before compaction, so turns that would be summarized away are still reviewed.
- [x] #6 The adapter reuses core.throttleCheck (peek, then commit on the actual spawn) so min_interval_ms, max_reviews_per_day and identical-content dedupe stay shared with the other harnesses.
- [ ] #7 The reviewer is spawned detached via droid exec against the review file, hidden on Windows so no console flashes, with AUTOLEARN_REVIEWER=1 so the reviewer own session is never reviewed.
- [x] #8 An auth preflight runs before any file is written: it passes when FACTORY_API_KEY is set, otherwise requires `droid doctor --json --checks auth` to report auth.verify as pass, and on failure records one deduped auth_missing observation instead of leaving an orphan review file.
- [x] #9 Hook registration is idempotent and additive: it preserves the existing SessionStart, UserPromptSubmit, Stop and Notification hooks in ~/.factory/hooks.json, and a remove mode reverses only the autolearn entries.
- [ ] #10 README gains a Droid row in the harness support table, and deploy/windows/install-windows.ps1 registers the hooks during install.
- [x] #11 End to end, a Droid session that crosses review_threshold produces review_spawned and review_complete in personas/default/observations.jsonl.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Approach
Add plugin/autolearn-droid.mjs, a hook-driven adapter shaped like plugin/autolearn-cursor.mjs. It reuses autolearn-core.mjs (ensureStore, parseConfig, formatReview, throttleCheck, spawnDetached, logObs, REVIEW_HEADING, HIDE_UV_VBS) and autolearn-auth.mjs (a new resolveDroidAuth plus the existing readAuthState, writeAuthState and nextAuthState with scope "droid"). Droid fires real hooks, so the Cursor watcher, pid lock, slug reconstruction and Startup shortcut are not needed.

## Verified facts (2026-11-02)
- Hooks live in ~/.factory/hooks.json. Current events: SessionStart, UserPromptSubmit, Stop, Notification (Hindsight) and PreToolUse (cc-safety-net). ~/.factory/settings.json has no hooks key. Registration must append to existing event arrays, never replace them.
- Hook stdin carries session_id, transcript_path, cwd, permission_mode and hook_event_name (docs.factory.com/harness/hooks).
- Transcripts: ~/.factory/sessions/<cwd-slug>/<session_id>.jsonl. Line 1 is type=session_start (has cwd). Messages are type=message with message.role and message.content as a block array. Other line types: agent_turn_outcome, compaction_state, todo_state.
- User-role lines that are NOT genuine user messages: hook records (message.hookEventName set, content often empty), tool_result blocks, text blocks starting with "<system-reminder>", and "Skill \"x\" activated" notices. A genuine user message is a user line with at least one text block that is none of these.
- droid exec authenticates through the stored Droid login: it replied "autolearn-ok" with FACTORY_API_KEY absent. Factory strips FACTORY_API_KEY, HINDSIGHT_API_KEY and SECRETCTL_PASSWORD from tool-call shells even though they are set at User scope; whether hooks receive the key is unverified.
- `droid doctor --json --checks auth` exits 0 in ~0.6 s with no model call and reports result id auth.verify, status "pass", when the stored login is usable.
- review_complete is logged by the reviewer through autolearn.py log review-complete (reviewer.md), not by the adapter.

## Decisions (accepted 2026-11-02, see decision doc droid-auth-preflight)
- Auth preflight: pass if FACTORY_API_KEY is set; otherwise `droid doctor --json --checks auth` must report auth.verify "pass". Timeout, missing binary, non-JSON or any other status blocks the spawn and records one deduped auth_missing. Runs only when a review is due.
- resolveDroidAuth lives in plugin/autolearn-auth.mjs beside the Cursor check, reusing probeAuth's spawn/timeout/Windows-shim handling; tests in plugin/test-auth-guard.mjs.

## Steps
1. Transcript parser: parseDroidTranscript(text) returns ordered {role, content} for genuine user text and assistant text only, plus cwd from session_start. Pure function, unit-tested with fixtures built from the shapes above.
2. Cadence: per-session state under personas/default/droid/<session_id>.json holding only lastReviewUserMsg and reviewedUpTo. userCount is recomputed from the transcript on every hook. Stop reviews when userCount - lastReviewUserMsg >= review_threshold. PreCompact and SessionEnd review any unreviewed slice regardless of threshold. Throttle: throttleCheck(md,false) then throttleCheck(md,true) immediately before spawn; state advances only on an admitted spawn.
3. Auth preflight: add resolveDroidAuth to autolearn-auth.mjs (key short-circuit, then doctor probe and auth.verify classification) with tests; the adapter calls it after a review is due and before any file is written.
4. Reviewer launch: droid exec --auto medium --cwd <session cwd> "<prompt naming the review file; load autolearn skill; follow references/reviewer.md>". Env adds AUTOLEARN_REVIEWER=1. On Windows route through wscript + hide-uv.vbs like the Cursor adapter so no console flashes. Log review_spawned with trigger "droid".
5. Hook entry point (--hook): read stdin JSON, exit 0 immediately if AUTOLEARN_DISABLED=1 or AUTOLEARN_REVIEWER=1, or the transcript contains REVIEW_HEADING. Dispatch on hook_event_name for Stop, SessionEnd, PreCompact. Wrap everything in try/catch, print nothing, always exit 0.
6. Registration (--install / --install --remove): read ~/.factory/hooks.json, back it up, append one autolearn command entry ("node <path> --hook", timeout 30) to Stop, SessionEnd and PreCompact only if absent (match on the autolearn-droid.mjs path), write back. --remove deletes only entries referencing autolearn-droid.mjs and drops event keys left empty. Hooks file path overridable (AUTOLEARN_DROID_HOOKS) for tests.
7. Tests: plugin/test-droid-adapter.mjs with node --test: parser filtering, cadence idempotency across repeated Stop calls, PreCompact slice, registration add/idempotent/remove preserving foreign entries. No network, no real droid.
8. Installer + docs: deploy/windows/install-windows.ps1 copies autolearn-droid.mjs + core + auth into ~/.factory/autolearn/ and runs --install; README harness table gains a Droid row.
9. End to end (AC #11): with the hooks registered, run a Droid session past review_threshold and confirm review_spawned then review_complete in observations.jsonl. Also confirm whether hook processes receive FACTORY_API_KEY and AUTOLEARN_REVIEWER.

## Risks
- Hook processes may not inherit AUTOLEARN_REVIEWER=1 from the reviewer's droid exec; the REVIEW_HEADING transcript guard is the backstop.
- Stored-login tokens expire within hours and refresh in the background; a lapse is caught by the preflight and recorded once.
- Stop hook timeout: the hook must finish within its timeout; all heavy work is in the detached reviewer.
- --auto medium is assumed sufficient for the reviewer's uv run and writes under ~/.autolearn; verify in step 9.

## Branching
Single branch task/TASK-10 from main with one commit per manifest row; one PR to origin main (board lives on main per the 2026-11-02 consolidation decision).

## Task Manifest

| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Create Droid transcript parser and cadence state | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | — | logic, test | Parser keeps only genuine user and assistant text, and repeated Stop evaluations over the same transcript trigger exactly one review, with tests passing |
| 2 | Add Droid auth preflight and reviewer launch | plugin/autolearn-auth.mjs, plugin/test-auth-guard.mjs, plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 1 | logic, test | A due review with failed auth writes no review file and records one auth_missing; with auth ok it spawns droid exec detached with AUTOLEARN_REVIEWER=1, with tests passing |
| 3 | Add hook entry point and dispatch | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 2 | logic, test | --hook reads stdin, handles Stop, SessionEnd and PreCompact, prints nothing and exits 0 for every input including malformed JSON |
| 4 | Add idempotent hook registration and removal | plugin/autolearn-droid.mjs, plugin/test-droid-adapter.mjs | 3 | infra, test | --install twice yields one autolearn entry per event with all foreign hooks intact, and --install --remove restores the original hooks.json content |
| 5 | Wire installer and README | deploy/windows/install-windows.ps1, README.md | 4 | infra | install-windows.ps1 deploys the adapter and registers the hooks, and README lists a Droid row in the harness table |
| 6 | Verify end to end | (no code) | 5 | test | A real Droid session crossing review_threshold logs review_spawned and review_complete in personas/default/observations.jsonl |
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Row 1 done (parser + cadence). Plan refinement from real transcripts: typed user lines carry message.userMessageSource (e.g. desktop); droid exec prompts carry none, so untagged lines fall back to the exclusion filter, extended with harness notices 'Request interrupted by user', 'Background task completed.', '/<cmd> is running'. Verified on real sessions: 15/7/1 user messages match the typed counts exactly. Real session dir slug has a leading dash (-C-Users-...); the hook uses transcript_path so the slug is not reconstructed. Cursors clamp (not reset) if a transcript shrinks.

Rows 2-5 done. Row 2: probeAuth gained an optional classify option (Cursor default unchanged); resolveDroidAuth + classifyDroidDoctor added; reviewSession orders cadence -> auth -> throttle -> write -> spawn. Row 3: --hook always exit 0, no stdout/stderr, verified by subprocess tests. Row 4: registration round-trips a copy of the live hooks.json byte-identically. Row 5: installer step [3/8] + verify; README row, notes, uninstall. Tests: 78/78 (test-droid-adapter 34, test-auth-guard 35, test-schedule-health 9). No markdownlint CLI installed, README lint skipped. Note: the hook subprocess tests run core.ensureStore, which rewrites ~/.local/bin/hide-uv.vbs with identical content.

Row 6 end to end (2026-11-02): deployed to ~/.factory/autolearn, --install registered Stop/SessionEnd/PreCompact in live hooks.json (backup hooks.json.autolearn-2026-11-02T19-40-49-115Z.bak). Scratch session a4a79162 in %TEMP%\al-e2e: turns 1-9 with AUTOLEARN_DISABLED=1 (hooks logged status disabled, proving hook processes inherit the caller env); turn 10 Stop -> spawned review-1793648641798.md, SessionEnd -> not_due; observations.jsonl gained review_spawned (trigger droid) 19:44:01 and review_complete 19:45:28. Reviewer session 3860f6f0 ran uv run autolearn.py/improve.py commands with no permission denials under --auto medium; its own hooks returned reviewer_session. Auth state droid=ok source login-store (FACTORY_API_KEY absent in the exec shell). Still unverified: whether hooks started by the Desktop app receive FACTORY_API_KEY; no console flash (not visually observable by the agent); full install-windows.ps1 run (parse-checked only).
<!-- SECTION:NOTES:END -->
