---
id: TASK-11
title: Retain the full configured window when the observation log is trimmed
status: To Do
assignee: []
created_date: '2026-11-04T20:26:00Z'
labels: []
dependencies: []
priority: low
type: bug
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The observation log at ~/.autolearn/personas/default/observations.jsonl is the authoritative history for the pipeline health check, and it is capped at a fixed number of records. Trimming keeps one record fewer than the configured cap, and the health check's tail read then drops another, so the window the check reports on is shorter than the retention setting and its counts understate the file. On 2026-11-04 the live check reported spawned=577 while the file held 578 review_spawned records; a direct probe of the trim helper with a 1000-record file and a 1000-record cap left 999 records. The effect is small but it silently shortens retained history on every trim and makes every reported count off by one or two, which undermines the counts used to diagnose a stalled pipeline.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Trimming an observation log above the retention cap leaves exactly the configured maximum number of records
- [ ] #2 A health check over a full window counts every retained record, so its spawn count equals a full recount of the same file
- [ ] #3 The trimmed file keeps one JSON object per line and remains readable, with no merged or truncated record
- [ ] #4 Automated tests cover trimming at the cap boundary and count parity between the health check and a full file recount, and the JS test suite passes
<!-- AC:END -->
