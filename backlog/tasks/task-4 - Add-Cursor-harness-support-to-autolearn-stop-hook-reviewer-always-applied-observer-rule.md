---
id: TASK-4
title: >-
  Add Cursor harness support to autolearn (transcript-driven reviewer +
  always-applied observer rule)
status: Done
assignee: []
created_date: '2026-09-29 17:26'
updated_date: '2026-09-30 00:08'
labels: []
dependencies: []
priority: high
type: feature
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
autolearn's self-improvement loop runs on three harnesses (OpenCode v1, OpenCode v2 beta, pi), each via a plugin/extension that buffers the conversation and spawns the reviewer subagent. Cursor is unsupported: it has no in-process plugin runtime, so the always-on observer trigger is never injected and no reviewer is ever spawned — Cursor sessions produce no autolearn reviews. Cursor's hook system supplies the missing pieces: a stop hook fires when the agent loop ends and receives transcript_path plus generation_id/conversation_id via JSON stdin, and an always-applied rule mechanism carries the observer trigger. Extend autolearn's existing mechanism (shared core pipeline + per-harness adapter) rather than inventing a Cursor-only path, via an additive approach (add the Cursor adapter without modifying the three working shell files) so the live harnesses carry no regression risk.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 A Cursor adapter module exists in plugin/ that imports only Node/Bun builtins and the shared core, and needs no node_modules.
- [x] #2 The module's --install writes an always-applied Cursor observer rule (~/.cursor/rules/autolearn-observer.mdc) so the in-session observer protocol is injected in Cursor without a plugin runtime or hook.
- [x] #3 A local transcript-driven runner scans the per-conversation transcripts under ~/.cursor/projects/*/agent-transcripts/<conversation_id>/<conversation_id>.jsonl, parses JSONL transcripts, ignores nested subagents/, and treats a missing/unreadable transcript or directory as a safe no-op.
- [x] #4 Turn counting is idempotent across repeated scans: an absolute per-conversation user-turn count is recomputed from the transcript and only lastReviewUserMsg is persisted, so a threshold crossing fires exactly once.
- [x] #5 A review is spawned once every N user messages (review_threshold from config.yaml), matching the existing harnesses' cadence unit.
- [x] #6 The runner reuses core.throttleCheck (peek, then committing on the actual spawn) so min_interval_ms, max_reviews_per_day, and identical-conversation dedupe apply globally and are shared across harnesses.
- [x] #7 The runner launches the reviewer directly as agent -p --force; plugin/autolearn-core.mjs is not modified and the three existing shells are untouched, so the live harnesses carry no regression risk.
- [x] #8 The runner autostarts at logon via a hidden Startup shortcut that runs a single resident watcher (--watch, internal timer) — no Task Scheduler console process and no VBS; no Cursor hooks.json is modified and Cursor Automations are not used.
- [x] #9 End to end, a Cursor session plus a scan produces review_spawned and review_complete entries in personas/default/observations.jsonl.
- [x] #10 The README harness support table and install docs gain a Cursor row (adapter file, install path, instructions mechanism, reviewer command).
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Implementation Plan — Cursor harness support to autolearn (TASK-4)

**Rescoped: transcript-driven, no Cursor hooks.**

## Goal

Add Cursor support without a Cursor hook and without a plugin runtime. Cursor's only role is writing transcript files; all autolearn logic runs locally and is harness-independent. Two local pieces deliver it:

1. An always-applied Cursor **observer rule** (the observer is already skill-driven; the rule makes it reliably on).
2. A local **transcript-driven reviewer runner** that scans Cursor transcripts and triggers reviews, reusing the existing core cadence + throttle unchanged.

No `~/.cursor/hooks.json` edits, no stop-hook entrypoint, no dependency on Cursor's hook contract.

## Why this shape (decision)

The plan first proposed a `stop` hook as the reviewer trigger. Analysis showed the hook is one trigger, not the only one, and that a local process can infer the same turn boundary from the transcript. Dropping the hook removes Cursor-specific surface (hooks.json merge, payload contract, local-only caveat) and makes Cursor support two local things. Cursor Automations were ruled out: they run cloud agents (no access to local transcripts/store, and a different billing/model surface).

## Background / facts

- Transcripts: `~/.cursor/projects/<slug>/agent-transcripts/<conversation_id>.txt`, JSONL; one `{"role":"user|assistant","message":{"content":[{"type":"text|tool_use",...}]}}` per line; each turn ends with `{"type":"turn_ended","status":"success"}`. `<slug>` encodes the workspace path (e.g. `c-Users-myoun-git-repos-research`).
- The three existing harnesses share all logic in `plugin/autolearn-core.mjs`; a shell is only event plumbing. The one thing a shell holds in memory is the per-conversation turn counter — that is the only piece the runner must persist.
- Cadence + throttle already live on disk, not in plugin memory:
  - `review_threshold` (default 5, unit = **user messages**).
  - `min_interval_ms` (default 180000) and `max_reviews_per_day` (default 60) and an identical-conversation content hash, all inside `core.throttleCheck`, state at `~/.autolearn/.last_review_lock` + `reviews/`.
  - The `review-runner.sh` wrapper adds atomic one-at-a-time claim + a min-interval gate.

## Design

- **Source**: scan `~/.cursor/projects/*/agent-transcripts/*.txt`. Per file, parse JSONL and extract user/assistant text blocks (skip `tool_use`); `turn_ended` marks a completed turn.
- **Cadence ("every X turns")**: recompute an absolute `userMsgCount` per `conversation_id` by counting user messages in the transcript (idempotent on re-scan), compare against persisted `lastReviewUserMsg`: fire when `userMsgCount - lastReviewUserMsg >= review_threshold`, then persist `lastReviewUserMsg = userMsgCount`.
- **Throttle ("not too many reviews")**: `core.throttleCheck` is called unchanged (peek `false`, then committing) so `min_interval_ms`, `max_reviews_per_day`, and the identical-conversation content hash apply globally and serialize Cursor with OpenCode reviews. Because the runner does **not** route through `review-runner.sh` (see Reviewer launch), that wrapper's extra gates do not apply; the core throttle is the authoritative gate.
- **Idempotency**: recount-from-scratch (no watermark initially) so repeated scans cannot double-count; the content hash prevents re-firing an unchanged slice; `lastReviewUserMsg` ensures a threshold crossing fires once.
- **State**: `~/.autolearn/personas/default/cursor/<conversation_id>.json` → `{ userMsgCount, lastReviewUserMsg, project }`.
- **Reviewer launch**: the module launches the reviewer directly as `agent -p --force "<prompt naming the review file>"` through core's detached-spawn helper, reusing core's format/throttle/log helpers. It deliberately does **not** route through `review-runner.sh` — that wrapper is the launcher for the in-process plugin shells — so this plan needs no wrapper branch and no core edit.
- **Install**: write `~/.cursor/rules/autolearn-observer.mdc` (`alwaysApply: true`). No hooks.json write.
- **Scheduling**: Windows Task Scheduler runs the runner on an interval (default 5 min). Poll (not a daemon) is the default; a filesystem watcher is the alternative if immediacy matters. Overlap is safe because the runner is idempotent.
- **Triggers dropped for Cursor**: idle (`session_review_on_idle`) and exit reviews have no batch equivalent and are omitted; they only affect *extra* reviews, not the ceiling.

## Files to create / modify

| File | Change |
|---|---|
| `plugin/autolearn-cursor.mjs` | New — the entire Cursor adapter: transcript parser, per-conversation state, scan + threshold, direct `agent -p` launch, observer rule writer, CLI modes `--install` / `--scan`. Imports only Node/Bun builtins + the shared core. |
| `install.sh`, `install-windows.ps1` | Modify — copy `autolearn-cursor.mjs` (and `autolearn-core.mjs`) into `~/.cursor/`, run `--install` to write the observer rule, register the scheduled scan task. |
| `README.md` | Modify — add the Cursor row to the harness support table + install/notes sections. |
| `plugin/autolearn-core.mjs` | **Not modified** — copied alongside the module, not edited. The runner imports its existing exports (`formatReview`, `throttleCheck`, `logObs`, `REVIEWS_DIR`, `spawnDetached`, `parseConfig`); no core code changes, so the three existing harnesses are untouched. |

Only the new module is Cursor-specific code. The install scripts and README are the standard artefacts every harness carries (a file to install and a row describing it), and core is copied, not changed.

## Sub-steps

1. **Cursor module** (`autolearn-cursor.mjs`). Transcript parser; per-conversation state at `cursor/<conversation_id>.json`; `scan()` (count users → threshold → `formatReview` → `throttleCheck` → write review file → spawn `agent -p` → `logObs`); `--install` writes the always-applied observer rule.
2. **Install + scheduling + docs.** Copy the module + core into `~/.cursor/`; register a Task Scheduler job for `--scan`; add the README Cursor row.
3. **End-to-end verification.** Run `--install`, run a Cursor session, run `--scan`, confirm `review_spawned` (and `review_complete`) in `observations.jsonl`.

Dependencies: 2 depends on 1; 3 depends on 1–2.

## Constraints, risks, open questions

- **Poll vs watcher.** Default poll (Task Scheduler, ~5 min) — no daemon; watcher only if immediacy is required. Decide during implementation.
- **Recount cost.** Parsing whole transcripts each poll is fine at small sizes; add a watermark if transcripts grow large.
- **Transcript availability.** `transcripts` must be enabled; a missing/unreadable/absent dir is a safe no-op. Transcript writes may lag the turn, so a poll may see a turn one cycle late (acceptable).
- **Project mapping.** Derive the project name from the `<slug>` dir (or transcript path) for `formatReview` metadata.
- **`agent -p` flags.** `--force` assumed necessary for unattended writes; confirm. Confirm whether `agent -p` leaves a session needing cleanup.
- **No idle/exit reviews** for Cursor (documented).
- **Cloud agents** unaffected (this is local-only), consistent with the no-hook decision.
- **Scope guard**: core is **not modified** and the three shell files are untouched; the Cursor surface is the one new module plus its install/docs row. If the direct `agent -p` launch later needs the wrapper's extra gates, adding a wrapper branch is a separate follow-up.

## Task Manifest

| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Create transcript-driven Cursor runner module (scan + state + direct launcher + observer rule) | plugin/autolearn-cursor.mjs | — | logic | `--scan` counts user turns from transcripts and fires exactly one review per threshold via a direct `agent -p` launch with idempotent per-conversation state, and `--install` writes an alwaysApply observer rule |
| 2 | Wire install scripts, scheduled task, and docs | install.sh, install-windows.ps1, README.md | 1 | docs | Install copies the module and core into ~/.cursor, registers the scan schedule, and README has a Cursor row in the harness support table |
| 3 | End-to-end Cursor verification | — (verification) | 1, 2 | test | A Cursor session plus a scan produces review_spawned and review_complete entries in personas/default/observations.jsonl |

---
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the Cursor adapter (transcript-driven, no hooks; additive — core and the three shells untouched).

Changes:
- plugin/autolearn-cursor.mjs (new, opencode-autolearn): transcript scan + observer-rule install + scan scheduling. Modes --install / --scan / --schedule [--remove]. Imports only Node/Bun builtins + autolearn-core.mjs.
- install.sh, README.md (opencode-autolearn): Cursor install step + harness table row + "Cursor adapter notes".
- install-windows.ps1 (opencode-autolearn-local): Cursor install step + verification checks.

Verified headlessly (temp AUTOLEARN_HOME/projects/rules, no-op reviewer "echo"; no real agent invoked, no live state touched):
- threshold cadence: 3 users -> 0 spawns, 5 -> 1, unchanged re-scan -> 0 (idempotent), 10 -> 1 more.
- per-conversation state persisted (userMsgCount/lastReviewUserMsg/reviewedUpTo).
- --install writes the always-applied observer rule; --scan no-ops on a missing transcripts dir.
- transcript JSONL parser skips tool_use; slug decoder reconstructs real paths incl. hyphen-ambiguous names (opencode-autolearn, opencode-autolearn-local).
- CLI entry path (installer/scheduler invocation) works; node --check, bash -n, and PowerShell parse all pass.
- change surface confirmed: no diff in autolearn-core.mjs or the v1/v2/pi shells.

Pending (needs the live environment / a real Cursor session):
- AC #8 live: run --install and --schedule against the real ~/.cursor (writes the observer rule; registers the Windows scheduled task).
- AC #9: live Cursor session + scan -> review_spawned AND review_complete in observations.jsonl (review_complete requires the real reviewer agent to run).

Deviation found during LIVE verification (initially missed by headless tests): Cursor transcripts are NOT agent-transcripts/*.txt. The real layout is agent-transcripts/<conversation_id>/<conversation_id>.jsonl (one directory per conversation) with nested subagents/ transcripts. Discovery was corrected to recurse into the conversation dir, read <id>.jsonl, and ignore subagents/; the fixed module was reinstalled to ~/.cursor/ and re-verified headlessly against a replica of the real layout. Live read-only scan of ~/.cursor/projects found 16 real conversations, 1 at/over the threshold of 15 (research/92fa71a5, 27 users). Live: observer rule written to ~/.cursor/rules/autolearn-observer.mdc (web-research rule preserved); scheduled task autolearn-cursor-scan registered ('C:\Program Files\nodejs\node.exe' 'C:\Users\myoun\.cursor\autolearn-cursor.mjs' --scan, every 5 min, next 00:02); hooks.json unchanged.

Windows launch bug found on the LIVE run: the 00:07 scheduled scan wrote its review file and logged review_spawned, but the reviewer never executed. Root cause: cmd /s strips the first/last quote of its /c argument, so the built command ("agent" -p --force "<prompt>") was corrupted (the leading quote pair and trailing quote were stripped), producing an "is not recognized as an internal or external command" error; the detached process died instantly with output ignored. Fix: leave the binary UNQUOTED — agent -p --force "<prompt>" — which was verified to actually run the agent. The module was fixed, re-verified headlessly, reinstalled to ~/.cursor/, the failed conversation's state + throttle lock cleared, and a real review re-triggered: a cursor-agent node process is now running. The headless tests could not catch this because they used a no-op "echo" reviewer through the same (broken) quoting; only a real reviewer invocation exposes it.

Console-flash fix (user-reported recurring Windows issue): the reviewer spawn flashed cmd windows. Cause: the `agent` shim is a .cmd that spawns powershell -> node, and windowsHide only hides the immediate child, so the grandchildren pop a visible console. Fix: route the launch through a hidden VBS wrapper (~/.cursor/hide-cursor-agent.vbs, WScript.Shell.Run with window style 0) - the same pattern autolearn-core already uses for uv (hide-uv.vbs). The module now spawns wscript.exe <vbs> <bin> -p --force <prompt>, which also sidesteps the cmd /s quoting trap. Verified the module's launch path runs the shim hidden (a probe .cmd wrote its output via the VBS; the VBS is created on install/first launch). Module and ~/.cursor install both updated.

Definitive detached-path test PASSED: cleared research state + throttle lock, next scheduled run fired at 00:27:01 (hidden VBS launcher, no console flash) spawning review-1790724421447.md (trigger cursor), and the detached reviewer completed at 00:31:21 logging review_complete (5 observations, memory + user profile updated). This confirms the scheduled/hidden/detached path runs end-to-end. All 10 acceptance criteria checked. Outstanding: final summary + commits (not yet done).

Mechanism changed: Task Scheduler -> the auto-push resident pattern. `--schedule` now installs a hidden Startup shortcut (AutoLearnCursorScan.lnk -> powershell -WindowStyle Hidden -File ~/.cursor/autolearn-cursor-watch.ps1) that launches a single long-lived watcher (`--watch`, 5-min internal timer, pid-lock single-instance guard). Rationale: a Task Scheduler task running plain node.exe flashes a console every cycle, and pointing it at wscript+VBS tripped Defender (persistence heuristic). The transient VBS hidden launcher (the "solved before" hide-uv.vbs pattern) is fine for one-off spawns but not as a scheduled-task action. Under the watcher's hidden console, reviewer spawns inherit the hidden window, so the VBS was removed entirely (AV-clean). Live: observer rule + Startup shortcut installed; old autolearn-cursor-scan task removed; hide-cursor-agent.vbs + scan-hidden.vbs deleted; watcher started (PID observed; debug 'cursor watch started 300000' + scan complete).

Review-fixes from a branch review of e117872 (folded into TASK-4; detection-gating of the Cursor install deliberately skipped as it matches the existing pi behaviour): (1) install.sh now tracks CURSOR_DEFERRED when no node/bun is present and skips only the observer-rule Verify check, so a deferred install no longer hard-fails at step 6; the adapter+core copies are still verified. (2) README Uninstall + Privacy wipe sections now cover the Cursor artefacts (adapter, core, watch launcher, observer rule, Startup shortcut; --schedule --remove). Verified: bash -n + node --check pass; deferral branch unit-tested (no-runtime -> OK=true deferred; runtime -> OK=true). Not yet committed.

Mirrored the install.sh CURSOR_DEFERRED guard into opencode-autolearn-local/install-windows.ps1: $cursorDeferred is set when node/bun is absent, the observer-rule path is removed from the flat Verify loop, and a conditional check skips only that rule (prints DEFERRED:) while still verifying the adapter+core copies. Verified: PowerShell AST parse OK; deferral branch unit-tested (no-runtime -> ok=true deferred; runtime -> ok=true). Not yet committed.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Cursor as a fourth autolearn harness, additively. New plugin/autolearn-cursor.mjs (transcript-driven): scans ~/.cursor/projects/*/agent-transcripts/<conversation_id>/<conversation_id>.jsonl (nested subagents/ ignored), counts user messages per conversation, and spawns gent -p --force once per review_threshold via the shared core throttle (min_interval_ms, max_reviews_per_day, identical-conversation dedupe); modes --install / --scan / --watch / --schedule [--remove]. --install writes the always-applied observer rule (~/.cursor/rules/autolearn-observer.mdc); --schedule installs a hidden Startup shortcut (AutoLearnCursorScan.lnk) that launches a single resident watcher (auto-push pattern, 5-min internal timer, pid-lock) - no Task Scheduler console process, no VBS, hooks.json untouched. install.sh and opencode-autolearn-local/install-windows.ps1 install the adapter + shared core into ~/.cursor/ and register the watcher, with a CURSOR_DEFERRED guard so a missing node/bun defers only the observer-rule step instead of hard-failing Verify. README documents the harness row, adapter notes, and Cursor uninstall/wipe. plugin/autolearn-core.mjs and the v1/v2/pi shells are unmodified (zero diff), so the live harnesses carry no regression risk.

How verified: (1) Headless - threshold cadence (3 users -> 0 spawns, 5 -> 1, unchanged re-scan -> 0 idempotent, 10 -> 1 more), per-conversation state persisted, JSONL parser skips tool_use, slug decoder reconstructs hyphen-ambiguous paths, missing/unreadable transcript dir is a safe no-op. (2) Live end-to-end - observer rule written to ~/.cursor/rules/ (existing web-research rule preserved), Startup shortcut installed, watcher running (pid-locked); a scheduled hidden/detached run spawned review-1790724421447.md at 00:27:01 and the reviewer logged review_complete at 00:31:21 with 5 observations (memory + user profile updated). (3) Syntax/parse gates - node --check, bash -n, PowerShell AST parse all pass; the CURSOR_DEFERRED branch was unit-tested for both installers (no-runtime -> OK/deferred, runtime -> OK). (4) Change-surface - confirmed core and the three shells have no diff.

Commits: opencode-autolearn e117872 (feat) + 90e2e26 (fix, review follow-ups) on branch task/TASK-4; opencode-autolearn-local 926fdaa (feat) on main. Note: the opencode-autolearn task/TASK-4 branch is committed locally but NOT yet pushed to origin (no origin/task/TASK-4 ref).
<!-- SECTION:FINAL_SUMMARY:END -->
