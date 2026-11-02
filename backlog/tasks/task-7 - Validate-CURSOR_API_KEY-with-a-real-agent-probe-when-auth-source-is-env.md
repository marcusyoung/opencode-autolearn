---
id: TASK-7
title: Validate CURSOR_API_KEY with a real agent probe when auth source is env
status: To Do
assignee: []
created_date: '2026-10-27T14:44:00Z'
labels: []
dependencies: []
references:
  - TASK-6
  - https://github.com/marcusyoung/opencode-autolearn/pull/2
priority: medium
type: enhancement
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Preflight currently treats any non-empty CURSOR_API_KEY as authenticated without asking the Cursor CLI. An invalid or revoked key therefore opens the gate and only surfaces later as pipeline staleness (exit 4), after reviews have already been orphaned. During the 2026-10 auth-loss outage recovery this was documented as a known limit; a cheap real agent invocation when the credential source is env would fail closed at preflight instead.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 When CURSOR_API_KEY is set but unusable, curator and reviewer preflight refuse the run with the auth-failure exit path before any review file is written
- [ ] #2 When CURSOR_API_KEY is set and usable, preflight still succeeds without requiring an interactive login store
- [ ] #3 The probe cost stays bounded (single short agent call per cycle or job, with an explicit timeout) and is covered by automated tests with a fake/spawnable agent
- [ ] #4 README documents that env credentials are validated, not only presence-checked, and how an invalid key appears
<!-- AC:END -->
