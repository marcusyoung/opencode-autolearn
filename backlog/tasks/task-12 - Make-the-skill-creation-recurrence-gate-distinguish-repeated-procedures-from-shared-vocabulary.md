---
id: TASK-12
title: >-
  Make the skill-creation recurrence gate distinguish repeated procedures from
  shared vocabulary
status: To Do
assignee: []
created_date: '2026-11-11T19:39:00Z'
labels: []
dependencies:
  - TASK-10.2
references:
  - TASK-10.2
  - https://github.com/marcusyoung/opencode-autolearn/pull/6
  - skills/autolearn/scripts/proposer.py
priority: medium
type: enhancement
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Before `skill create`, the reviewer must show via `proposals recurrence` that a pattern recurs in at least 3 sessions. A session counts if any one of its typed user messages shares at least half the key words of the query, measured against the smaller word set (overlap coefficient, proposer.py `_overlap_coefficient` and `is_recurrent`). Short messages therefore match on a single common word. Once TASK-10.2 restored a current index (rehearsal: 340 Droid sessions), broad queries matched 41 and 54 sessions, so the gate now rarely blocks and skill creation depends mainly on reviewer judgement and the one-change-per-review limit. The algorithm predates TASK-10.2; it was not changed there by design. Review whether the gate should be stricter, using real recurrence results gathered after TASK-10.2 is deployed.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A recurrence check counts a session only when that session genuinely repeats the queried procedure, not when it merely shares common words with the query.
- [ ] #2 Requests that do recur across sessions with varied wording are still reported as recurrent.
- [ ] #3 Before any change, the behaviour of the current gate on the live index is measured on a sample of real reviewer queries, and the findings are recorded in the task.
- [ ] #4 Any change to the matching rule or threshold is approved before implementation, and its effect on the same sample is reported.
- [ ] #5 Automated tests cover broad common-word queries, short messages, and genuinely recurring requests with varied wording.
- [ ] #6 Reviewer documentation describes how the gate decides recurrence.
<!-- AC:END -->
