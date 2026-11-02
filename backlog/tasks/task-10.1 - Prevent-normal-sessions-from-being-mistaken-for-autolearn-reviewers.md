---
id: TASK-10.1
title: Prevent normal sessions from being mistaken for autolearn reviewers
status: To Do
assignee: []
created_date: '2026-11-02T23:57:00Z'
labels: []
dependencies: []
references:
  - plugin/autolearn-droid.mjs
  - plugin/autolearn-cursor.mjs
  - plugin/autolearn-core.mjs
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
- [ ] #1 Sessions marked AUTOLEARN_REVIEWER=1 remain excluded from review processing.
- [ ] #2 An unmarked reviewer session is excluded when its first genuine user message begins with the known generated reviewer prompt prefix.
- [ ] #3 A review heading or reviewer prompt prefix in tool output, assistant content, or a later user message does not by itself exclude a normal session.
- [ ] #4 The corrected reviewer classification applies consistently to the Droid and Cursor transcript-driven adapters.
- [ ] #5 Regression tests demonstrate both genuine reviewer exclusion and normal-session review eligibility, while existing cadence and deduplication tests remain passing.
<!-- AC:END -->
