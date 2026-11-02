---
id: TASK-9
title: Fix pre-existing test_wiki.py failures on a clean tree
status: To Do
assignee: []
created_date: '2026-10-27T14:44:00Z'
labels: []
dependencies: []
references:
  - TASK-6
priority: medium
type: bug
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
test_write_pattern_line_cap and test_enabled_false in the autolearn wiki test suite fail identically on an unmodified tree. They were noted during TASK-6 verification as unrelated debt that still leaves CI/local runs with a false sense that new work caused the failures. Clearing them restores a green baseline for wiki tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 test_wiki.py::test_write_pattern_line_cap passes on a clean checkout
- [ ] #2 test_wiki.py::test_enabled_false passes on a clean checkout
- [ ] #3 The rest of the skills/autolearn/scripts test suite still passes after the fix
- [ ] #4 If the tests were wrong rather than the code, the corrected expectations are documented in the test or adjacent comment so the intent is clear
<!-- AC:END -->
