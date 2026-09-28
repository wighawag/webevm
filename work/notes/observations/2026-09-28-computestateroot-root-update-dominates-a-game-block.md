---
title: computeStateRoot's per-block root update dominates a realistic game block (about 0.1 ms per changed slot)
date: 2026-09-28
status: open
---

Measured by `computestateroot-cost-benchmark` ([`docs/spikes/computestateroot-cost-benchmark/measurements.md`](../../../docs/spikes/computestateroot-cost-benchmark/measurements.md)): with `computeStateRoot: true` a block costs its plain cost plus a root update linear in slots changed, at about 0.1 ms (80-130 µs across two runs) per slot on both engines and both browsers. At 300 changed slots that is 25-39 ms, more than a 16.6 ms frame on its own, and on the revm engine it turns a block of under 1 ms into one of 26-39 ms. That crosses the task's threshold ("more than a few ms at a few hundred changed slots"), so it is recorded here rather than optimised there.

Where to look, from a probe (not a diagnosis): the cost is `@ethereumjs/mpt`'s per-`put` cost, about 130 µs with `useNodePruning` and 66 µs without, because the library hashes and stores the whole path at every `put`, and `src/derived-trie.ts` calls `put` once per changed slot. Candidates, none evaluated: batch a block's slot writes into one pass that hashes each touched node once, drop `useNodePruning` in favour of periodic compaction (memory growth is why it is on, see the module header), or a purpose-built in-memory trie that defers hashing to `root()`. The GeneralStateTests roots and the conformance battery are the bar any of them would have to keep.
