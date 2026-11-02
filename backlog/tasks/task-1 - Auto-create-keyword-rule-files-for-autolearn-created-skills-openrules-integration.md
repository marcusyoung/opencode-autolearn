---
id: TASK-1
title: >-
  Auto-create keyword rule files for autolearn-created skills (openrules
  integration)
status: In Progress
assignee: []
created_date: '2026-09-08 12:17'
updated_date: '2026-09-08 13:06'
labels: []
dependencies: []
references:
  - 'https://github.com/frap129/opencode-rules'
documentation:
  - decisions/symlinked-rule-files
  - decisions/shared-archive-rule-removal
priority: medium
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
opencode-autolearn creates skills in ~/.autolearn/personas/default/skills/ (symlinked into ~/.agents/skills via cmd_skill_create in skills/autolearn-reviewer/scripts/autolearn.py), but nothing surfaces new auto-created skills to agents through the keyword-rule pattern used by the frap129/opencode-rules plugin (rules live in ~/.config/opencode/rules/*.md as frontmatter keywords + a 'STOP until you have loaded and understood the <skill> skill.' body). | Enhancement (agreed design, Option C hybrid): extend the skill lifecycle so a matching rule file is created and retired automatically. cmd_skill_create gains an optional --keywords flag; the autolearn-reviewer agent derives semantic keywords from the skill content and passes them; code falls back to name-derived keywords when the flag is omitted. Rule template matches the existing rules-file convention exactly. cmd_skill_archive gains symmetry: archiving a skill also removes its autolearn-generated rule file. | Runtime dependency: frap129/opencode-rules must be installed for rules to take effect (already installed and active on this host); rule writing is inert-but-safe if absent. | Delivery context: upstream code lives in fork marcusyoung/opencode-autolearn (origin) with ericmjl/opencode-autolearn as upstream (remote); local deltas are commits on the local-fixes branch. Project home and board: opencode-autolearn-local. Consider filing the cross-platform parts upstream as a PR.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cmd_skill_create accepts an optional --keywords flag (comma-separated); when provided it writes ~/.config/opencode/rules/<skill-name>.md with a frontmatter keywords list and a 'STOP until you have loaded and understood the <skill-name> skill.' body, matching the format of existing rules files
- [ ] #2 When --keywords is omitted, cmd_skill_create still writes a rule file with keywords derived from the skill name so the rule exists deterministically
- [ ] #3 Rule file creation is skipped gracefully (non-fatal) if the rules directory cannot be written; skill creation itself still succeeds
- [ ] #4 cmd_skill_archive removes the matching autolearn-generated rule file when archiving a skill; a pre-existing hand-written rule must not be deleted
- [ ] #5 Reviewer SKILL.md is corrected (installed copy, upstream clone, local-fixes branch) to instruct passing LLM-derived keywords from the skill body when running skill create
- [ ] #6 The change lives as commits on the local-fixes branch of the fork (marcusyoung/opencode-autolearn); windows-spawn.patch is updated or retired in favor of the branch
- [ ] #7 End-to-end verification: create a throwaway test skill via autolearn.py skill create with --keywords, confirm the rule file appears and the openrules plugin picks it up; archive it and confirm the rule file is removed
- [ ] #8 The Obsidian note 'opencode-autolearn - Windows install and update' is updated to document the fork workflow, the new feature delta, and the opencode-rules plugin dependency
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
# Implementation Plan — Auto-create keyword rule files (openrules integration)

## Architectural context
- Codebase: clone `C:\Users\myoun\git-repos\opencode-autolearn`, branch `local-fixes` (commit 4205093). Primary file: `skills/autolearn-reviewer/scripts/autolearn.py`; secondary: `skills/autolearn-reviewer/SKILL.md`.
- Rules convention (verified against existing `~/.config/opencode/rules/*.md`): YAML frontmatter with `keywords:` list; body `STOP until you have loaded and understood the `<skill>` skill.` Plugin frap129/opencode-rules is installed and active on this host.
- Skill archive happens in THREE places: `cmd_skill_archive` (manual, autolearn.py:935), curator inactivity archive (autolearn.py:~1022), `prune_unused_skills` (autolearn.py:485, invoked from curator run at :1078). `falsify.apply_consequences` only demotes to stale — never archives.
- Existing precedent for cross-directory linkage: `AGENTS_SKILLS_DIR` symlink (autolearn.py:874-877) — the same pattern is reused for rules.

## Design decisions
1. **Symlinked rule files** (recommended over plain real files): canonical `rule.md` lives inside the skill dir (`~/.autolearn/personas/<persona>/skills/<name>/rule.md`); the rules dir gets a symlink `~/.config/opencode/rules/<name>.md` pointing at it. Benefits: (a) archive-time provenance is structural — delete the rules entry only if it is a symlink resolving into the persona skills dir, so hand-written real files can never be deleted; (b) rule content travels with the skill into `.archive`, making archive reversible; (c) matches the AGENTS_SKILLS_DIR precedent. Fallback when symlink creation fails (Windows privilege): write a real file into the rules dir whose frontmatter carries `created_by: autolearn`; removal then falls back to the marker test.
2. **Shared rule-removal helper** used by all three archive paths — prevents zombie rules from the two automatic archive paths (curator inactivity + never-used pruning).
3. `RULES_DIR` is host-global (not persona-aware): `Path(os.environ.get("OPENCODE_RULES_DIR", Path.home() / ".config" / "opencode" / "rules"))`, mirroring `AGENTS_SKILLS_DIR` env-override style (autolearn.py:98).

## Changes
1. **autolearn.py constants**: add `RULES_DIR` near `AGENTS_SKILLS_DIR` (line ~98). Not reassigned by `set_persona()`.
2. **Helpers** (near cmd_skill_create):
   - `write_skill_rule(name, keywords: list[str]) -> bool`: write canonical `rule.md` in the skill dir with frontmatter (`name`, `keywords`, `created_by: autolearn`, `created_at`) + STOP body; then symlink `RULES_DIR/<name>.md` to it. On `OSError`: fall back to a real file in `RULES_DIR` with `created_by: autolearn` frontmatter. Any failure: print a warning and return False — never fatal.
   - `remove_skill_rule(name) -> None`: if `RULES_DIR/<name>.md` is a symlink resolving inside the persona `SKILLS_DIR` → unlink. Elif real file whose frontmatter contains `created_by: autolearn` → delete. Else → leave untouched (hand-written rule). Never raises.
3. **cmd_skill_create** (autolearn.py:832): after the AGENTS_SKILLS_DIR symlink step, parse `--keywords` (comma-separated); when omitted derive keywords from the slugified name (split on hyphen, dedupe). Call `write_skill_rule`. Extend the printed summary with the rule path.
4. **cmd_skill_archive** (autolearn.py:935): after usage update, call `remove_skill_rule(name)`.
5. **Curator inactivity archive loop** (autolearn.py:~1022-1028): call `remove_skill_rule(name)` for each newly archived skill.
6. **prune_unused_skills** (autolearn.py:~508-528): call `remove_skill_rule(name)` inside the archived loop.
7. **Argparse** (autolearn.py:~2222): `sk_create.add_argument("--keywords", default=None, help="Comma-separated keywords for the opencode-rules rule file")`.
8. **SKILL.md** (Step 7, line ~279): instruct the reviewer to derive 5-15 semantic keywords from the skill body/description (phrases a user would actually type) and pass `--keywords "k1,k2,..."`; note the name-derived fallback.
9. **Port after approval**: copy updated `autolearn.py` + `SKILL.md` to the installed copies (`~/.agents/skills/autolearn-reviewer/scripts/autolearn.py` and `SKILL.md`), per past windows-spawn porting practice.

## Files
- `skills/autolearn-reviewer/scripts/autolearn.py` (clone, local-fixes branch)
- `skills/autolearn-reviewer/SKILL.md`
- Installed copies: `~/.agents/skills/autolearn-reviewer/{scripts/autolearn.py,SKILL.md}` (post-approval port step)
- Obsidian note 'opencode-autolearn - Windows install and update' (AC8: fork workflow, feature delta, plugin dependency)

## Constraints / risks / open questions
- Windows symlink privilege: mitigated by real-file fallback (Decision 1).
- Multi-persona rule-name collisions are theoretical (only persona 'default' exists); `RULES_DIR` stays global — out of scope.
- `windows-spawn.patch` is untouched: it covers orthogonal Windows fixes; AC6 is satisfied by the feature living on the local-fixes branch. Patch backup remains verified against pristine main.
- No existing test suite for the autolearn.py CLI — verification is e2e (AC7) plus direct helper smoke tests.
- Agent cannot run git commits (established constraint): provide exact commit commands for the user at the end.

## Task Manifest

| # | Title | Files | Depends On | Labels | Acceptance Criterion |
|---|---|---|---|---|---|
| 1 | Add RULES_DIR constant + rule write/remove helpers | skills/autolearn-reviewer/scripts/autolearn.py | — | logic | write_skill_rule() creates canonical rule.md plus rules-dir link (symlink, or real file with created_by marker on fallback); remove_skill_rule() deletes only autolearn-owned entries and never a hand-written rule; manual smoke test passes |
| 2 | Wire rule creation into cmd_skill_create (--keywords) | skills/autolearn-reviewer/scripts/autolearn.py | 1 | logic | skill create with --keywords and without it both produce rule files (AC1, AC2); rules-dir write failure is non-fatal (AC3) |
| 3 | Wire rule removal into all three archive paths | skills/autolearn-reviewer/scripts/autolearn.py | 1 | logic | manual archive, curator inactivity archive, and prune_unused_skills each remove the autolearn rule; a hand-written rule survives (AC4) |
| 4 | Update reviewer SKILL.md create instruction | skills/autolearn-reviewer/SKILL.md | 2 | docs | SKILL.md instructs deriving semantic keywords from the skill body and passing --keywords (AC5, clone copy) |
| 5 | Port to installed copies + e2e verify + docs | ~/.agents/skills/autolearn-reviewer/*, Obsidian note | 2,3,4 | infra | AC7 e2e passes on installed copies (create with keywords → rule appears; archive → rule removed); AC8 Obsidian note updated |
<!-- SECTION:PLAN:END -->
