---
title: the state-history-transports sameState flake fails about one run in four, enough to bounce gates
date: 2026-09-28
status: resolved
---

Follow-up to `2026-09-28-state-history-transports-sameState-flakes-on-the-genesis-timestamp.md`, seen while finishing `trie-derived-from-the-flat-state`: `pnpm exec playwright test test/state-history-transports.spec.ts --repeat-each 6` failed 3 of 12 runs (chromium and webkit) at `expect(t.sameState).toBe(true)`, and two consecutive full-suite runs each failed on it. `test/helpers/state-history-transports.ts` is unchanged from `main`, so this is pre-existing, but at this rate it will bounce roughly a third of full-suite gates; comparing via `stateOfDump` (as `test/helpers/state-history.ts` already does) looks like the fix.

Resolved 2026-09-28 by `rename-statemode-to-computestateroot` (forward-pointer in that task): `test/helpers/state-history-transports.ts` now compares `stateOfDump` (exported from `test/helpers/state-history.ts`, shared rather than copied) instead of whole dumps. Test-only; the node's genesis behaviour is unchanged.
