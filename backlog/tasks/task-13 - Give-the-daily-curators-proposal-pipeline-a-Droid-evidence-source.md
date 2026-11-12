---
id: TASK-13
title: Give the daily curator's proposal pipeline a Droid evidence source
status: In Progress
assignee:
  - '@droid'
created_date: '2026-11-11T23:26:00Z'
updated_date: '2026-11-12T00:22:00Z'
labels: []
dependencies: []
references:
  - TASK-10
  - TASK-10.2
  - https://github.com/marcusyoung/opencode-autolearn/pull/6
  - skills/autolearn/scripts/outcomes.py
  - skills/autolearn/scripts/proposer.py
  - skills/autolearn/references/curator.md
  - plugin/autolearn-schedule.mjs
  - TASK-14
  - https://github.com/marcusyoung/droid-plugins
priority: medium
type: bug
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The daily curator (AutoLearnCurator, run through `droid exec` since commit 045663d) runs `curator run`, which indexes tool outcomes and then runs proposer scan, verify and promote. Both the outcome index and the proposer's candidate sessions come from `outcomes.db`, which is built only from OpenCode's `opencode.db`. That database no longer exists on this machine, so every run reports `no_opencode_db: true` and promotes nothing. Its 9 pending proposals all have `verified: null`. Commit 045663d changed which harness launches the curator, not where its evidence comes from. TASK-10.2 restored Droid text evidence in `search.db` for the reviewer's recurrence gate, but deliberately left the curator path out of scope. Without a Droid source, the curator's proposal, verification and auto-promotion loop stays inert for every session since the move to Factory. Start by reviewing what the curator needs from session data (tool commands and outcomes, not just text) and what Droid transcripts provide.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A review records which curator steps depend on OpenCode-only data and what equivalent evidence Droid transcripts provide, before any implementation is planned.
- [ ] #2 When the OpenCode database is absent, the curator's proposer scan considers recent Droid sessions as candidates.
- [ ] #3 Tool-outcome evidence used for verification and auto-promotion is available from Droid sessions, or the curator reports clearly that it is unavailable, rather than silently promoting nothing.
- [ ] #4 Droid-derived evidence excludes reviewer, curator and subagent sessions, and is not double-counted across repeated curator runs.
- [ ] #5 Existing OpenCode behaviour remains supported where that database exists.
- [ ] #6 Automated tests cover the curator path with OpenCode absent and Droid sessions present.
- [ ] #7 After deployment, a scheduled curator run on this machine shows Droid sessions scanned, and its outcome is recorded in the task.
- [ ] #8 Curator documentation describes the supported session sources.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Scope (agreed 2026-11-12)
Housekeeping only. The daily curator records skill use from Droid sessions, so its stale marking, archiving and unused-skill pruning stay accurate. It no longer tries to promote proposals when the OpenCode data is absent. The reviewer remains the route that creates new skills.

## Why
- Under Droid, `repair_skill_use_counts` (`autolearn.py:275-339`) reads only `tool='skill'` rows from OpenCode-derived `outcomes.db` (`outcomes.py:390-414`). Droid skill loads are never counted.
- `cmd_curator_run` marks skills stale or archived from `last_activity_at` **before** it repairs usage (`autolearn.py:1110-1146` vs `1187-1190`).
- Live state (read-only, 2026-11-12): 7 autolearn skills are stale (marked between 16 Oct and 7 Nov). 4 autolearn skills with zero recorded uses were archived on 3 Nov; which step archived them is not yet confirmed.
- Promotion has never worked here: 44 runs since 2026-09-20 and 0 promotions. 7 of 9 proposals were refused by verify ("declared command outside safe subset"), and 2 have no resolution. Scan still re-reads the frozen OpenCode outcome rows (about 47 sessions) every day.

## Evidence for Droid skill use (bounded live checks, 2026-11-12)
- Direct calls: `tool_use name="Skill"`, input `{"skill": "<name>"}`. 15 of 15 sampled had a linked `tool_result`.
- Script-wrapped calls: `tool_use name="Script"`, input `{"script": "<js>"}`. Nested calls look like `tools.Skill({skill: "<name>"})`, and all 4 sampled used a literal name. Computed names cannot be extracted; that is an accepted gap.
- The timestamp comes from the enclosing `message` line. `tool_use.id` is unique and serves as the dedupe key.
- Reviewer and curator sessions are already detected by their opening prompt (`droid_sessions.py:133-139`).

## Approach
1. **Parser** (`droid_sessions.py`): `parse_transcript` also returns `skill_uses: [{id, skill, ts_ms}]`. It covers assistant `Skill` tool_use blocks and literal `skill:` names in `tools.Skill(...)` inside Script source (ids `<tool_use_id>` and `<tool_use_id>#<n>`). Reviewer and curator sessions return none. Subagent sessions are included, because a skill loaded by a subagent is real use (proposed; confirm at review).
2. **Index** (`autolearn.py`, search schema): new table `droid_skill_use(use_id PK, session_id, skill, ts_ms)`, written with `INSERT OR IGNORE` in the existing incremental Droid refresh, so repeated runs never double-count. When the table is first created, clear `droid_file_state` once so the next refresh re-parses every transcript. Message inserts are already idempotent, so this is a safe backfill.
3. **Usage repair**: `repair_skill_use_counts` merges the OpenCode signals and the Droid signals per skill: count = sum, last seen = max. It never lowers an existing `use_count` or moves `last_activity_at` backwards, and the `created_by` rules are unchanged.
4. **Curator order**: `cmd_curator_run` runs the Droid refresh and usage repair **before** the stale/archive transitions and pruning. If the refresh fails, it records the error and skips stale/archive/prune for that run instead of acting on missing evidence.
5. **Promotion**: when `opencode.db` is absent, skip proposer scan/verify/promote and record `long_horizon: {"skipped": "no_opencode_source"}`. When OpenCode data exists, behaviour is unchanged. Proposal code and `proposals.json` stay as they are.
6. **Reporting**: the run record and `curator run` output include Droid skill-use counts (new uses, skills seen).
7. **Docs**: `references/curator.md`, `references/cli.md` and README cover session sources, the skill-use evidence and the promotion skip.
8. **Deploy**: back up `.usage.json`, `search.db` (+wal/shm) and the installed scripts. Deploy, run one `curator run`, and report which stale or archived skills now show Droid use. Restoring archived skills or resetting stale flags is **not** done automatically; it is proposed separately for approval.

## Proposed acceptance-criteria replacement (apply after plan approval)
1. A review records which curator steps depend on OpenCode-only data and what Droid transcripts provide (done in planning).
2. With the OpenCode database absent, the curator counts skill loads from Droid sessions, both direct and Script-wrapped with literal names, in each skill's use count and last-activity date.
3. Usage repair runs before stale marking, archiving and unused pruning, and a failed Droid refresh skips those steps instead of acting on missing evidence.
4. Droid skill-use evidence excludes reviewer and curator sessions and is not double-counted across repeated runs.
5. With the OpenCode database absent, the curator skips proposal scan, verification and promotion and reports that clearly; existing OpenCode behaviour remains where that database exists.
6. Automated tests cover Droid skill-use parsing, idempotent indexing, usage repair merging, curator ordering and the promotion skip.
7. After deployment, a curator run on this machine shows Droid skill uses counted, and its outcome (including affected stale or archived skills) is recorded in the task.
8. Curator documentation describes the supported session sources and the promotion behaviour.

## Risks and open points
- Undocumented transcript format; tests pin the observed shapes.
- Computed skill names inside Script are missed, so counts are a lower bound.
- Script logs (`~/.factory/artifacts/scripts`) are not needed and not used.
- Subagent inclusion (step 1) needs confirming at review.

## Branching
`task/TASK-13` from `main`; one PR to `main`.

## Task Manifest
| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Parse Droid skill uses | skills/autolearn/scripts/droid_sessions.py, skills/autolearn/scripts/test_droid_sessions.py, plugin/fixtures/droid-transcript.jsonl, plugin/fixtures/droid-transcript.expected.json | — | logic, test | parse_transcript returns direct and literal Script-wrapped skill uses with ids and timestamps, and none for reviewer or curator sessions |
| 2 | Index Droid skill uses idempotently | skills/autolearn/scripts/autolearn.py, skills/autolearn/scripts/test_search_droid.py | 1 | database, logic, test | Refresh backfills droid_skill_use from existing transcripts once, and reruns add no rows |
| 3 | Merge Droid uses into usage repair and reorder curator | skills/autolearn/scripts/autolearn.py, skills/autolearn/scripts/test_curator_droid_usage.py | 2 | logic, test | With OpenCode absent, curator run updates use_count and last_activity_at from Droid uses before stale, archive and prune steps |
| 4 | Skip promotion without OpenCode data | skills/autolearn/scripts/autolearn.py, skills/autolearn/scripts/test_curator_droid_usage.py | — | logic, test | With OpenCode absent, curator run reports long_horizon skipped no_opencode_source and leaves proposals.json unchanged |
| 5 | Document curator sources | skills/autolearn/references/curator.md, skills/autolearn/references/cli.md, README.md | 3, 4 | docs | Docs describe Droid skill-use evidence, run ordering and the promotion skip |
| 6 | Deploy and verify live | (deploy, no code) | 5 | infra | A live curator run counts Droid skill uses and the affected stale or archived skills are reported in the task |
<!-- SECTION:PLAN:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @droid
created: 2026-11-12T00:16:00Z

---

Plannotator review 2026-11-12: plan not approved. The user wants this folded into a larger task that repackages Autolearn as a Factory Droid-only plugin in droid-plugins, dropping the other harnesses. TASK-13 is now a child of TASK-14 (TASK-14 depends on it). The housekeeping-only plan above targets this repo's files and must be re-planned against the new plugin before implementation.

---

author: @droid
created: 2026-11-12T00:22:00Z

---

Superseded 2026-11-12: this work moved to the droid-plugins board (https://github.com/marcusyoung/droid-plugins). TASK-14 -> droid-plugins TASK-1; TASK-13 -> droid-plugins TASK-1.1 (housekeeping-only scope). Archive here during cleanup, with approval.

---
<!-- COMMENTS:END -->
