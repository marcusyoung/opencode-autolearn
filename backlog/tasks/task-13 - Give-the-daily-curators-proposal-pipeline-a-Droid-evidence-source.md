---
id: TASK-13
title: Give the daily curator's proposal pipeline a Droid evidence source
status: To Do
assignee: []
created_date: '2026-11-11T23:26:00Z'
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
