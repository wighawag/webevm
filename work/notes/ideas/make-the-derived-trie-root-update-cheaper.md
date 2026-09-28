---
title: Make the computeStateRoot per-block root update cheaper
date: 2026-09-28
---

Only nodes created with `computeStateRoot: true` pay this. A plain node creates no trie at all (proven by the `derivedTriesCreatedForTests()` probe). With the option on, execution costs exactly what it does without it, but each mined block then pays a root update linear in the storage slots it changed: about 0.1 ms per slot (80-130 µs across two runs), the same on both engines and in Chromium and WebKit, because the update runs in JS after execution. A one-slot block gains about 0.25 ms, 100 slots about 9-10 ms, 300 slots about 25-39 ms, 1,000 slots about 100-125 ms. For a game that rewrites a few hundred slots per block that is more than a 16.6 ms frame, and on the revm engine it turns a block of under 1 ms into one of 26-39 ms. Measured by `computestateroot-cost-benchmark`: figures and conditions in `docs/spikes/computestateroot-cost-benchmark/measurements.md`, reproducible with the `computeStateRoot` rows and the root-update measurement in `packages/benchmarks`.

Where the time goes, from a probe (not a diagnosis): `@ethereumjs/mpt`'s per-`put` cost, about 130 µs with `useNodePruning` and 66 µs without, because the library hashes and stores the whole path on every `put`, and `packages/webevm/src/derived-trie.ts` calls `put` once per changed slot and once per changed account.

Candidate directions, none evaluated yet:

- Batch a block's writes per trie into one pass that hashes each touched node once, instead of re-hashing shared path nodes on every `put`.
- Drop `useNodePruning` and compact periodically instead. Pruning is on so that memory does not grow with every block (see the header of `derived-trie.ts`), so this trades memory for time and needs a measured bound.
- A purpose-built in-memory trie that marks paths dirty on write and defers all hashing to `root()`, which is the only time a root is asked for (end of block, and `getStateRoot()`).

The bar for any of them: the GeneralStateTests post-state roots (`test/statetest.spec.ts` and `test/revm-statetest.spec.ts`) and the conformance battery's trie-backed `@ethereumjs/vm` reference must stay green, and the benchmark's root-update rows should show the gain at 100, 300 and 1,000 slots. ADR 0014 records why the trie is derived from the flat state; any of these stays inside that design.
