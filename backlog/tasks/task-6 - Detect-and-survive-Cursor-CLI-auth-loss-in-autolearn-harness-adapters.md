---
id: TASK-6
title: Detect and survive Cursor CLI auth loss in autolearn harness adapters
status: Done
assignee: []
created_date: '2026-10-26T13:39:00Z'
updated_date: '2026-10-27T14:40:00Z'
labels: []
dependencies: []
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Cursor reviewer and curator are spawned as detached `agent -p` children by the fork-only adapters `plugin/autolearn-cursor.mjs` and `plugin/autolearn-schedule.mjs`. Those children inherit the Cursor CLI's own login state, which autolearn neither owns nor checks. When that login lapsed after 2026-10-16 13:39, every spawn died at auth before reading its review file: 58 review files were written and orphaned, zero `review_complete` entries were logged, the wiki froze at 2026-10-16, memory/skills stopped updating, and the daily curator task reported failure (exit 1) with no visible alarm. Nothing in autolearn surfaced the breakage for ten days because the detached child's stderr is discarded by the windowless launcher and an abandoned review file is indistinguishable from a completed one. The goal is that a future auth loss is both survivable (a non-interactive credential source) and loud (a distinguishable failure record plus a staleness check), so silence can never again be mistaken for a healthy pipeline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A scan cycle with no usable Cursor CLI credential records a distinguishable auth-failure entry in the persona observation log and spawns no reviewer, verified against an isolated store
- [x] #2 Repeated failing scan cycles do not accumulate duplicate failure entries; the failure is recorded once per distinct auth state
- [x] #3 The curator job surfaces an auth failure as a non-zero exit with a message identifying it as an auth problem, rather than a generic failure code
- [x] #4 A scheduled check reports when review spawns exist but no review has completed within a configurable window (default 48 hours), and reports nothing when the pipeline is healthy
- [x] #5 A non-interactive credential source is documented and proven end to end: with it configured, a review completes in an isolated store without an interactive login
- [x] #6 The failure-detection behaviour is covered by automated tests, and the existing test suite still passes
- [x] #7 README and the Obsidian autolearn note document how the credential is sourced, how to recover from a lapse, and where each failure is visible
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Problem (evidence)

- `agent status --format json` -> `{"isAuthenticated": false}`; `agent -p --force "..."` exits 1 with `Authentication required`.
- Last `review_complete` in `~/.autolearn/personas/default/observations.jsonl`: 2026-10-16T12:46:59. Since then: 58 `review_spawned`, 0 `review_complete`.
- Wiki, `memories.jsonl`, `verdicts.json`, `.curator_state.json` all stop at 2026-10-16 13:0x-13:46.
- `AutoLearnCurator` scheduled task: LastTaskResult = 1. `AutoLearnTopicsScan`: 0 (pure Python, unaffected).
- Reviewer spawn path discards the child's stderr (`hide-uv.vbs` uses `sh.Run(..., 0, False)`; `spawnDetached` stdio ignore), so an auth death is indistinguishable from a completed review.
- Review files are written BEFORE launch (`autolearn-cursor.mjs` scan loop), so failures orphan .md files and advance per-conversation state.

## Approach

### 1. Non-interactive credential (survive)

`agent` resolves auth in this order: `CURSOR_API_KEY` env var, then its own interactive login store. Autolearn does not need to change how it spawns; it needs the env var present in the process tree that the watcher and both scheduled tasks run in. Document setting a user-scope `CURSOR_API_KEY` and note that `agent logout`/CLI upgrades cannot clear it.

Decision: autolearn never stores a credential itself. It only detects one and reports which source is in play (`env` vs `login-store`). Keeps the fork free of secret handling.

### 2. Preflight guard (fail loud)

New module `plugin/autolearn-auth.mjs`:

- `classifyAuthStatus(parsed)` - pure: given the parsed `agent status --format json` object, return `{ ok, source, reason }`. `ok = parsed.isAuthenticated === true`.
- `probeAuth(argv, { timeoutMs })` - spawns `argv`, parses JSON, returns `{ ok, source, reason, raw }`. Never throws. Testable with an arbitrary argv (e.g. `[process.execPath, '-e', '...']`).
- `cursorAuthArgv(bin)` - builds `[bin, 'status', '--format', 'json']`.
- `shortCircuitFromEnv(env)` - if `CURSOR_API_KEY` is non-empty, return `{ ok: true, source: 'env' }` without spawning (agent accepts the env key; probing would need a network round trip).
- `shouldRecordAuthFailure(state)` - dedupe on transition, persisted at `~/.autolearn/personas/default/cursor/.auth_state.json` as `{ state: 'ok'|'unauthenticated', reason, since }`. Log once per distinct `state+reason`.

Wiring:

- `autolearn-cursor.mjs` `scan()`: probe once per cycle at the top, before any review file is written. On failure: `core.logObs({ type: 'auth_missing', trigger: 'cursor', reason })` (deduped), `result.authError = true`, `result.spawned = 0`, return early. No review file, no per-conversation state advance, no throttle state change. `--scan` prints the reason instead of a zero-spawn success line.
- `autolearn-schedule.mjs` `resolveCuratorArgv()`: probe before returning the argv. `runJob('curator')` on auth failure: log `auth_missing`, write the reason to stderr, return exit code 3 (distinct from 1 = spawn failure, 2 = bad usage) so Task Scheduler's result code is diagnosable.
- Throttle note: the auth probe runs before `throttleCheck`, so a lapsed login never consumes the interval gate.

### 3. Staleness check (detect drift)

Add `runJob('health')` + `--health` CLI to `autolearn-schedule.mjs`, folded into the existing `topics` job so no new scheduled task is needed:

- Scan the tail of `observations.jsonl` (last `MAX_OBS_LINES`) for the newest `review_complete` timestamp.
- If the newest `review_spawned` is newer than the newest `review_complete` AND that gap exceeds `stale_after_hours` (config, default 48), report `stale` with both timestamps and the spawn/completion counts in the window.
- Healthy -> no output, exit 0. Stale -> stderr + `logObs({ type: 'pipeline_stale', ... })` + exit 4 from the topics job so the daily Task Scheduler result turns red.
- `topics` job remains exit 0 when only the python `topics scan` ran and nothing is stale.

### Files to create / modify

| File | Change |
|---|---|
| `plugin/autolearn-auth.mjs` | new - classify/probe/dedupe helpers |
| `plugin/autolearn-cursor.mjs` | scan preflight, early return, `--scan` output, auth state reset |
| `plugin/autolearn-schedule.mjs` | curator preflight + exit 3, health check in topics job, `--health` |
| `plugin/test-auth-guard.mjs` | new - `node --test` coverage |
| `README.md` | credential sourcing, recovery, failure visibility |
| `~/.obsidian vault note` | same, operational section |

### Constraints / risks

- `agent status` costs one process spawn per cycle (~1-2 s observed). At a 5-min tick that is negligible; do not probe per transcript.
- The probe must tolerate a missing/unresolvable binary (report `binary_missing`, not a crash).
- The windowless launcher discards stderr, so stderr alone is not a notification channel. The durable channel is `logObs` + the Task Scheduler result code. Anything louder (toast/email) is out of scope.
- `MAX_OBS_LINES` trimming means staleness lookback must stay inside the last 1000 lines; the current file is at exactly 999, so the check must not assume the whole history is present. Record counts found in the window, not absolute totals.
- Do not add a fourth scheduled task; folding health into `topics` keeps the install surface unchanged.
- Existing suite: `skills/autolearn/scripts/test_*.py` (pytest) must still pass; JS tests are new and additive.

### Open questions (resolved before implementation)

1. `CURSOR_API_KEY` versus relying on `agent login` alone - chosen: document the env var, do not require it (guards still work either way).
2. Exit codes: 1 = spawn failure, 2 = usage, 3 = curator auth, 4 = topics/health stale. No collision.

## Task Manifest

| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Add auth probe module + reviewer preflight | plugin/autolearn-auth.mjs, plugin/autolearn-cursor.mjs, plugin/test-auth-guard.mjs | - | logic | A scan with an unauthenticated probe spawns no reviewer, writes no review file, logs one deduped `auth_missing` observation, and JS tests pass |
| 2 | Curator auth exit code + stale-pipeline health check | plugin/autolearn-schedule.mjs, plugin/test-auth-guard.mjs | 1 | logic | Curator job exits 3 with an auth message when unauthenticated, and the topics job exits 4 only when spawns outrun completions past the window |
| 3 | Document credential sourcing and failure surfaces | README.md, Obsidian autolearn note | 1, 2 | infra | README and the vault note both state how the credential is sourced, the recovery step, and where each failure appears |
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Summary

Auth loss is now survivable, loud, and detectable. Three surfaces, all verified against isolated stores and against the live store (which is currently in the exact failure mode this fixes).

### 1. New `plugin/autolearn-auth.mjs`

- `classifyAuthStatus(parsed)` — pure verdict from `agent status --format json`; requires a literal `isAuthenticated: true`.
- `buildProbeCommand(argv, platform, comspec)` — on Windows, routes through `cmd /d /s /c`. **This was necessary**: `spawnSync("agent", ...)` returns `ENOENT` and `spawnSync("agent.cmd", ...)` returns `EINVAL`, so a naive probe reports a false `binary_missing` and blocks a healthy pipeline.
- `probeAuth(argv, opts)` — never throws; degrades to `binary_missing` / `probe_timeout` / `unparseable_status` / `status_exit_N` / `probe_failed:<code>`.
- `shortCircuitFromEnv(env)` — a non-empty `CURSOR_API_KEY` is treated as usable without spawning. This is load-bearing: `agent status` does **not** report the env key (`isAuthenticated:false` even with a key set), so without the short-circuit a key-only install would be permanently blocked.
- `nextAuthState(prev, verdict, now, scope)` — dedupe keyed per surface in a state map. Per-surface matters: a single shared entry made the curator's failure invisible because the watcher had already recorded it, and alternating surfaces would each overwrite the other and re-record forever.

### 2. Reviewer preflight (`autolearn-cursor.mjs`)

Probe runs at the top of `scan()`, before any review file, throttle check, or per-conversation state write. On failure: one deduped `auth_missing` observation, `result.authError`, zero spawns, early return. `main()` now propagates the exit code (it previously discarded the return value entirely, so `return 3` was inert); entrypoint exits 3.

### 3. Curator + health check (`autolearn-schedule.mjs`)

- `curatorBin()` extracted from `resolveCuratorArgv()` so the gate can probe the same binary that will actually run.
- Curator probe runs before argv construction → exit `3` with a message naming auth, vs `1` for a spawn failure.
- `checkPipelineHealth()` / `reportHealth()` — reads the observation-log tail (respecting `MAX_OBS_LINES`), compares newest spawn vs newest completion, honours `stale_after_hours` (default 48). Wired into the existing `topics` job so no fourth scheduled task, and exposed as `--run health`.

### Verification (evidence)

| Check | Result |
|---|---|
| Unauthenticated scan | exit `3`, `auth_missing` written, `0` transcripts scanned, no review file created |
| Repeated scan | exit `3` again, still exactly one `auth_missing` observation |
| Curator twice + cursor twice | exactly two observations, one per surface; state file holds both keys |
| `CURSOR_API_KEY` set | gate opens, scan proceeds to normal `0 transcript(s)` output |
| Live store health check | exit `4`, `reason=spawns_outrun_completions`, `last_spawn=2026-10-25T18:10`, `last_complete=2026-10-16T12:46`, `582 spawned / 416 completed` in window — correctly detects the real outage |
| JS tests | 35 pass, 0 fail |
| Existing pytest suite | 122 pass, 2 fail — both `test_wiki.py` failures reproduce identically on an unmodified tree (pre-existing, unrelated) |

### Gotcha found and fixed during implementation

`install.sh` and `install-windows.ps1` copy modules by explicit filename. Without adding `autolearn-auth.mjs` to both copy lists and both verify lists, an installed adapter would crash on import — a change that passes local tests and breaks every real install. Both installers updated.

### Deployed live

`~/.cursor/autolearn-{cursor,auth}.mjs` and `~/.autolearn/bin/autolearn-{schedule,auth}.mjs` updated. The resident watcher (pid 23380) still holds the pre-change module in memory; it will pick up the new preflight on next logon (Startup shortcut) or if that process is restarted.

### Known limit

An *invalid* `CURSOR_API_KEY` passes preflight, because `agent status` cannot validate a key without a network call. That case is caught by the staleness check instead (exit `4`), not by the preflight. Documented in the README.

Bugbot PR #2 follow-up (2026-10-27): fixed three findings in plugin/autolearn-schedule.mjs — (1) curator auth preflight gated via isCursorCuratorBin so pi/opencode* are not blocked by resolveAuth; (2) ensureInstalledCopy now copies and verifies autolearn-auth.mjs alongside schedule+core; (3) checkPipelineHealth only marks stale on unanswered spawns (lastSpawn > lastComplete), so a completed idle stretch outside the window stays healthy. Tests: 37 pass in test-schedule-health + test-auth-guard.

AC5 closed 2026-10-27 by user decision: treat as achieved. Evidence cited in prior handoff — CURSOR_API_KEY proven via agent -p, live store review_complete entries after outage recovery, PR #2 squash-merged (b692926). Formal isolated-AUTOLEARN_HOME proof waived.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: agent
created: 2026-10-26T14:09:00Z

---

## AC5 is deferred, not done

"A non-interactive credential source is documented and proven end to end: with it configured, a review completes in an isolated store without an interactive login."

The documentation half is complete (README + vault note). The proof half needs a real `CURSOR_API_KEY` from the Cursor dashboard, which I cannot create.

What is already verified: with `CURSOR_API_KEY` set to any non-empty value, the gate opens and the scan proceeds normally (exit 0, no `auth_missing`). What is NOT verified: that a real key actually lets `agent -p --force` complete a review and write `review_complete`.

Caveat worth knowing before doing the proof: `agent status --format json` reports `isAuthenticated: false` even when `CURSOR_API_KEY` is set, so the status command cannot validate a key. The short-circuit in `shortCircuitFromEnv` exists for exactly that reason, but it also means an invalid key passes preflight. An invalid key is caught by the staleness check (exit 4) rather than by the preflight.

To close AC5: set a real user-scope `CURSOR_API_KEY`, run `agent -p --force "say ok"` with the login store cleared, and confirm a review lands in an isolated `AUTOLEARN_HOME`.

---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
AC5 closed 2026-10-27 (user: assume achieved). Live credential + post-recovery review_complete evidence accepted in lieu of an isolated AUTOLEARN_HOME proof. PR #2 squash-merged.
<!-- SECTION:FINAL_SUMMARY:END -->
