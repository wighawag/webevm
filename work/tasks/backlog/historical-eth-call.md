---
title: eth_call and eth_estimateGas at a block in the history window
slug: historical-eth-call
spec: bounded-state-history
blockedBy: [state-history-point-reads]
covers: [1, 4, 5, 6, 14]
---

## What to build

Lift the remaining refusal: with `stateHistory` on, `eth_call` and `eth_estimateGas` pinned to a block K in the window EXECUTE against K's state and K's block environment, on both engines.

- **K's state:** compute, per key, the earliest-wins union over `undo[K+1]` .. `undo[head]` plus the open record (the same lookup the point reads use), and apply it through the EXISTING state-override path (`withStateOverrides` in `src/node.ts`: a checkpoint the request opens, writes, runs the read, and reverts; its JSDoc explains why that is safe under the serialisation point). An ABSENT account must read as absent (not as a zero account), and a storage-cleared marker must clear the account's storage before its recorded slots are applied. Two traps in reusing the override path as it stands: `SimpleStateManager.putCode` CREATES an account when none exists, and `deleteAccount` leaves the address's code in the code map (so `eth_getCode` and `EXTCODESIZE` on the default engine would still see it). `withStateOverrides` also takes RPC JSON and applies account, then code, then storage. So factor out an INTERNAL apply step that takes already-parsed entries, writes code before the account, and ends with `deleteAccount` plus an emptied code entry for an entry that is absent at K; the RPC override path and the historical path both use it. The caller's own state overrides (third parameter) are applied ON TOP, after K's state.
- **K's block environment:** run with block K's stored `Block` (so `NUMBER`, `TIMESTAMP`, `COINBASE`, `PREVRANDAO`, `BASEFEE`, `GASLIMIT` are K's).
- **BLOCKHASH:** both EVMs already answer zero for `BLOCKHASH(n)` when `n >= NUMBER`, so running with K's `Block` may be enough on its own. FIRST write the acceptance test and run it without any extra mechanism. Only if it fails on an engine, add a node-level READ HORIZON consulted by that engine's block-hash source (the `getBlockHash` handed at connect, or the default engine's mock blockchain `getBlock`), reset in a `finally`, and record why it was needed.

The result must not change the head: dump before and after a historical call is byte-identical, on both engines.

## Acceptance criteria

- [ ] The consumer case, as its own test, in the shape bomber-world uses: read the block number, mine twice (each changing storage and emitting a log), then `eth_getLogs` up to the pinned block and a viem `readContract` at the pinned block describe the same moment.
- [ ] A view reading storage and the block environment (the existing `BlockEnvProbe` contract) called at K returns K's storage and K's `NUMBER` / `TIMESTAMP` / `COINBASE` / `PREVRANDAO`; `BLOCKHASH(K)` returns zero and `BLOCKHASH(K-1)` returns the real hash.
- [ ] Accounts created, self-destructed and storage-cleared after K are reconstructed as they were at K (absent, present with all slots, and so on). In particular `EXTCODESIZE` of a contract created after K is 0 at K, on both engines.
- [ ] `eth_estimateGas` at K reflects K's state (a transfer to an address that had no code at K but has code now estimates as 21000).
- [ ] State overrides compose with a historical block.
- [ ] Purity: a `dumpState` before and after a historical `eth_call` / `eth_estimateGas` is identical, and (if a BLOCKHASH horizon was needed) it is reset even when the call reverts or throws. On both engines.
- [ ] Full suite green, including the concurrency batteries.

## Blocked by

- `state-history-point-reads`

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/bounded-state-history.md`, the two done tasks before this one (`state-change-set-capture`, `state-history-point-reads`) and the ADR the second one wrote. Read `withStateOverrides`, `evmCall`, `requireHeadState` and the comment at `serialise` in `src/node.ts`, and how each engine answers BLOCKHASH (`getBlockHash` passed at `connectEngine`, `mockBlockchain` in `src/node.ts`, the revm store's `blockHash`).

Goal: historical execution by reusing the override mechanism, not by swapping state roots or copying state. Engine-parameterise the battery (`cut.ts` and `cut-revm.ts`), and reuse `test/helpers/block-env-probe.ts`.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
