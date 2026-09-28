---
title: Trie mode derives its state root from the flat state
slug: trie-mode-derives-its-root-from-the-flat-state
taskedAfter: [bounded-state-history]
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

## Problem Statement

`stateMode:'trie'` is not "the same node, plus a state root". It is a different state manager (`MerkleStateManager`) underneath the whole node, and that shows up as four separate gaps:

- **revm cannot run in it.** revm reads state synchronously, mid-opcode, inside wasm; `MerkleStateManager` has only async reads, with no synchronous view at any depth (ADR 0005). So `createNode({stateMode:'trie', engine: revm})` is refused, and the fast engine and a real state root are mutually exclusive.
- **Its dump loses storage.** `dumpState` in trie mode writes no contract storage at all (the trie exposes only hashed slot keys, and the EVM journals on an internal copy that bypasses interception), so trie mode cannot use persistence.
- **Its touched-account tracking is incomplete.** The dump walks a node-level `touchedAccounts` set filled from sender, recipient, created address and log emitters; an account changed by an internal call that emits no log is missed.
- **Behaviour differs by mode.** A contract created at an address that already holds storage fails with `CREATE_COLLISION` in trie mode (EIP-7610, because `MerkleStateManager`'s `storageRoot` is real) but clears the storage and proceeds in `'none'` mode (whose `storageRoot` never reflects storage). And and every future feature built on the flat state (notably `bounded-state-history`) has to either be built twice or refuse trie mode.

## Solution

One state representation for every node: the node's flat `OverlayStorageStateManager`. `stateMode` is REMOVED and replaced by `computeStateRoot: true`, which means "additionally maintain a Merkle-Patricia trie DERIVED from the flat state, and report its real root". After each block (and when `getStateRoot()` is asked with pending cheat writes), the node applies that block's change set, the set of accounts, code and slots it changed, to the trie and records the root in the block header. Execution never touches the trie, so it can be async without costing an opcode anything, and both engines run with it.

This does not give history. A trie yields a ROOT per block; reading old state through old roots means retaining every old trie node, which is the archive-node route. History is `bounded-state-history`'s undo log, which this spec composes with: both consume the same per-block change set, and once trie mode is on the flat state, history works in it with no further work.

## User Stories

1. As a consumer, I want `computeStateRoot: true` with the revm engine, so that I can have the fast engine and a real state root at once.
2. As a consumer, I want the per-block `stateRoot` and `getStateRoot()` to equal what `MerkleStateManager` produced for the same chain, so that conformance against real roots (the GeneralStateTests suite) keeps passing unchanged.
3. As a consumer, I want `getStateRoot()` after `evm_set*` cheats (with no block mined since) to reflect them, as it does today.
4. As a consumer, I want `dumpState` on a `computeStateRoot` node to include storage, so that such a node can use persistence like any other.
5. As a consumer, I want a dumped trie-mode chain to reload with the same roots, so that a reload does not change what the chain claims.
6. As a consumer, I want `'none'` mode to be unaffected in cost (no trie work at all), so that the default stays the fast path.
7. As a consumer, I want a `computeStateRoot` node's execution cost to be a plain node's cost plus a per-block root update proportional to what the block changed, so that computing roots no longer means a slower EVM.
8. As a consumer, I want every behavioural difference between the modes other than the root to be gone (or, for EIP-7610, decided and documented), so that switching modes cannot change what a contract does.
9. As a consumer of `bounded-state-history`, I want it to work with `computeStateRoot: true` once this lands, so that the two opt-ins compose.

## Where the detail went

The implementation and testing detail moved to the tasks `spike-revm-eip-7610-storage-collision`, `trie-derived-from-the-flat-state`, `eip-7610-spec-current-in-every-mode`, `rename-statemode-to-computestateroot` and `computestateroot-cost-benchmark` (tasked 2026-09-28). The decisions they carry: the flat state is authoritative for every node and the trie is derived from each block's change set (ADR written by `trie-derived-from-the-flat-state`); EIP-7610 is spec-current in every mode; `stateMode` is replaced by `computeStateRoot` with no compatibility alias.

## Out of Scope

- State history (that is `bounded-state-history`), historical roots beyond what block headers already carry, and retaining old trie nodes.
- `eth_getProof` (it becomes implementable at the head once the trie exists, but it is its own spec).
- `transactionsRoot` / `receiptsRoot` (still documented zero placeholders).

## Further Notes

- Decided with the user on 2026-09-27: do it, understanding that the trie gives roots and not history.
- ADR 0010 anticipated this route: "a state root computed OUTSIDE revm over the authoritative state stays reachable".
