---
id: doc-3
title: droid-auth-preflight
type: other
created_date: '2026-11-02T19:12:00Z'
---
# Droid reviewer auth preflight: API key first, then stored-login probe

**Status**: accepted (2026-11-02)
**Task**: TASK-10

## Context
The Droid adapter spawns `droid exec` from a hook to run the autolearn reviewer. The detached child's errors are not visible, so a credential failure must be detected before any review file is written (the Cursor auth loss in October 2026 left the pipeline silently dead for ten days, TASK-6).

Facts checked on 2026-11-02:
- Factory docs (droid-exec/overview, droid-cli/cli-reference) document only `FACTORY_API_KEY`, framed for CI. They say nothing about a stored-login fallback.
- `droid exec` succeeds with `FACTORY_API_KEY` absent, using the stored Droid app login.
- Factory removes `FACTORY_API_KEY` (and `HINDSIGHT_API_KEY`, `SECRETCTL_PASSWORD`) from the shells it starts for tool calls, although they are set at User scope. The hooks doc says hooks inherit the local environment; whether the key reaches hook processes is unverified.
- `droid doctor --json --checks auth` runs in about 0.6 s, makes no model call, and reports `auth.verify` with status `pass` when the stored login is usable.
- The stored login's access token expires within hours and is refreshed in the background, so it can lapse; an API key does not.

## Decision
Preflight passes when `FACTORY_API_KEY` is set and non-empty. Otherwise run `droid doctor --json --checks auth` and require the `auth.verify` result to have status `pass`. A timeout, missing binary, non-JSON output or any other status blocks the spawn and records one deduped `auth_missing` observation (scope `droid`). The probe runs only when a review is due, not on every Stop.

The helper lives in `plugin/autolearn-auth.mjs` beside the Cursor check and reuses its probe code (spawn, timeout and Windows shim handling) and `nextAuthState` dedupe.

## Alternatives rejected
- **Key-only check (original AC #8):** always fails in Factory child processes, which do not receive the key, while `droid exec` would have worked.
- **Doctor only:** if hooks do receive the key, `droid exec` would authenticate with the key while the check tested the login, so a lapsed login would block reviews that would have succeeded.
- **Helper inside autolearn-droid.mjs:** stays within the original file list but duplicates about 30 lines of probe logic, so fixes to the Cursor probe would not reach it.

## Consequences
- `plugin/autolearn-auth.mjs` and `plugin/test-auth-guard.mjs` join the TASK-10 change surface.
- Mirrors the Cursor pattern (`CURSOR_API_KEY` short-circuit, then `agent status --format json`).
