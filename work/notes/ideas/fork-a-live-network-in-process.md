---
title: Fork a live network in-process, fetching state from an upstream RPC on first read
date: 2026-11-20
---

A node today starts from its own genesis (`initialBalances`, `initialState`) or from a dump (`loadState`). The proposal is a node that starts from a LIVE network at a pinned block instead, the way `anvil --fork-url` and Hardhat's forking do: every account, code and storage slot the node has not seen yet is fetched from an upstream EIP-1193 provider the first time something reads it, and from then on the node owns it like any other state, so transactions mined on the fork never reach the upstream. Consumers asking for it: rocketh's in-process chain records fork runs as staying on anvil "for now" and forking inside webevm as a later spec (rocketh `work/specs/proposed/in-process-chain.md`, `work/notes/findings/in-process-chain-without-hardhat.md`), and it is what would let a deploy script be rehearsed against mainnet state with no node on a port and in a browser tab.

This note records what looks feasible, what does not, and what would have to be decided. It deliberately designs nothing past that.

## What looks feasible: the default engine

The default `@ethereumjs/evm` engine reads state through `StateManagerInterface`, whose `getAccount`, `getCode` and `getStorage` return promises. A miss in the node's flat state (`OverlayStorageStateManager`, `src/state-manager.ts`) could therefore await a fetch from the upstream at the pinned block and write the answer into the bottom of the state before returning it. `@ethereumjs/statemanager` already ships an `RPCStateManager` that fetches this way (`eth_getProof` for accounts and storage, `eth_getCode` for code; read in `@ethereumjs/statemanager` 10.1.2), which is evidence the shape works with this EVM, though the node cannot use it as is: every node runs on its own flat state (ADR 0014), and the dump, the change sets, the undo log and the revm store all read that state's maps directly.

The node's own non-EVM reads (`eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`, and the sender checks above the seam such as `refuseIfSenderCannotSend`) read the same state manager, so they would fetch through the same path.

## What does not: the revm engine

`webevm/revm` reads accounts, code, storage and block hashes through `revm-wasm`'s SYNCHRONOUS host callbacks, because an interpreter answers them mid-opcode and wasm has no suspension point to await at (ADR 0010; ADR 0005 for the reach-through into the state manager's stacks). It cannot wait for a fetch. Two directions, neither evaluated:

- **Prefetch.** Learn the keys a request will touch before running it (an upstream `eth_createAccessList`, or a tracer such as `debug_traceCall` with a prestate tracer where the upstream offers one), fetch them, then execute. Incomplete by nature: a key the upstream's answer missed reads as absent, i.e. zero.
- **Execute, collect misses, fetch, retry.** The store records every key it was asked for and did not hold, the engine runs as a simulation (`commit: false`), and if anything was missing the node fetches it and runs again, committing only on a run with no misses. Correct when it terminates, at the cost of extra executions on every cold request, and it needs a store that can tell "absent upstream" from "not fetched yet".
- **Or refuse revm on a forked node** at `connect`, the same way the engine refuses a hardfork it cannot cost (ADR 0008), and leave forking to the default engine.

## Chain id, blocks and block hashes

- **Chain id.** A fork of mainnet that reports `chainId: 1` accepts transactions signed for mainnet, which is the point for replaying a real user's flow and a hazard for anything that could submit them upstream. anvil keeps the upstream's id by default and lets it be overridden.
- **Pinning a block number.** Without a pin the fork follows whatever the upstream calls `latest` at each fetch, so two reads of one session can see two different chains. A pin makes runs reproducible and cacheable, but an upstream that is not an archive node serves state only for recent blocks (often 128), so an old pin fails part way through a session rather than at construction.
- **Block numbering and history before the fork.** The node's block store is dense from block 0 and every block in it is one the node built. A forked node starts at the pinned block N and mines N+1 onwards: what `eth_getBlockByNumber`, `eth_getLogs` and `eth_getTransactionReceipt` answer for blocks at or below N (proxy them upstream, or refuse them in the node's words) is open, as is what genesis means for such a node.
- **`BLOCKHASH`.** For the 256 blocks before the head it must return the upstream's hashes for blocks at or below N. The default engine reads block hashes through the node's mock blockchain, which is async; the revm engine reads them through the synchronous `EngineContext.getBlockHash`, so those up to 256 hashes would have to be fetched before the first execution (cheap: one `eth_getBlockByNumber` each, or fewer with batching).
- **EIP-2935's history contract** (Prague on) exists on mainnet with real storage. On a fork its storage would be fetched lazily like any other contract's, but the node runs no block-start system call (see `NodeOptions.hardfork`), so blocks mined on the fork are never written into it: the contract would answer for blocks up to N and go stale after.
- **The fork's hardfork** has to be the one the node runs (`NodeOptions.hardfork`), or every gas figure is computed under the wrong rules.

## What `dumpState` means for state that was never fetched

A dump today is the whole state. On a forked node it would be only the state fetched or written so far, plus whatever the node mined. Loading it into an ordinary node would give a node on which every account the session never touched reads as absent, silently, which is the worst failure available (a zero at identical gas, invisible to every gas or receipt comparison in this repo). So a forked dump has to say it is one (upstream identity, chain id, pinned block) and an ordinary node has to refuse it, or loading it has to make a forked node again. The same holds for the alloc export proposed for `vm.loadAllocs` in `work/specs/proposed/dev-node-package.md`: a partial alloc loaded into forge is only correct on top of a forge fork of the same block.

Related, and also undecided: fetched values are BASELINES, not changes, in the sense that genesis balances are (`changeSets?.takeChangeSet()` after genesis in `src/node.ts`). They must not enter a block's change set or the `stateHistory` undo log, or a historical read would "undo" a fetch into an absence. And `computeStateRoot: true` cannot produce a real root over state it has not fetched, so it is either refused on a forked node or rebased on the upstream's root and proofs.

## What would have to be decided

1. **Where it lives**: in the core (which today makes no network request and is transport-agnostic), behind an injected upstream object in the style of the injected engine (ADR 0006), or in a layer above it such as the proposed dev-node package.
2. **Which engines serve a forked node**: the default only, revm with prefetching, or revm with execute-and-retry.
3. **How state is fetched**: `eth_getProof` per account (one request, verifiable against the pinned state root) or the four plain reads, and how "absent upstream" is cached so it is never fetched twice.
4. **The pin**: required, defaulted to the upstream's head at construction, or optional; and what the node says when the upstream can no longer serve it.
5. **Chain id and blocks at or below the pin**: keep or override the id; proxy or refuse historical blocks, logs and receipts.
6. **`BLOCKHASH` and the history contract**: prefetch the last 256 hashes at construction; accept that EIP-2935's contract goes stale after the fork, or start writing it per block (which would be a change for every node, not only forked ones).
7. **Dumps, persistence and the alloc export**: what a forked dump records, what refuses it, and whether a persisted forked session reloads as a fork.
8. **Interaction with the existing features**: change sets and `stateHistory` (fetched values as baselines), `computeStateRoot` (refused or rebased), the serialisation point (a fetch is awaited while the one request queue is held, so a cold read delays every request behind it), and the `evm_set*` cheats (does a cheat on a never-fetched account fetch it first).
9. **Browser reach**: an upstream called from a tab needs CORS, and keys in an RPC URL end up in the page.
