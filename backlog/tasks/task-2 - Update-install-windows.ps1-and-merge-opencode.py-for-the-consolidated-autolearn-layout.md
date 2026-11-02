---
id: TASK-2
title: >-
  Update install-windows.ps1 and merge-opencode.py for the consolidated
  autolearn layout
status: Done
assignee: []
created_date: '2026-09-22 19:32'
updated_date: '2026-09-22 19:35'
labels: []
dependencies: []
references:
  - 'C:/Users/myoun/git-repos/opencode-autolearn-local/install-windows.ps1'
  - 'C:/Users/myoun/git-repos/opencode-autolearn-local/merge-opencode.py'
priority: medium
type: bug
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Upstream consolidated three skills (autolearn-reviewer, autolearn-curator, self-improving-agent) into one skills/autolearn skill (SKILL.md plus references/) and renamed the repo to ericmjl/agent-autolearn. Our fork carries that consolidation on branch local-fixes-v2 together with the committed Windows spawn fixes (Blocker B/C). install-windows.ps1 and merge-opencode.py still target the old three-skill layout, so the next run throws at step 2 while copying skill dirs that no longer exist, points the CLI at the removed skills/autolearn-reviewer path, verifies removed SKILL.md paths, and merge-opencode.py rewrites the reviewer prompt back to the retired autolearn-reviewer skill text. Because the Windows fixes are now a committed change on local-fixes-v2, the windows-spawn.patch apply step is obsolete when installing from that branch. Reference implementation to mirror: install.sh in the fork clone.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 install-windows.ps1 copies skills/autolearn (SKILL.md, references/, scripts/) into %USERPROFILE%\.agents\skills\autolearn and removes the three legacy skill dirs, mirroring install.sh step 2
- [x] #2 install-windows.ps1 resolves the CLI at skills/autolearn/scripts/autolearn.py for the store init step
- [x] #3 install-windows.ps1 verification checks skills/autolearn/SKILL.md, skills/autolearn/scripts/autolearn.py and skills/autolearn/scripts/improve.py, and no longer references the removed paths
- [x] #4 merge-opencode.py writes the consolidated reviewer prompt that loads the autolearn skill and references/reviewer.md
- [x] #5 A full install-windows.ps1 run against a local-fixes-v2 checkout completes all five steps without throwing, and the installed plugin resolves its CLI to the new skills/autolearn path
- [x] #6 Header documentation and reset instructions describe the new layout and state that applying windows-spawn.patch is unnecessary when installing from local-fixes-v2
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rewrite install-windows.ps1 step [2/5]: drop the three-dir legacy loop; remove autolearn-reviewer, autolearn-curator and self-improving-agent, then copy skills\autolearn recursively into %USERPROFILE%\.agents\skills (mirror install.sh step 2).
2. Point step [4/5] at $skillsDir\autolearn\scripts\autolearn.py for init / retention score / memory compose.
3. Update step [5/5] verify list: autolearn\SKILL.md, autolearn\scripts\autolearn.py, autolearn\scripts\improve.py; keep plugin, store and hide-uv.vbs checks; drop the removed paths.
4. Rewrite the header doc comment: describe the consolidated layout; state that windows-spawn.patch is not needed when installing from local-fixes-v2; revise the reset instruction accordingly.
5. merge-opencode.py: write the consolidated reviewer prompt AND update it when an existing autolearn-reviewer agent still carries the retired prompt (add an elif, mirroring install.sh).
6. DECISION: mirror install.sh step 1b and install the pi extension (autolearn-pi.ts + autolearn-core.mjs into %USERPROFILE%\.pi\agent\extensions), or skip it since pi is not used here.
7. DECISION: retire windows-spawn.patch (Blocker B/C are committed on local-fixes-v2) - keep as historical with an obsolete note, or delete.
8. Verify end-to-end: run the updated installer against the local-fixes-v2 checkout; all five steps pass and the installed plugin resolves its CLI to skills/autolearn/scripts/autolearn.py.
9. Commit the helper-repo changes (on request).
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation: install-windows.ps1 step 2 removes autolearn-reviewer/autolearn-curator/self-improving-agent and copies skills/autolearn; step 4 resolves the CLI at skills/autolearn/scripts/autolearn.py; step 5 verifies autolearn/SKILL.md + scripts/autolearn.py + scripts/improve.py; header doc updated (patch flow retired). merge-opencode.py writes the consolidated reviewer prompt and now also updates an existing autolearn-reviewer agent via an elif (previously create-only). windows-spawn.patch deleted per approved decision D2; pi extension install skipped per D1.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Updated the Windows helper installer to the consolidated autolearn layout. Verified by an end-to-end run of install-windows.ps1 against the local-fixes-v2 checkout: all five steps completed ("Done!"), the three legacy skill dirs are gone, the installed skill and plugin files match the repo, resolveCli resolves ~/.agents/skills/autolearn/scripts/autolearn.py, and opencode.json carries the consolidated reviewer prompt with model optiproxai/async preserved. py_compile passes for merge-opencode.py.
<!-- SECTION:FINAL_SUMMARY:END -->
