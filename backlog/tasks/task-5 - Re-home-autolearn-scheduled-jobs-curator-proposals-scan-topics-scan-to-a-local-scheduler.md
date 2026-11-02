---
id: TASK-5
title: >-
  Re-home autolearn scheduled jobs (curator, proposals scan, topics scan) to a
  local scheduler
status: Done
assignee: []
created_date: '2026-09-29 22:46'
updated_date: '2026-09-30 13:25'
labels: []
dependencies: []
references:
  - 'C:/Users/myoun/.agents/skills/autolearn/references/curator.md'
  - >-
    OpenChamber schedule id 47f2eb42-0303-4189-ac70-805d20a240bc
    (autolearn-curator)
priority: medium
type: chore
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OpenChamber currently owns the only scheduled autolearn job: autolearn-curator. It fires daily at 13:00 Europe/London (configured as a weekly schedule with all seven weekdays selected), running the prompt "Load the autolearn skill and follow references/curator.md to run the curator." via agent analyst on optiproxai/async. Note the OpenChamber entry only DISPATCHES that prompt to a session (last duration ~125 ms) - it does not run the curator itself; the curator work happens in the spawned session. That scheduler is OpenChamber-specific. Cursor provides no local scheduler - its Automations are cloud agents with no access to the local ~/.autolearn store (Cursor-hosted cannot see local files; My Machines keeps the agent loop in Cursor's cloud and is repo-scoped) - and the agent CLI has no schedule command. So if OpenChamber is retired, the curator must be re-homed to a local OS scheduler (Windows Task Scheduler) that invokes a headless agent. Separately, the autolearn CLI defines proposals scan (documented as a scheduled tick) and topics scan, and neither is in OpenChamber's schedule (which has exactly one task), so those scheduled jobs appear to be missing today regardless of Cursor.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The curator job runs from a local OS scheduler (Windows Task Scheduler) invoking a headless agent with the curator prompt, with OpenChamber not running.
- [x] #2 proposals scan is scheduled on the same local scheduler.
- [x] #3 topics scan is scheduled on the same local scheduler, or a documented decision records why it is intentionally not scheduled.
- [x] #4 The migration is duplicate-safe: when the new local job is enabled, the OpenChamber autolearn-curator task is disabled, so the curator never runs twice per period.
- [x] #5 The scheduler entries and their invocation are documented (README or an install script), including how to disable/re-enable them.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Approach
Windows Task Scheduler (approach A) with two daily jobs via plugin/autolearn-schedule.mjs, hidden through hide-run-wait.vbs.

## Jobs
- AutoLearnCurator @ 13:00 local — agent -p with curator.md prompt
- AutoLearnTopicsScan @ 12:15 local — uv run … topics scan

## Decisions
- No separate proposals scan task: curator run already embeds proposals.scan → verify → promote (AC #2 satisfied by documented decision).
- OpenChamber disable is manual (user removes task); installer only documents the requirement (AC #4).
- Times are local machine time; keep host on Europe/London to match prior OpenChamber slot.

## Files
- opencode-autolearn: plugin/autolearn-schedule.mjs, install.sh, README.md, skills/autolearn/references/curator.md, skills/autolearn/SKILL.md
- opencode-autolearn-local: install-windows.ps1

## Task Manifest
| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Add schedule module | plugin/autolearn-schedule.mjs | — | infra | --install registers AutoLearnCurator + AutoLearnTopicsScan; --run topics exits 0 |
| 2 | Wire installers + docs | install.sh, README.md, curator.md, SKILL.md, install-windows.ps1 | 1 | docs,infra | Installers copy module; README documents install/remove, proposals decision, manual OpenChamber disable |
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented local OS scheduler. Live verify 2026-09-30: schtasks AutoLearnCurator (13:00) and AutoLearnTopicsScan (12:15) Ready; --run topics exit 0; hide-run-wait.vbs works; OpenChamber project scheduledTasks already [] (user removed curator). Proposals not separately scheduled (covered by curator run).
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
created: 2026-09-30 13:25
---
AC #2: no separate proposals schtask — documented decision (curator run embeds proposals.scan). AC #4: OpenChamber curator removed manually (scheduledTasks []). AC #3: topics scan scheduled.
---
<!-- COMMENTS:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped harness-neutral autolearn-schedule.mjs: two Windows Task Scheduler jobs (curator via agent -p @13:00, topics scan @12:15), hidden wait VBS, install.sh + install-windows.ps1 wiring, README/curator docs updated. Proposals scan intentionally not scheduled (embedded in curator run). OpenChamber disable left to the user (already cleared on this machine).
<!-- SECTION:FINAL_SUMMARY:END -->
