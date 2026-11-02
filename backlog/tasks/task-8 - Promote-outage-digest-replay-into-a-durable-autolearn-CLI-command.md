---
id: TASK-8
title: Promote outage digest-replay into a durable autolearn CLI command
status: To Do
assignee: []
created_date: '2026-10-27T14:44:00Z'
labels: []
dependencies: []
references:
  - TASK-6
  - https://github.com/marcusyoung/opencode-autolearn/pull/2
priority: medium
type: feature
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The 2026-10 Cursor CLI auth outage left dozens of orphaned review files. Recovery used a one-off digest builder in a temp directory that folded many review slices into per-project digests so replay finished in under an hour instead of serial day-long reviews. That script is gone with the temp directory, so a future outage would require reinventing the same procedure. Autolearn needs a supported bulk-replay path that rebuilds digests from orphan reviews and runs them safely (serial writes to observations/memories/wiki).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A documented CLI command can build per-project digests from orphaned review files under a persona store
- [ ] #2 The same command (or a paired subcommand) can run those digests through the reviewer path without concurrent writers racing observations.jsonl or memories.jsonl
- [ ] #3 Replay respects an exclusion list for projects the operator opts out of
- [ ] #4 README (or CLI help) documents when to use digest replay versus normal per-review processing, and the procedure is covered by automated tests with fixture reviews
<!-- AC:END -->
