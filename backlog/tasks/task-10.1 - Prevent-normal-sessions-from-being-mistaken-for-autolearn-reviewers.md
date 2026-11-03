---
id: TASK-10.1
title: Prevent normal sessions from being mistaken for autolearn reviewers
status: In Progress
assignee:
  - Droid
created_date: '2026-11-02T23:57:00Z'
updated_date: '2026-11-03T00:04:00Z'
labels: []
dependencies: []
references:
  - plugin/autolearn-droid.mjs
  - plugin/autolearn-cursor.mjs
  - plugin/autolearn-core.mjs
modified_files:
  - plugin/autolearn-core.mjs
  - plugin/autolearn-cursor.mjs
  - plugin/autolearn-droid.mjs
  - plugin/test-droid-adapter.mjs
  - plugin/test-cursor-adapter.mjs
parent_task_id: TASK-10
priority: high
type: bug
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Normal coding sessions can be silently skipped when their transcripts contain the autolearn review heading, for example after reading autolearn source through a tool. This was observed during Droid adapter validation and prevents ordinary sessions from receiving reviews. The agreed direction retains the reviewer environment marker as the primary guard and limits the fallback to the known reviewer prompt in the first genuine user message. Cover the transcript-driven Droid and Cursor adapters; other harness behavior and authentication are outside scope.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Sessions marked AUTOLEARN_REVIEWER=1 remain excluded from review processing.
- [x] #2 An unmarked reviewer session is excluded when its first genuine user message begins with the known generated reviewer prompt prefix.
- [x] #3 A review heading or reviewer prompt prefix in tool output, assistant content, or a later user message does not by itself exclude a normal session.
- [x] #4 The corrected reviewer classification applies consistently to the Droid and Cursor transcript-driven adapters.
- [x] #5 Regression tests demonstrate both genuine reviewer exclusion and normal-session review eligibility, while existing cadence and deduplication tests remain passing.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Goal and scope
Fix false reviewer classification in the Droid and Cursor transcript adapters only. Retain AUTOLEARN_REVIEWER=1 and replace the whole-transcript heading test with an anchored check of the first parsed user message. No authentication, cadence, state schema, installer, hook-registration, or OpenCode/pi behavior changes.

## Verified current state
- Droid reviewSession checks the environment marker, then scans raw JSONL for REVIEW_HEADING before parseDroidTranscript.
- Cursor scan scans raw JSONL for REVIEW_HEADING before parseTranscript; it currently has no reviewer environment early return.
- Both launchers generate the same prompt beginning "The autolearn session review is the file at ".
- Droid's parser already removes hook records, tool results, and harness notices while retaining untagged exec prompts. Cursor's parser extracts user/assistant text blocks.
- plugin/test-droid-adapter.mjs currently asserts that a first-user heading alone means reviewer_session. Replace that outdated expectation.
- History: the raw guard was introduced with Cursor in e117872 and Droid in b94deea. There is no known-good version of either adapter without it, so describe this as an original false-positive bug rather than a demonstrated regression.
- A filename lookup for dedicated Cursor/core test files returned no matches. Add a focused Cursor adapter test file rather than assume coverage.
- Graph query returned no symbols; source reads and git history are the evidence. Coverage metadata reported metadata_changed; full re-index completed successfully.

## Implementation
1. Add REVIEWER_PROMPT_PREFIX and a small pure isReviewerSession(messages) helper to plugin/autolearn-core.mjs. Find the first role=user message and use content.startsWith(REVIEWER_PROMPT_PREFIX). Do not scan other messages or use includes. Empty/no-user input returns false.
2. Use the shared prefix in both existing reviewer launch prompt strings without changing their rendered text or argv.
3. Droid: preserve the existing environment-marker early return. Parse once, then apply the helper to parsed.messages before ensureStore/auth/throttle/state changes. Remove the raw heading guard.
4. Cursor: add a reviewer environment-marker early return alongside the disabled check, returning the existing zero-count result. Parse each transcript once and apply the helper before per-conversation cadence/state/throttle processing. This does not identify individual transcripts from another process's environment: the prompt fallback is essential because the persistent watcher is separate from the reviewer.
5. For isolated Cursor scan-level tests, add optional auth, launch, and ensureStore dependency overrides following Droid's existing deps pattern. scan() callers and result shape remain compatible. Production defaults retain existing behavior.
6. Update the Droid regression tests and add plugin/test-cursor-adapter.mjs. Use synthetic JSONL, temporary AUTOLEARN_HOME/PROJECTS directories, mocked auth/launch/store setup, and no real reviewer, network, credentials, or live hook/config changes.

## Validation
- Before editing production guards, demonstrate the false positive with a normal threshold-eligible synthetic transcript containing the heading in tool output and assert that a genuine first-prompt reviewer without a heading is also mishandled by the old guard.
- Cover both adapters: environment marker; exact first-user prefix; heading alone in the first user message; heading/prefix in assistant text, tool results, or later user messages; prefix quoted mid-message; no user messages. Droid fixtures include notices/hooks before the first genuine user message and an untagged exec prompt.
- Assert genuine reviewers do not launch or advance cadence state. Assert normal contaminated sessions actually spawn once, write a review, advance state, and do not spawn again on unchanged input.
- Verify generated launcher prompts still begin with the shared prefix, guarding against producer/detector drift.
- Run node --test plugin/test-droid-adapter.mjs plugin/test-cursor-adapter.mjs plugin/test-auth-guard.mjs, then the repository's existing plugin test files using the discovered test inventory. Run node --check on changed modules and git diff --check.
- No live deployment, watcher restart, install, commit, or PR during the planning phase. Deployment is separate from proving the repository fix.

## Compatibility and risks
- Intentional behavior change: a heading alone no longer excludes a session. A first genuine user message beginning with the generated reviewer prefix does.
- The fallback is narrow identification, not an authentication/security boundary. A user deliberately starting with that exact prefix is classified as a reviewer.
- No breaking external interfaces or state migrations. Cursor's optional test dependencies are additive.
- Keep parser filtering unchanged; this task does not broaden notice detection or fix unrelated parser robustness.
- One focused task/PR; no additional decomposition required. Before implementation, inspect any existing TASK-10 integration branch/PR as required by the dotted-task branching workflow.

## Task Manifest
| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Narrow reviewer detection in both transcript adapters and add regression coverage | plugin/autolearn-core.mjs, plugin/autolearn-droid.mjs, plugin/autolearn-cursor.mjs, plugin/test-droid-adapter.mjs, plugin/test-cursor-adapter.mjs | — | logic, test | Both adapters reject genuine reviewers but admit normal sessions containing review text, with isolated regression tests and existing plugin checks passing. |

Implementation refinement: expose optional spawn/platform overrides on Cursor launchReviewer, matching Droid's existing seam, so its generated prompt and reviewer environment can be asserted without executing a real CLI or Windows launcher. This is additive, uses only the already-listed Cursor adapter/test files, and leaves default call behavior unchanged. scan's two existing internal callers remain no-argument compatible.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Plannotator approved the plan without annotations (decision=approved). Parent branch task/TASK-10 has no open PR; created task/TASK-10.1 from up-to-date main. Baseline: 84/84 plugin tests pass; syntax and git diff checks pass. Before production changes, new Droid fixtures reproduced seven expected failures, including normal tool-output contamination and genuine first-prompt reviewers.

Implemented the approved five-file change on task/TASK-10.1. Shared REVIEWER_PROMPT_PREFIX and isReviewerSession inspect only the first parsed user message. Both launchers retain identical prompt text. Droid keeps its marker guard; Cursor now short-circuits on AUTOLEARN_REVIEWER=1 and uses the shared fallback per transcript. Cursor test dependency seams are optional and preserve existing defaults.

AC1: environment-marker tests prove both adapters skip without store/auth/launch execution. AC2: first genuine prompt fixtures, including Droid untagged exec and preceding harness notices, are excluded with no review file, throttle consumption, or cadence advance. AC3/4: both adapters admit heading-only first messages, tool/assistant/later-user contamination and quoted prefixes, and ignore no-user transcripts. AC5: tests prove actual admitted spawns, review file writes, state advance, unchanged-input idempotence, threshold cadence, and Cursor duplicate-content rejection.

Final validation: node --test plugin/test-droid-adapter.mjs plugin/test-cursor-adapter.mjs plugin/test-auth-guard.mjs plugin/test-schedule-health.mjs => 112/112 passing, zero skipped. node --check passes for all five changed modules; git diff --check passes. No npm lint/typecheck scripts or test CI gate are configured in package.json/the inspected workflow. Full codebase index refreshed after changes.

No live deployment, hook changes, watcher restart, commit, push or PR performed. Implementation is ready for SDD review checkpoint #3; task remains In Progress until user review.
<!-- SECTION:NOTES:END -->
