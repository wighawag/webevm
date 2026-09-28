---
title: state-history-transports' sameState check compares whole dumps and flakes on the genesis second
date: 2026-09-28
status: resolved
---

Seen while running the full suite for `trie-derived-from-the-flat-state`: `test/state-history-transports.spec.ts` failed once on chromium at `expect(t.sameState).toBe(true)` and passed on three immediate re-runs. `test/helpers/state-history-transports.ts` computes `sameState` as `JSON.stringify(worker.dumpState()) === JSON.stringify(reference.dumpState())`, i.e. whole dumps including block headers, receipts and transactions, whose hashes depend on genesis being stamped with `Date.now()` in whole seconds, so two nodes created either side of a second boundary differ while holding identical state. `test/helpers/state-history.ts` already fixed the same flake for its own determinism check with `stateOfDump` (accounts, code, storage, history and the block count only); the transports helper looks like it wants the same treatment.

Resolved 2026-09-28 by `rename-statemode-to-computestateroot` (forward-pointer in that task): `test/helpers/state-history-transports.ts` now compares `stateOfDump` (exported from `test/helpers/state-history.ts`, shared rather than copied) instead of whole dumps. Test-only; the node's genesis behaviour is unchanged.
