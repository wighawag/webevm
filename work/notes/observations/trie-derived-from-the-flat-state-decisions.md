---
title: Decisions taken while building trie-derived-from-the-flat-state
date: 2026-09-28
status: open
---

The in-scope decisions of `trie-derived-from-the-flat-state` that a reviewer might not expect, one entry each. The architectural ones are in `docs/adr/0014-the-trie-is-derived-from-the-flat-state-not-a-state-manager.md`; these are the smaller ones.

1. **The derived trie PRUNES old nodes** (`useNodePruning`, one in-memory database per trie). Chose it because the node only ever reports its head's root, so a retained node is never read again and would make memory grow with every block; the legacy `MerkleStateManager` path did not prune. Alternative: no pruning, matching the old path's memory behaviour. Touches memory only; the differential and every root oracle pass with it. Recorded at the choice site, the header of `packages/webevm/src/derived-trie.ts`.
2. **`getStateRoot()` applies the whole open record each time** (and the block applies it again when mined). Chose idempotent re-application (the record names keys, values are re-read from the flat state) over tracking what was already applied, because it is correct by construction and the cost is only paid by repeated `getStateRoot()` calls between blocks. Recorded at `currentStateRoot` in `packages/webevm/src/node.ts`.
3. **The transitional differential ran OUTSIDE the tree**, as a Node script against a build of the pre-change commit (`docs/spikes/trie-derived-from-the-flat-state/`), rather than as an in-tree spec against a temporarily kept `MerkleStateManager` path. Chose it because the old path is deleted by this same change, so no production code had to carry a switch for it; the script and its captured output are the record the task asks for, and it was shown to fail on a seeded bug. Alternative: an internal `legacyMerkleStateManager` flag and a spec, deleted before landing.
4. **`'none'` mode "does no trie work" is proven by a module counter**, `derivedTriesCreatedForTests()` in `src/derived-trie.ts` (test-only, not exported from `src/index.ts`), with a trie-mode node as the control. Alternative: a flag on the node's test probe, which would only claim it.
5. **`runConformanceOnEngine` lost its `serves` / `refuses` parameters** (test helper, `test/helpers/conformance.ts`): no engine refuses a mode any more, so it runs the battery in both modes and returns `byMode`. `test/revm-conformance.spec.ts` asserts both.
6. **`test/statetest.spec.ts` is untouched** (the acceptance says "passes unchanged"); the revm run is a new sibling, `test/revm-statetest.spec.ts`, and `runStateTests` gained an optional engine factory and reports which engines ran.
7. **Another task's pending changeset was edited**: `.changeset/bounded-state-history.md` said `stateHistory` is refused with `stateMode:'trie'`, which this change makes false before either is released; the sentence now says it works in both modes, so the combined release notes do not contradict themselves.
8. **No compatibility path for trie-mode dumps written before this change** (they carry no storage). Recorded in ADR 0014's consequences.
9. **Test-only probe placement**: the state-history battery gained a `stateMode` parameter, and its "without history" case now expects change-set recording ON in trie mode (the trie consumes change sets) while still sealing nothing (`test/state-history-expected.ts`).
