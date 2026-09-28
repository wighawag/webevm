---
title: Bounded state history (answer state reads at recent past blocks)
slug: bounded-state-history
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

A client that reads a block number and then pins several reads to it (logs up to block N, and a view call at block N) expects the pair to describe ONE moment. On a real node it does. On webevm, `eth_getLogs` and `eth_getBlockByNumber` honour a past block, but the six state reads (`eth_call`, `eth_estimateGas`, `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`) cannot, because the node keeps only the state at its head.

Until the fix that precedes this spec, those six ignored the block and answered from the head: a silent wrong answer (found by bomber-world, whose client drew a position whose move it could not find). They now REFUSE a block below the head with `-32000 historical state not available`. That is honest, but a client whose head moved on between reading the block number and issuing the pinned read (interval mining, a second tab, a transaction of its own) now gets an error where a real node gives an answer.

## Solution

An OPT-IN, BOUNDED state history. `createNode({stateHistory: {blocks: N}})` makes the node answer every state read pinned to any of the last N blocks (plus the head) exactly as a node holding that block's state would, on both engines. A block older than the window is still refused, with a message naming the window and the option. A node created without the option behaves exactly as today and pays nothing.

The mechanism is a per-block UNDO LOG over the node's one flat state, not retained state copies or retained tries: while block j is built, the node records, for every account, code entry and storage slot the block changes, the value it had at the END of block j-1. A point read at block K takes the earliest record among blocks K+1..head (and the pending writes since the head), or the live value if there is none. A historical `eth_call` turns the same records into a state override and runs through the override mechanism that already exists: a checkpoint the request opens and reverts itself, inside the serialisation point.

The history is persisted: `dumpState` carries it and `loadState` restores it, so a reloaded page serves the same window.

## User Stories

1. As a game client, I want `eth_getLogs` up to block N and `eth_call` at block N to describe the same moment even when the head has moved past N, so that I never draw a position whose move I cannot find.
2. As a consumer, I want history to be opt-in with a window I choose (`stateHistory: {blocks: N}`), so that a node that does not need it pays no memory and no per-block cost.
3. As a consumer, I want `eth_getBalance`, `eth_getCode`, `eth_getStorageAt` and `eth_getTransactionCount` at any block K in the window to return the values at the end of block K.
4. As a consumer, I want `eth_call` and `eth_estimateGas` at block K to execute against K's state AND K's block environment (`NUMBER`, `TIMESTAMP`, `COINBASE`, `PREVRANDAO`, `BASEFEE`, `GASLIMIT`), so that a view that depends on the block answers as it would have then.
5. As a consumer, I want `BLOCKHASH` inside a call at block K to return the hashes of blocks below K and zero for K and above, as any node does, so that a historical call cannot see its own future.
6. As a consumer, I want state overrides to compose with a historical block (applied on top of K's state), so that a simulation at a past block works like one at the head.
7. As a consumer, I want every way of naming K to work (number, hash, EIP-1898 `{blockNumber}` / `{blockHash}`, `earliest` when block 0 is in the window), so that history is not reachable through one spelling only.
8. As a consumer, I want a block older than the window refused with `-32000 historical state not available`, and the message to state the window (oldest servable block) and the option that widens it, so that the refusal tells me what to do.
9. As a consumer, I want a node without `stateHistory` to keep today's behaviour exactly (head served, anything below refused), so that the feature changes nothing for anybody who did not ask for it.
10. As a consumer using the `evm_set*` cheats, I want a cheat applied between blocks j-1 and j to be invisible at block j-1 and visible from block j on, so that history reflects the chain and not the order I happened to poke it in.
11. As a consumer using the `evm_set*` cheats after the head was mined, I want the head to reflect them (as `latest` does today) and every older block not to, so that pending edits never leak backwards.
12. As a consumer, I want a transaction that reverts, an `eth_call`, an `eth_estimateGas` search or a state override to leave history untouched, so that reads never corrupt the past.
13. As a consumer, I want contract creation, `SELFDESTRUCT`, EIP-161 empty-account removal and a storage clear inside the window to be reconstructed correctly (the account, its code and ALL its slots as they were at K), so that the hard cases are not the wrong ones.
14. As a consumer on the revm engine, I want the same historical answers as on the default engine, so that choosing an engine does not change what the past was.
15. As a consumer with IndexedDB persistence, I want a reloaded node to serve the same window it served before the reload, so that a page refresh does not shrink what my client can ask.
16. As a consumer with a dump written before this feature, I want it to still load, with history starting at the loaded head, so that old saves keep working.
17. As a consumer who changes N between sessions, I want a dump with more history than the new window to be truncated to it, and one with less to serve what it has, so that the option always means "at most N".
18. As a consumer, I want memory to stay bounded: records older than the window are evicted as each block is mined, so that a long-running game does not grow without limit.
19. As a consumer of the Worker transport, I want `stateHistory` to pass through `exposeNode` like every other option, and historical reads to work over a port handed to `node.serveOn(port)` exactly as they do through `node.request`, so that the feature is not main-thread only and a consumer in another worker (an indexer) can pin reads too.
20. As a consumer, I want the README to state the cost (memory per changed key per block, and a historical call's cost proportional to the number of keys changed since K), so that I can size N for my game.
21. As a consumer of `stateMode:'trie'`, I want `stateHistory` refused at construction with a message naming the reason, until trie mode runs on the same flat state (spec `trie-mode-derives-its-root-from-the-flat-state`, which also replaces `stateMode` with `computeStateRoot`), so that it never silently records nothing.

## Implementation Decisions

- **Option:** `stateHistory?: {blocks: number}` on `NodeOptions`. A positive safe integer; absent means off. Invalid values throw at construction. No default window when enabled: the consumer states it.
- **Model:** one undo record per sealed block j (`undo[j]`), plus the OPEN record of writes since the head was mined. The invariant every piece is tested against: for every key whose value at the end of block j differs from its value at the end of block j-1, `undo[j]` holds the end-of-(j-1) value. A superset is allowed (a key written and restored). Keys are: account (whole account, or ABSENT), code by address, storage slot, and a storage-cleared marker per account.
- **Capture is first-write-wins, inside the node's own state manager subclass** (`OverlayStorageStateManager`), which every write already reaches EXCEPT revm's account and code writes: the revm store writes the top account/code maps directly. Those are to be routed through new synchronous methods on the subclass (as `setStorageAt` / `clearStorageAt` already are), so there is ONE place that sees every write on both engines. Only the storage half is overridden today: the subclass must ALSO override the account and code writers it inherits from `SimpleStateManager` (`putAccount`, `deleteAccount`, `putCode`, `modifyAccountFields`, and any other inherited method that writes the account or code maps), or the default engine's account writes go unrecorded. Rejected: diffing state at the end of each block, which is O(state) per block (the cost ADR 0009 removed for storage).
- **A storage clear records the account's slots not already recorded in the open record**: O(slots of that account), paid only on a clear (creation at an address with storage, `SELFDESTRUCT`, EIP-161 removal).
- **Capture is gated by EITHER consumer.** The open record (the per-block change set) is maintained when `stateHistory` is set OR when `computeStateRoot` is set (spec `trie-mode-derives-its-root-from-the-flat-state` consumes it to update its trie). Only RETAINING it, sealing it into `undo[]` and keeping N of them, is gated by `stateHistory`. A node with neither option records nothing.
- **Writes that PRECEDE the chain are not history.** `initialBalances` / `initialState` at construction and `loadState` write through the same state manager before (or instead of) any block, and recorded naively they would enter the open record as "was ABSENT", so a read at genesis, or at a loaded head, would reconstruct EMPTY state: the exact silent wrong answer this spec exists to prevent. So the open record is CLEARED when genesis is stored and at the end of `loadState` (the loaded head's state is the baseline, and its history, when the dump carries one, is restored as-is). Recording starts from those baselines.
- **Recording is suspended for pure reads** (`eth_call`, `eth_estimateGas`, state overrides, historical reconstruction), whose levels are always reverted. Recording them would still satisfy the invariant (a first write always sees the start-of-block value) but would grow the open record for nothing.
- **Sealing:** at the end of `executeAndMine`, the open record becomes `undo[blockNumber]` and records older than `head - N` are dropped. A batch that throws mid-block (a refused sender) leaves its committed writes in the open record, attributed to the next block, consistent with where the state now stands.
- **Point reads at K:** first hit scanning `undo[K+1]`..`undo[head]` then the open record; else the live value. No state manager involvement, no checkpoint.
- **Historical execution at K:** compute the earliest-wins union over the same range, apply it as a state override (the existing `withStateOverrides` path: checkpoint, write, run, revert), then the caller's own overrides on top, then run with block K's stored `Block`. A node-level READ HORIZON, consulted by both engines' `BLOCKHASH` source (`getBlockHash` in the engine context and the default engine's mock blockchain), makes block K and above answer zero for the duration of the call.
- **The check that exists today (`requireHeadState`) becomes the gate:** below `head - N` refuse as now (message extended with the window and the option); within the window serve from history; head unchanged.
- **Persistence:** `SerializedState` gains an OPTIONAL `history` field (per-block records, hex-encoded like the rest of the dump: account RLP or `null` for absent, code hex, slot values, cleared markers). The format stays `version: 1`, so old dumps load (empty history) and a dump written by a node without the option carries no field. Persistence saves it alongside state on every save that already happens.
- **ADR:** record "bounded state history is an undo log over the flat state, not retained state copies or tries", with the rejected alternatives (per-block snapshots, per-block retained tries, end-of-block diffing).

## Testing Decisions

- **The oracle is a differential against snapshots.** After every block, take the node's full state through its public surface (a `dumpState`, and the six reads over every touched key); mine further; then every read at every K in the window must equal the snapshot of K. The chain driven through it must cover every write route: plain transfers, contract creation, nested frames writing storage, a reverted transaction, `SELFDESTRUCT`, an EIP-161 removal, creation at an address that already held storage, all five `evm_set*` cheats between blocks AND after the head, and `eth_call` / `eth_estimateGas` / state overrides interleaved. `helpers/post-state.ts` already builds most of these shapes; reuse them rather than inventing new ones.
- **Engine-parameterised**, like the conformance, post-state and concurrency batteries: the same battery on the default engine and through `cut-revm.ts`, asserting identical results. The revm run is what proves the rerouted account/code writes are recorded.
- **Historical execution:** a view reading storage and the block environment (`BlockEnvProbe` exists) called at K returns K's storage and K's `NUMBER` / `TIMESTAMP` / `COINBASE` / `PREVRANDAO`, and `BLOCKHASH(K)` returns zero while `BLOCKHASH(K-1)` returns the real hash.
- **Window edges:** `head - N` served, `head - N - 1` refused with the new message; after mining one more block, the edge moves by one.
- **Off by default:** a node with neither `stateHistory` nor `computeStateRoot` gives today's refusals, and its open record and history stay empty after mining (a direct probe, so "pays nothing" is asserted rather than assumed). A `computeStateRoot`-only node keeps an open record but retains no `undo[]`.
- **The baselines:** with `initialBalances` / `initialState`, a read at block 0 after several blocks returns the genesis values (not empty); after a `loadState` of a dump with no history, a read at the loaded head (once more blocks are mined) returns the loaded values.
- **Persistence:** dump, load into a fresh node (and through the existing IndexedDB reload spec), identical historical answers; an old dump loads with history starting at its head; a larger window truncates on load.
- **Purity:** after a historical `eth_call`, the head's state is byte-identical (dump before and after), on both engines.
- The consumer case as its own test, in the shape bomber-world uses: read the block number, mine twice, `eth_getLogs` to that block and `readContract` at that block agree.

## Out of Scope

- Unbounded (archive) history. N is finite; a very large N is allowed but is the consumer's memory.
- `eth_getProof` and any historical state ROOT in `'none'` mode.
- `stateMode:'trie'` support: refused at construction until `trie-mode-derives-its-root-from-the-flat-state` lands, after which trie mode runs on the same flat state and this feature covers it with no further work.
- A pending-state view (`pending` stays the head, as documented).

## Further Notes

- Decisions taken with the user on 2026-09-27: build it; opt-in with a consumer-chosen window; history survives a reload. The dump change is additive (an optional field, `version` unchanged), so persisting it breaks no existing save.
- Depends on the uncommitted work of the same session (`requireHeadState`, `withStateOverrides`, the `block-pinned-state` and `rpc-params` specs). Task this after that lands.
- The open-record capture seam (the per-block change set) is also what `trie-mode-derives-its-root-from-the-flat-state` consumes to update its trie, which is why that spec is tasked after this one.
