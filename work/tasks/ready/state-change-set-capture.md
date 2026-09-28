---
title: Capture every state write's prior value in one place, on both engines
slug: state-change-set-capture
spec: bounded-state-history
blockedBy: []
covers: [10, 12, 13, 14]
---

## What to build

The foundation both `bounded-state-history` and `trie-mode-derives-its-root-from-the-flat-state` stand on: an OPEN RECORD (the per-block change set) that names every account, code entry and storage slot changed since the head was mined, together with the value each had at the end of the previous block (first-write-wins). No option exposes it yet; it is switched on by an internal flag the next tasks wire to `stateHistory` and `computeStateRoot`, and a node with it off records nothing.

The record lives in ONE place: the node's own state manager subclass (`OverlayStorageStateManager`). Every write already reaches it except two routes, and both are closed here:

- **revm's account and code writes.** The revm state store (`src/revm-state-store.ts`) writes the top account and code maps directly (`setAccount`, `setCode` resolved on the next `setAccount`, `removeAccount`). Route them through new SYNCHRONOUS methods on the subclass, exactly as `setStorageAt` / `clearStorageAt` already are, and extend `assertStateShape` to require them.
- **In-place mutation defeats a write hook, and it happens today.** `SimpleStateManager.getAccount` returns the `Account` object stored IN the top account map, with no copy. At the BOTTOM level (no checkpoint open, which is where the `evm_set*` cheats run) a caller that edits that object and then calls `putAccount` has already overwritten the prior value before any hook on `putAccount` runs, so the hook would record the NEW value as the old one. Known routes: the node's own `mutateAccount` (`evm_setBalance`, `evm_setNonce`, `evm_setAccount`) and upstream `modifyAccountFields` (reached through `putCode`, so `evm_setCode` too). Inside a checkpoint this is harmless (a pushed level holds copies), which is why transactions would pass a naive test. Close it at the seam, not per caller: for example `getAccount` handing out a copy, or recording the prior value on the first `getAccount` of a key at the bottom level; choose, measure the per-read cost on the default engine, and record the decision. Fixing `mutateAccount` alone is NOT enough, because upstream `modifyAccountFields` does the same.
- **The default engine's account and code writes.** Only the storage half is overridden today. Override the account/code writers the subclass inherits from `SimpleStateManager` (`putAccount`, `deleteAccount`, `putCode`, `modifyAccountFields`, and any other inherited method that writes the account or code maps; read `@ethereumjs/statemanager@10.1.2`'s `SimpleStateManager` to enumerate them rather than trusting this list).

Keys are: an account (whole account, or ABSENT), code by address, a storage slot, and a per-account storage-cleared marker. A storage CLEAR (creation at an address holding storage, `SELFDESTRUCT`, EIP-161 removal) records the account's slots not already in the open record: O(slots of that account), paid only on a clear.

Recording rules:

- **Checkpoint-aware.** A write inside a checkpoint level that is later REVERTED must not leave a record. The simplest correct shape is to record on the level (first write per key per level) and merge records on `commit`, drop them on `revert`, mirroring how the storage overlays already work. Decide and document.
- **Suspended for pure reads** (`eth_call`, `eth_estimateGas`, state overrides), whose levels are always reverted anyway; this is a cost rule, not a correctness one.
- **Baselines are not history.** Writes at construction (`initialBalances`, `initialState`) and by `loadState` go through the same state manager before any block exists. The open record is CLEARED when genesis is stored and at the end of `loadState`, or a later read at genesis would reconstruct EMPTY state.
- **Cheats count.** An `evm_set*` cheat between blocks is recorded like any write and belongs to the next block.

## Acceptance criteria

- [ ] With the internal flag on, after each mined block the open record satisfies the INVARIANT: for every key whose value at the end of the block differs from its value at the end of the previous block, the record holds the previous value. A superset (a key written and restored) is allowed.
- [ ] The invariant is proven by a DIFFERENTIAL on both engines (the shared battery run through `cut.ts` and `cut-revm.ts`): full state is snapshotted through the public surface before and after each block, and the record is checked against the difference. The chain covers plain transfers, contract creation, nested frames writing storage, a reverted transaction, `SELFDESTRUCT`, an EIP-161 removal, creation at an address that already held storage, all five `evm_set*` cheats between blocks, and `eth_call` / `eth_estimateGas` / state overrides interleaved (reuse the shapes in `test/helpers/post-state.ts`).
- [ ] Each of the five `evm_set*` cheats, applied at the BOTTOM level (no checkpoint open) between blocks, records the value the key had BEFORE the cheat (the in-place mutation case above), asserted explicitly and not only through the differential.
- [ ] A reverted transaction, an `eth_call`, an `eth_estimateGas` search and a state override leave no trace in the record.
- [ ] After construction with `initialBalances` / `initialState`, and after `loadState`, the record is empty.
- [ ] With the flag off (the default), the record stays empty after mining, asserted by a direct probe.
- [ ] `assertStateShape` refuses a state manager lacking the new synchronous methods, with a message naming them.
- [ ] The whole existing suite still passes on both browsers, including the concurrency and post-state batteries.

## Blocked by

None: can start immediately.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`), an in-browser, execution-only EIP-1193 Ethereum node with two engines: the default `@ethereumjs/evm` and revm-wasm (`webevm/revm`). Both read and write the node's ONE flat state, `OverlayStorageStateManager` in `src/state-manager.ts` (ADRs 0005, 0009, 0010). Read `work/specs/tasked/bounded-state-history.md` for the feature this serves.

Goal: build the per-block OPEN RECORD of prior values described above, in the state manager subclass, with revm's direct account/code writes rerouted through new synchronous methods. Before touching anything, read the long comment at `serialise` in `src/node.ts` (the checkpoint-stack corruption hazard) and the header of `src/revm-state-store.ts` (why revm writes the representation synchronously). Do not add a user-facing option; `state-history-point-reads` does that.

Test through the node's public surface with the harness pattern in `test/helpers/cut.ts` / `cut-revm.ts` (a mode per battery, a spec per cut; see `test/rpc-params-expected.ts` for the shared-assertions shape). The record itself may be read through a test-only accessor, named as such.

Command cost rules: put `timeout` in front of any shell command whose cost you have not reasoned about and cap output with `head`; never run an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters in anything you write. Done means: the acceptance criteria pass, `pnpm exec playwright test` is green on chromium and webkit, and prettier is clean.

## Requeue 2026-09-28

The previous build was interrupted by a host restart, not by a gate failure. The branch holds its WIP (state-manager.ts open-record + revm-state-store.ts reroute). Review it, finish the task, and make sure all acceptance criteria are covered by tests: explicit bottom-level tests for each of the five evm_set* cheats, and the snapshot differential through BOTH cut.ts and cut-revm.ts.
