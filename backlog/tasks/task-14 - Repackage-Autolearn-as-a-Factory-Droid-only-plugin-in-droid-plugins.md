---
id: TASK-14
title: Repackage Autolearn as a Factory Droid-only plugin in droid-plugins
status: To Do
assignee: []
created_date: '2026-11-12T00:16:00Z'
labels: []
dependencies:
  - TASK-13
references:
  - TASK-13
  - TASK-10.2
  - https://github.com/marcusyoung/droid-plugins
  - https://github.com/marcusyoung/opencode-autolearn
priority: high
type: feature
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Autolearn's core value is creating new skills automatically from repeated work. It was built for several harnesses (OpenCode, Cursor, pi), and on this machine only Factory Droid is now used. Keeping the multi-harness layers means every fix has to fit OpenCode-era data that no longer exists, as TASK-13 showed: the daily curator still reads OpenCode-only outcomes, so Droid skill use goes uncounted and skills are marked stale or archived. The user decided on 2026-11-12 to stop adapting around OpenCode, drop support for the other agents, and ship Autolearn as a Factory Droid plugin in the droid-plugins repository (https://github.com/marcusyoung/droid-plugins), alongside the handoff and connapse-memory plugins. This board tracks the work because droid-plugins has no Backlog board. TASK-13 (curator skill-use housekeeping from Droid evidence) is a child of this work and must be re-planned against the new plugin. Evidence gathered so far: TASK-13 plan and comments, and handoff d60db092-74ef-462f-a892-a7f154c3968e.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Autolearn installs as a plugin from the droid-plugins marketplace and works in Factory Droid without the opencode-autolearn install scripts.
- [ ] #2 The reviewer, observer, Droid session search index and recurrence gate, and reviewer-driven skill creation work under Droid at least as well as the current deployment.
- [ ] #3 The plugin contains no OpenCode, Cursor or pi adapters, and nothing in it depends on OpenCode data being present.
- [ ] #4 Existing Autolearn state (skills, memories, usage records, search index, observations, wiki) carries over with a recoverable backup, and no created skill is lost or archived by the move.
- [ ] #5 The previous installation's hooks and scheduled jobs are retired so nothing runs twice after the plugin is installed.
- [ ] #6 Curator housekeeping counts Droid skill use before marking skills stale or archiving them (TASK-13).
- [ ] #7 Automated tests for the plugin live under tests/autolearn in droid-plugins and pass.
- [ ] #8 The plugin README documents installation, configuration, scheduled jobs, the migration from the old installation, and how to roll back.
<!-- AC:END -->
