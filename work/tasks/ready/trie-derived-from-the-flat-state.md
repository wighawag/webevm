---
title: Trie mode runs on the flat state, with the trie derived per block
slug: trie-derived-from-the-flat-state
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: [state-change-set-capture, state-history-persistence, state-history-docs-and-worker]
covers: [1, 2, 3, 4, 5, 6, 7, 8, 9]
---

> FORWARD-POINTER (conductor, 2026-09-28): the gate's `pnpm test` includes `packages/benchmarks`, whose `bundle size per backend` test pins the default entry's size (`DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts`). Any growth in `packages/webevm/src` core fails it. If your change grows the core bundle, re-pin it in the same change after `pnpm build`, with a history entry at the top of the RE-PINNED list saying what grew and why, as `state-change-set-capture` and `state-history-point-reads` did. Run the FULL verify (`pnpm format:check && pnpm build && pnpm test`), not only the webevm suite.

## What to build

Make `stateMode:'trie'` mean "the same flat state as every node, plus a Merkle-Patricia trie derived from it". The name stays `stateMode:'trie'` in this task; `rename-statemode-to-computestateroot` renames it afterwards.

- `MerkleStateManager` stops being a node state manager: every node runs on `OverlayStorageStateManager`.
- In trie mode the node maintains a trie directly with `@ethereumjs/mpt`: an account trie keyed by `keccak(address)` and one storage trie per account keyed by `keccak(slot)`, each account's `storageRoot` set from its storage trie when the account is written into the account trie.
- The INPUT is the per-block change set from `state-change-set-capture` (the open record names every key changed; the new values are read from the flat state). Switch the open record on when trie mode is on, with or without `stateHistory`. This replaces the node's incomplete `touchedAccounts` set, which misses accounts changed by an internal call that emits no log.
- The trie is built ONCE from the FULL flat state at construction (after `initialBalances` / `initialState`, whose writes are baselines and are deliberately NOT in any change set) and at the end of `loadState`, then kept current from change sets. A trie built from change sets alone would omit the genesis state and every GeneralStateTests root would fail.
- Roots are computed at the end of each mined block, before the block is stored (its header carries the root, as today), and in `getStateRoot()` for cheat writes pending since the head. Both already run inside the serialisation point. Execution never touches the trie.
- revm's construction-time refusal of trie mode is REMOVED.
- Trie mode dumps and loads exactly like `'none'` (storage included); on load the trie is rebuilt once from the loaded flat state. The trie itself is never serialised.
- `stateHistory` with trie mode is no longer refused (story 9).

**Storage-only creation collisions follow the reference spec, on every node** (decided with the user 2026-09-28, reversing the spec's earlier "EIP-7610 everywhere" decision; evidence in `work/notes/findings/storage-only-creation-collisions-are-not-refused-by-the-reference-spec.md`). A creation over a zero-nonce, code-less address that holds storage SUCCEEDS and wipes the storage, as execution-specs PR #3508 specifies (EIP-684 plus the Yellow Paper). `'none'` mode and revm already do exactly that, so this falls out of moving trie mode onto the flat state; the one test that pins trie mode REFUSING it (the EIP-7610 case in `test/helpers/slim-node-checks.ts` and its spec) is FLIPPED to assert the reference behaviour in both modes, not deleted and not parked. The README's state-mode asymmetry paragraph and the EIP-7610 note in the `src/state-manager.ts` header are REWRITTEN (not appended to): there is no asymmetry any more, and the text says which rule every node follows and cites the finding.

## Acceptance criteria

- [ ] `test/statetest.spec.ts` (GeneralStateTests post-state roots) passes unchanged in trie mode, and additionally with revm installed.
- [ ] A DIFFERENTIAL against the old `MerkleStateManager` path: the same chain (the post-state battery's shapes, cheats between blocks and after the head) yields identical per-block roots and identical `getStateRoot()`. This differential is TRANSITIONAL: run it while the change lands, then delete it together with the old path. The PERMANENT root oracles are the existing ones that do not live in the node: the GeneralStateTests post-state roots and the conformance battery's trie-backed `@ethereumjs/vm` `runTx` reference.
- [ ] revm runs in trie mode; the revm conformance battery gains a trie-mode run.
- [ ] A trie-mode dump includes storage, and a reload reproduces every root.
- [ ] `'none'` mode does no trie work (direct probe: no trie object is created).
- [ ] History works in trie mode (one of `state-history-point-reads`' batteries run in trie mode).
- [ ] A creation at a storage-only address succeeds and wipes the storage on every node (with and without trie mode) and on both engines; the nonce and code collisions are still refused everywhere (reuse the spike's cases in `docs/spikes/revm-eip-7610-storage-collision/`).
- [ ] A new ADR: "the trie is derived from the flat state, not a state manager", which also records that storage-only collisions follow the reference spec (EIP-684, storage wiped) rather than EIP-7610, with the finding as its source, and a superseding amendment to ADR 0005's "`stateMode:'trie'` is a no" section. README's state-mode section updated.

## Blocked by

- `state-change-set-capture` (the change set is the input)
- `state-history-persistence` (both change dump/load in `src/node.ts`; serialised to avoid conflicts)
- `state-history-docs-and-worker` (both rewrite the README's state sections; this one removes the trie-mode refusal that one documents)

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md`, ADRs 0005, 0009 and 0010 (0010 anticipated this route: "a state root computed OUTSIDE revm over the authoritative state stays reachable"), and the done `bounded-state-history` tasks for the change-set seam. In `src/node.ts` read `currentStateRoot`, `commitIfTrie`, `touchedAccounts`, `dumpState` / `loadState` and the trie branches; in `src/revm.ts` the trie-mode refusal.

Goal: one state representation, a derived trie, and revm allowed in trie mode, with the roots as the bar. Do not rename `stateMode` here.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
