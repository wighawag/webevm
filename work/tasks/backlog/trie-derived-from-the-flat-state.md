---
title: Trie mode runs on the flat state, with the trie derived per block
slug: trie-derived-from-the-flat-state
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: [state-change-set-capture, state-history-persistence, state-history-docs-and-worker]
covers: [1, 2, 3, 4, 5, 6, 7, 9]
---

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

EIP-7610 is NOT changed here (it moves with `eip-7610-spec-current-in-every-mode`). Until then trie mode inherits `'none'` mode's clear-and-proceed behaviour; say so in the changeset and keep any existing test that asserts trie-mode `CREATE_COLLISION` pending on that task rather than deleting it (that task now lands after `rename-statemode-to-computestateroot`).

## Acceptance criteria

- [ ] `test/statetest.spec.ts` (GeneralStateTests post-state roots) passes unchanged in trie mode, and additionally with revm installed.
- [ ] A DIFFERENTIAL against the old `MerkleStateManager` path: the same chain (the post-state battery's shapes, cheats between blocks and after the head) yields identical per-block roots and identical `getStateRoot()`. This differential is TRANSITIONAL: run it while the change lands, then delete it together with the old path. The PERMANENT root oracles are the existing ones that do not live in the node: the GeneralStateTests post-state roots and the conformance battery's trie-backed `@ethereumjs/vm` `runTx` reference.
- [ ] revm runs in trie mode; the revm conformance battery gains a trie-mode run.
- [ ] A trie-mode dump includes storage, and a reload reproduces every root.
- [ ] `'none'` mode does no trie work (direct probe: no trie object is created).
- [ ] History works in trie mode (one of `state-history-point-reads`' batteries run in trie mode).
- [ ] A new ADR: "the trie is derived from the flat state, not a state manager", and a superseding amendment to ADR 0005's "`stateMode:'trie'` is a no" section. README's state-mode section updated.

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
