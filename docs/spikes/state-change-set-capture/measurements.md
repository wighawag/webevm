# What the bottom-level `getAccount` copy costs

Task: `state-change-set-capture`. Script: [`measure-bottom-level-copy.mjs`](./measure-bottom-level-copy.mjs) (every number below is a line it printed). Node v24.19.0, AMD Ryzen 9 9955HX, on top of `c6463bf` with this task's change built into `packages/webevm/dist`.

## Why there is a copy

`SimpleStateManager.getAccount` returns the `Account` object stored in the top account map. With no checkpoint open (the bottom level, where the `evm_set*` cheats run), a caller that edits that object and then calls `putAccount` has overwritten the prior value before any write hook sees it, so the per-block change set would record the NEW value as the old one. The node's own `mutateAccount` (`evm_setBalance`, `evm_setNonce`, `evm_setAccount`) and upstream `modifyAccountFields` (reached from `putCode`, so `evm_setCode`) both do exactly that. `OverlayStorageStateManager.getAccount` therefore hands out a copy at the bottom level, and only there: inside a checkpoint each level already holds copies and the record reads a write's prior from the level below, which that level cannot mutate.

## 1. Per read

| `getAccount` at the bottom level | ns per read (3 runs) |
| --- | --- |
| copy (shipped) | 389.7, 379.5, 382.2 |
| no copy (upstream) | 285.8, 281.1, 281.0 |

About **100 ns** per bottom-level read. Most of each figure is the `await` of an async method, which both pay.

## 2. How many a transaction makes

A plain transfer on the default engine makes **1** bottom-level `getAccount` (the node's own `refuseIfSenderCannotSend`); every read inside `runTx` happens under its checkpoint and is not copied. The script exits non-zero if this count changes.

## 3. End to end (300 transfers through `eth_sendRawTransactionSync`, auto mining)

| run | copy, recording off | no copy, recording off | copy, recording on |
| --- | --- | --- | --- |
| 1 (cold) | 1.538 ms/tx | 1.334 ms/tx | 1.322 ms/tx |
| 2 | 1.202 ms/tx | 1.202 ms/tx | 1.210 ms/tx |
| 3 | 1.205 ms/tx | 1.223 ms/tx | 1.198 ms/tx |

One copy per transaction is 0.1 µs against 1.2 ms: below the run-to-run noise, with change-set recording off or on. The first run is JIT warm-up. RPC reads (`eth_getBalance`, `eth_getTransactionCount`) pay the same 100 ns each, which is also below anything a consumer can see.

## Decisions (linked from the done record)

1. **The in-place mutation hazard is closed at the seam, by copying on bottom-level reads, for every node.** Chosen because both known routes (`mutateAccount` and upstream `modifyAccountFields`) go through `getAccount`, and so will any future one. The copy is unconditional (not only with recording on) so that aliasing semantics never depend on an internal flag. Rejected: fixing `mutateAccount` alone (upstream `modifyAccountFields` does the same); recording the prior on the first bottom-level READ of a key (it would put every `eth_getBalance`'d key in the record, a superset the history would then store per block); copying at every level (the default engine's hot path runs inside checkpoints and needs none). Touches: every bottom-level `getAccount` caller (RPC reads, cheats, `refuseIfSenderCannotSend`), none of which relied on aliasing. Code site: `getAccount` in `packages/webevm/src/state-manager.ts`.
2. **The record is checkpoint-aware by keeping one record PER LEVEL**, created lazily on a level's first write, holding the value from the level below; `commit()` merges it down with the older entry winning, `revert()` drops it. Chosen over recording at the bottom only (it would have to be undone on revert, i.e. a second journal). Touches: `checkpoint`/`commit`/`revert` of `OverlayStorageStateManager`. Code site: the header of `src/state-manager.ts`.
3. **Pure reads suspend recording**, as a cost rule only: `eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s estimate (with or without state overrides) run under `withChangeSetsSuspended`. Correctness does not depend on it (their levels are reverted), and a commit INTO the bottom level while suspended is refused before anything moves. Code sites: `pureRead` in `src/node.ts`, `withChangeSetsSuspended` in `src/state-manager.ts`.
4. **The node takes the record at the end of each mined block and keeps only the head block's**, so a cheat between blocks belongs to the next block (the first that can see it), and an empty `mine()` takes it too. Holding a WINDOW of them is `state-history-point-reads`' job, which replaces the one slot. Taking the record with a checkpoint open is refused (its writes would be attributed to the wrong block). Code site: `executeAndMine` in `src/node.ts`.
5. **Baselines are cleared, not recorded**: the record is taken and discarded right after genesis is stored (so `initialBalances` / `initialState` are block 0) and at the end of `loadState` (explicit or through `persistence`), which also forgets the head block's record, since a dump carries none. Code sites: after `storeBlock(genesis, ...)` and the end of `loadState` in `src/node.ts`.
6. **The switch is internal and the accessor test-only**: `createNodeWithInternals(options, {recordChangeSets})` and `changeSetsForTests(node)` in `src/node.ts`, neither exported from `src/index.ts` and neither added to `SlimNode` (the worker proxy's shape test compares every `SlimNode` key across the comlink boundary). `recordChangeSets` in `stateMode:'trie'` throws, since the record lives in `OverlayStorageStateManager`; the spec's user-facing refusal of `stateHistory` in trie mode is `state-history-point-reads`' to add. The tasks that expose it (`state-history-point-reads` via `stateHistory`, `trie-mode-derives-its-root-from-the-flat-state` via `computeStateRoot`) set the internal flag from their option.
7. **`assertStateShape` checks the new writers AFTER the storage accessors**, so a flat `SimpleStateManager` (which lacks both) is still refused with the storage message `test/storage-overlay.spec.ts` pins, and a manager with the storage half but not the writers is refused with a message naming each missing one.
8. **The bundle-size pin is re-pinned to 436.3 KB raw / 131.4 KB gzip**, which also absorbs 5.8 KB that `8c2cb50` added on `main` without re-pinning (the test was already red there at 432.0 / 130.3). Both steps are written into the pin's history in `packages/benchmarks/test/evm.spec.ts`, the older one marked as not re-pinned when it landed, and the finding is in `work/notes/observations/2026-09-28-bundle-size-pin-left-red-by-8c2cb50.md`. Alternative considered: re-pin nothing and leave `verify` red for a reason this task did not cause (it would bounce the land); re-pinning only this task's share is impossible, since the test has one threshold.
9. **No changeset**: nothing here is user-facing yet (no option, no exported API; `createNodeWithInternals` and `changeSetsForTests` are not exported from `src/index.ts`). The option that exposes it (`state-history-point-reads`) carries the changeset.
