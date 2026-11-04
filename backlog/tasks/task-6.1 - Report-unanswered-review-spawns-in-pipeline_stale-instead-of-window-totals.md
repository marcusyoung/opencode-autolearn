---
id: TASK-6.1
title: Report unanswered review spawns in pipeline_stale instead of window totals
status: To Do
assignee: []
created_date: '2026-11-04T20:26:00Z'
labels: []
dependencies: []
parent_task_id: TASK-6
priority: low
type: bug
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `pipeline_stale` observation introduced by TASK-6 records cumulative spawn and completion counts from the retained observation-log window (for example spawned 578, completed 417 on 2026-11-01 and 2026-11-02) even when only a handful of recent spawns are unanswered. A reader cannot tell a live backlog from historical drift: on 2026-11-04 the live log paired 410 completions against 578 spawns and left 168 unanswered, but every one of those 168 sits in two closed windows (September adapter churn and the 2026-10-16 Cursor auth lapse), and the pipeline has been clean since 2026-10-26. The health check itself is correct and currently returns healthy; what is misleading is the evidence it writes to the log and to the daily job's stderr. A future outage should produce a record whose counts describe the thing that is wrong.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A pipeline_stale observation states how many review spawns in the scanned window have no completion, so a live backlog is distinguishable from historical drift
- [ ] #2 The counts in the event describe only the scanned window and agree with an independent recount of that same window
- [ ] #3 A healthy pipeline still records nothing and exits 0, including an idle stretch whose newest spawn already has a completion
- [ ] #4 Automated tests cover a window with unanswered spawns and a window where every spawn completed, and the JS test suite passes
- [ ] #5 README documents the new fields in the pipeline-stale failure-surface entry
<!-- AC:END -->
