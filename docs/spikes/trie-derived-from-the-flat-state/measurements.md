# The transitional root differential: derived trie vs `MerkleStateManager`

Task: `trie-derived-from-the-flat-state`. Script: [`differential.mjs`](differential.mjs). Environment: Node v24.19.0, `@ethereumjs/*` 10.1.2, `@ethereumjs/mpt` 10.1.2, measured 2026-09-28.

## What it compares

The same chain driven through two `stateMode:'trie'` nodes: the LEGACY build (commit `b83704b`, trie mode on `MerkleStateManager`) and the NEW build (the flat `OverlayStorageStateManager` plus the derived trie of `src/derived-trie.ts`). After every step it compares the head block's header `stateRoot` AND `getStateRoot()`, and it fails on any zero root. Three runs:

1. **The post-state battery's shapes**, one transaction per block with auto mining: a creation, a nested creation, storage through nested call frames, an account emptied under EIP-161, a `SELFDESTRUCT` in the creating transaction, a survivor deployed and killed in a later transaction (EIP-6780, nothing removed), a tip to the coinbase, `evm_setAccount` with storage, a slot zeroed by `SSTORE`, a slot zeroed by a cheat (emptying a storage trie), cheats between blocks and cheats after the head, then an empty block.
2. **Several transactions per block** with manual mining, including a cheat issued with a transaction pending and five transfers creating five accounts in one block.
3. **300 randomised cheats** (seeded) over 12 accounts: balances, nonces, code (including clearing it) and storage (a third of the storage writes are ZERO), with a root comparison after about one step in ten and a block mined about one step in fifteen.

## Result

```
OK post-state shapes, auto mining: 32 roots compared (15 distinct), 0 mismatches
OK several transactions per block: 12 roots compared (6 distinct), 0 mismatches
OK randomised cheats: 158 roots compared (69 distinct), 0 mismatches
```

## It can fail

Run once with a deliberate bug in the built `derived-trie.js` (an account whose STORAGE changed is not rewritten into the account trie, so its `storageRoot` goes stale):

```
XX post-state shapes, auto mining: 32 roots compared (14 distinct), 4 mismatches
XX several transactions per block: 12 roots compared (5 distinct), 5 mismatches
XX randomised cheats: 158 roots compared (69 distinct), 46 mismatches
```

A second deliberate change, skipping the `storageCleared` handling, did NOT fail it, and that is correct rather than a blind spot: a storage clear also records every slot the account held (ADR 0013's change set), so re-reading the named slots already deletes them; the clear only saves the per-slot deletes.

## What is deliberately not in it

A creation over a storage-only account: the legacy path refuses it (EIP-7610) and the new one creates over it and wipes the storage (the reference spec, ADR 0014), so the roots are expected to differ. That case has its own tests: the storage-collision cases in `packages/webevm/test/trie-derived.spec.ts` and `test/revm-trie-derived.spec.ts`. Storage is also only seeded at existing accounts, because the legacy `MerkleStateManager.putStorage` throws on a missing one.

## Why it is transitional

The old path is deleted by the same change, so this cannot run in the test suite; it ran while the change landed and is kept here as the record. The permanent root oracles do not live in the node: the GeneralStateTests post-state roots (`test/statetest.spec.ts`, and `test/revm-statetest.spec.ts` with revm executing) and the conformance battery's trie-backed `@ethereumjs/vm` reference (`test/conformance.spec.ts`, and `test/revm-conformance.spec.ts` in both modes).

The spike `docs/spikes/revm-eip-7610-storage-collision/probe-storage-collision.mjs` is a dated record of the engines' behaviour on 2026-09-28 before this change; run against this build, its `default@trie` storage rows now read `created` (they expected `collision`), which is exactly the change this task made.
