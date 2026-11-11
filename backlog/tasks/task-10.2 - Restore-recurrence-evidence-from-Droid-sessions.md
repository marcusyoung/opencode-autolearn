---
id: TASK-10.2
title: Restore recurrence evidence from Droid sessions
status: To Do
assignee: []
created_date: '2026-11-11T18:43:00Z'
labels: []
dependencies: []
references:
  - TASK-10
  - skills/autolearn/scripts/autolearn.py
  - skills/autolearn/scripts/proposer.py
  - plugin/autolearn-droid.mjs
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
