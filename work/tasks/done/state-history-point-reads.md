---
title: stateHistory option, and point reads at any block in the window
slug: state-history-point-reads
spec: bounded-state-history
blockedBy: [state-change-set-capture]
covers: [2, 3, 7, 8, 9, 11, 18, 21]
needsAnswers: true
---

## What to build

The user-facing half of history for the four POINT reads. `createNode({stateHistory: {blocks: N}})` (a positive safe integer; absent means off; anything else throws at construction; no default window) switches on the open record from `state-change-set-capture` and RETAINS it: at the end of each mined block the open record is sealed as `undo[blockNumber]`, and records older than `head - N` are dropped.

`eth_getBalance`, `eth_getCode`, `eth_getStorageAt` and `eth_getTransactionCount` at a block K in the window take, per key, the first hit scanning `undo[K+1]` .. `undo[head]` then the open record, else the live value. No state manager involvement, no checkpoint. Every block reference that names K works (number, hash, EIP-1898 `{blockNumber}` / `{blockHash}`, `earliest` when block 0 is in the window).

The gate is the existing `requireHeadState` in `src/node.ts`: below `head - N` it still refuses with `-32000 historical state not available`, with the message now naming the oldest servable block and the `stateHistory` option; within the window it serves from history; the head is unchanged, including `evm_set*` cheats applied since the head was mined (they are visible at the head and at no older block). `eth_call` / `eth_estimateGas` below the head stay REFUSED in this task (`historical-eth-call` lifts that); say so in the refusal.

`stateMode:'trie'` with `stateHistory` is refused at construction, naming the reason (trie mode is not on the flat state until `trie-derived-from-the-flat-state`).

A batch that throws mid-block (a refused sender) leaves its committed writes in the open record, attributed to the next block, which is where the state now stands.

## Acceptance criteria

- [ ] The snapshot DIFFERENTIAL: after every block, snapshot every touched key through the four reads; mine further (the same write-route coverage as `state-change-set-capture`'s battery); every read at every K in the window equals K's snapshot. On both engines.
- [ ] Window edges: `head - N` served, `head - N - 1` refused with the new message; after one more block the edge moves by one.
- [ ] A cheat applied between blocks j-1 and j is invisible at j-1 and visible from j; a cheat applied after the head is visible at the head only.
- [ ] Memory is bounded: after mining well past N, the node retains exactly N sealed records (direct probe).
- [ ] A node without `stateHistory` gives exactly today's answers and refusals (`test/block-pinned-state.spec.ts` unchanged and green).
- [ ] `stateHistory` with `stateMode:'trie'`, and invalid `stateHistory` values, throw at construction.
- [ ] A new ADR in `docs/adr/` (next free number, see `work/protocol/ADR-FORMAT.md`): "bounded state history is an undo log over the flat state", with the rejected alternatives (per-block state snapshots; per-block retained tries, which only give roots and would need every old trie node kept; diffing state at the end of each block, O(state) per block, the cost ADR 0009 removed for storage). Update the `requireHeadState` JSDoc, whose "why refuse" section this supersedes in part.

## Blocked by

- `state-change-set-capture`

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/bounded-state-history.md`, then `work/tasks/done/state-change-set-capture.md` and the code it landed (the open record in `src/state-manager.ts`). Read `requireHeadState` and its JSDoc in `src/node.ts`: it is the gate you extend.

Goal: the `stateHistory: {blocks: N}` option on `NodeOptions` (`src/types.ts`), sealing and eviction in the mining path (`executeAndMine`), and history-served point reads for the four non-executing state methods. Keep every read inside the existing serialisation point (it already is: it is the dispatcher). Test with the harness pattern in `test/helpers/cut.ts` / `cut-revm.ts`; the differential is the bar, engine-parameterised.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
