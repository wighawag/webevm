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

## Where the detail went

The implementation and testing detail moved to the tasks `state-change-set-capture`, `state-history-point-reads`, `historical-eth-call`, `state-history-persistence` and `state-history-docs-and-worker` (tasked 2026-09-28); the durable rationale (undo log over the flat state, and the rejected alternatives) is recorded by the ADR `state-history-point-reads` writes.

## Out of Scope

- Unbounded (archive) history. N is finite; a very large N is allowed but is the consumer's memory.
- `eth_getProof` and any historical state ROOT in `'none'` mode.
- `stateMode:'trie'` support: refused at construction until `trie-mode-derives-its-root-from-the-flat-state` lands, after which trie mode runs on the same flat state and this feature covers it with no further work.
- A pending-state view (`pending` stays the head, as documented).

## Further Notes

- Decisions taken with the user on 2026-09-27: build it; opt-in with a consumer-chosen window; history survives a reload. The dump change is additive (an optional field, `version` unchanged), so persisting it breaks no existing save.
- Builds on `requireHeadState` and `withStateOverrides`, landed in 8c2cb50 with the `block-pinned-state` and `rpc-params` specs.
- The open-record capture seam (the per-block change set) is also what `trie-mode-derives-its-root-from-the-flat-state` consumes to update its trie, which is why that spec is tasked after this one.
