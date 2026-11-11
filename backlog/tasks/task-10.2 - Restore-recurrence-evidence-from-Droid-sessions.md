---
id: TASK-10.2
title: Restore recurrence evidence from Droid sessions
status: In Progress
assignee:
  - '@droid'
created_date: '2026-11-11T18:43:00Z'
updated_date: '2026-11-11T19:31:00Z'
labels: []
dependencies: []
references:
  - TASK-10
  - skills/autolearn/scripts/autolearn.py
  - skills/autolearn/scripts/proposer.py
  - plugin/autolearn-droid.mjs
  - https://github.com/marcusyoung/opencode-autolearn/pull/6
parent_task_id: TASK-10
priority: high
type: bug
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Autolearn reviews and skill patches work under Droid, but new-skill recurrence checks depend on a search index last updated on 30 September 2026. The current indexer depends on the unavailable OpenCode database, so recent Droid sessions cannot contribute cross-session evidence. This follows up TASK-10's Droid harness support. Restore ongoing evidence collection and backfill existing Droid sessions without weakening the recurrence safeguard. The health check found no new skill since 15 October; restoring evidence must not force skill creation when no eligible pattern exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Droid user-session text is searchable and available to recurrence checks when the OpenCode database is absent; existing OpenCode search behaviour remains supported.
- [ ] #2 Backfill includes available historical Droid sessions, preserves existing indexed evidence, and repeated or incremental indexing does not duplicate messages or inflate distinct-session counts.
- [ ] #3 Ongoing Droid activity refreshes recurrence evidence through the normal operating workflow without manual index maintenance.
- [ ] #4 Injected messages, tool output and Autolearn reviewer sessions do not create false recurrence evidence; the existing cross-session creation threshold remains unchanged.
- [ ] #5 Automated tests cover missing OpenCode data, historical and incremental Droid indexing, duplicate prevention, source filtering and recurrence results.
- [ ] #6 Deploy the tested fix with recoverable backups, backfill the live index and verify recent Droid sessions are searchable and counted correctly without forcing skill creation.
- [ ] #7 Document the supported indexing, freshness checks and backfill procedure.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Approach
Teach `autolearn.py search init` to index Droid transcripts (`~/.factory/sessions/**/<session_id>.jsonl`) into the existing `search.db`, alongside the OpenCode sources. Make the recurrence check refresh the Droid portion incrementally before it reads the index, so evidence stays current without a scheduler or a blocking hook. The recurrence algorithm and threshold (3 sessions, overlap >= 0.5) are unchanged.

## Verified facts (2026-11-11)
- Schema (`autolearn.py:1287-1320`): `session_text_content(rowid, session_id, message_id, role, text, project, timestamp ms)`, external-content FTS5 `session_text`, `indexed_session`, `index_state` (`last_part_time`, `last_v2_message_time`). No source column; plain INSERT, dedupe is watermark-only.
- `cmd_search_init` (`autolearn.py:1336-1538`) exits 1 when `~/.local/share/opencode/opencode.db` is absent (`OPENCODE_DB`, line 107), before touching search.db. No Droid/Cursor ingestion.
- Recurrence (`proposer.py:77-86,342-378`) reads `role='user'` rows, counts distinct `session_id`.
- Proposer `scan()` takes candidate sessions from `outcomes.db` (`outcomes.py:367-374`), which is OpenCode-only; curator `no_opencode_db:true` comes from `outcomes` indexing, not search.
- Droid lines: `type=message` with stable UUID `id`, ISO `timestamp`, `seq`, `message.role`, `message.content` blocks; typed user lines carry `message.userMessageSource`; `session_start` carries `id`, `title`, `cwd`. 484 transcripts in 14 dirs, oldest 2026-11-01.
- JS rules for genuine user text live in `parseDroidTranscript` (`plugin/autolearn-droid.mjs:30-87`); reviewer prompt prefix `"The autolearn session review is the file at "` (`autolearn-core.mjs:87-95`).

## Decisions (proposed; confirm at review)
1. **Only typed user messages count as user evidence.** A Droid user line is indexed as `role='user'` only when `message.userMessageSource` is set and a text block survives the same stripping as the JS parser (`<system-reminder>` blocks, hook records, tool results, Skill/harness notices). Untagged user lines (droid exec prompts, Task subagent prompts, reviewer and curator prompts) are not indexed. This stops a parent's delegation prompt from counting as a second session. Sessions whose first user prompt is the reviewer prefix or the curator prompt are skipped entirely as a backstop.
2. **Assistant text is indexed** (`role='assistant'`) for `search query` context, matching OpenCode behaviour; recurrence ignores it.
3. **Dedupe by message identity, not watermark.** Droid rows store `message_id='droid:<uuid>'`; a partial unique index on `session_text_content(message_id) WHERE message_id LIKE 'droid:%'` plus `INSERT OR IGNORE` makes repeated, concurrent or overlapping runs idempotent. Per-file state (`droid_file_state(path PK, size, mtime_ns)`) skips unchanged transcripts. New FTS rows are inserted directly; no full rebuild per run.
4. **Freshness without manual maintenance:** `proposals recurrence` and proposer `scan()` call a fast incremental Droid refresh first (stat-only for unchanged files, under `BEGIN IMMEDIATE` with a busy timeout). Failure of the refresh is logged and falls back to the existing index (still fail-safe).
5. **`search init` no longer exits 1 when only OpenCode is missing.** It indexes every available source and exits 1 only when none exists. `--full` clears Droid state too. Source root overridable by `AUTOLEARN_DROID_SESSIONS` (tests). `search status` adds a Droid line (files, messages, last message time).
6. **Python parser, shared fixtures.** New `skills/autolearn/scripts/droid_sessions.py` mirrors the JS filter. A shared JSONL fixture under `plugin/fixtures/` is asserted by both `test-droid-adapter.mjs` and the new pytest, so the two filters cannot drift silently.

## Steps
1. `droid_sessions.py`: `parse_transcript(path) -> (meta, [msg{id, role, text, ts_ms}])` and `iter_transcripts(root)`; pytest with the shared fixture (typed vs untagged, reminders, hook records, tool results, reviewer/curator sessions, malformed lines, ISO -> ms).
2. Schema migration in `init_search_schema`: partial unique index, `droid_file_state`, `index_state` key `last_droid_message_time`; idempotent on an existing populated DB.
3. `index_droid(conn, root)` + wire into `cmd_search_init` (OpenCode optional) and `cmd_search_status`.
4. Auto-refresh hook in `proposer.is_recurrent` / `scan` (via a small callable passed from `autolearn.py`, keeping proposer tests DB-only).
5. Tests (`test_search_droid.py`): OpenCode absent; historical backfill; incremental append; rerun and concurrent rerun produce no duplicates; distinct-session count correct; existing OpenCode rows preserved; recurrence true across 3 Droid sessions and false when the only extra "session" is an untagged subagent prompt. Run full Python suite (SKILL.md runner) and `node --test plugin/test-droid-adapter.mjs`.
6. Docs: `references/reviewer.md` Step 3 (fix "idempotent full rebuild" wording, Droid source, auto-refresh, freshness check), `references/cli.md`, README search section.
7. Deploy and backfill: back up `~/.autolearn/personas/default/search.db` (+ `-wal`/`-shm`) and the installed `~/.agents/skills/autolearn/scripts/` files; deploy; run `search init`; verify `search status` Droid watermark is today, distinct Droid session count equals transcripts with typed user text, a rerun adds 0 rows, and `proposals recurrence` on a known recent multi-session topic returns evidence. No `skill create` is run.

## Out of scope (follow-ups to propose, not do)
- Proposer `scan()` admits candidates only from OpenCode `outcomes.db`, so curator auto-promotion stays inert for Droid-only sessions.
- October 2026 sessions (Cursor era) are not in Droid transcripts; indexing Cursor transcripts would be separate.
- `~/.autolearn/bin/autolearn-core.mjs` is one commit stale for scheduled jobs.

## Risks
- Droid transcript format is undocumented and may change; parser ignores unknown shapes and tests pin the current one.
- Partial-index `LIKE` predicate must be accepted by the bundled SQLite; fallback is a separate `droid_message(id PK)` table.
- Refresh cost on each recurrence call: ~500 stats; measure and record.

## Branching
`task/TASK-10.2` from `main` (TASK-10's PR is merged, no open integration branch); one PR to `origin/main`.

## Task Manifest
| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Add Droid transcript parser with shared fixtures | skills/autolearn/scripts/droid_sessions.py, skills/autolearn/scripts/test_droid_sessions.py, plugin/fixtures/droid-transcript.jsonl, plugin/test-droid-adapter.mjs | — | logic, test | Python and JS tests agree on the shared fixture: only typed user text and assistant text survive, reviewer/curator sessions are skipped |
| 2 | Index Droid sessions in search.db | skills/autolearn/scripts/autolearn.py, skills/autolearn/scripts/test_search_droid.py | 1 | database, logic, test | search init indexes Droid transcripts with OpenCode absent, and repeated or incremental runs add no duplicate rows |
| 3 | Refresh Droid evidence before recurrence checks | skills/autolearn/scripts/proposer.py, skills/autolearn/scripts/autolearn.py, skills/autolearn/scripts/test_search_droid.py | 2 | logic, test | proposals recurrence sees a Droid session written after the last init, with the threshold unchanged |
| 4 | Document indexing, freshness and backfill | skills/autolearn/references/reviewer.md, skills/autolearn/references/cli.md, README.md | 3 | docs | Docs describe Droid indexing, auto-refresh, status checks and the backfill procedure |
| 5 | Deploy and backfill live index | (deploy, no code) | 4 | infra | Live search status shows today's Droid watermark, rerun adds 0 rows, and recent sessions are counted correctly with no skill created |
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Plan approved 2026-11-11 via Plannotator gate. User note: complete the manifest as a todo list rather than separate Backlog subtasks. Single branch task/TASK-10.2.

Branch task/TASK-10.2 cut from main. Baseline: Python 122 passed, 2 pre-existing failures in scripts/test_wiki.py (test_write_pattern_line_cap, test_enabled_false; TASK-9). Node plugin tests 95/95. Rows 1-4 delegated to a worker; row 5 (live deploy/backfill) held in the parent.

Rows 1-4 committed on task/TASK-10.2: 69ce63a parser+shared fixtures, d4616d0 Droid indexing, e28372f recurrence/scan refresh, 98e23dc docs. Parent rerun: Python 156 passed + 2 baseline test_wiki failures (TASK-9); node 97/97. Deviations: --full keeps rows of unreadable sources (protects OpenCode-era history); curator's internal proposer.scan not given refresh (curator promotion is OpenCode-only; proposals scan/recurrence refresh). Rehearsal on a copy of live search.db: init indexed 3359 Droid messages / 340 sessions from 485 transcripts in 5.0 s, OpenCode rows kept (466 -> 806 sessions), rerun 0 rows in 0.6 s; recurrence probes true (54, 41 sessions) for recent topics, false for nonsense. User asked to review the branch before live deploy (row 5).

Draft PR #6 opened (task/TASK-10.2 -> main) for Droid review bot. Live deploy/backfill (row 5) waits for review.
<!-- SECTION:NOTES:END -->
