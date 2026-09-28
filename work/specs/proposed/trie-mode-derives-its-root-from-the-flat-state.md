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

## Implementation Decisions

- **`stateMode` is removed, with no compatibility alias** (decided 2026-09-27: the package has no users, and a breaking change is fine). The replacement is `computeStateRoot: boolean` on `NodeOptions`, default `false`; `stateRoot: true` was rejected because an option named `stateRoot` reads as "pass a root". Every occurrence goes, not only the option: `SlimNode.stateMode` becomes `SlimNode.computeStateRoot`; `EngineContext.stateMode` is removed from the engine seam (no engine needs it once revm serves both); `SerializedState.stateMode` is no longer written, and a dump that still carries it loads with the field ignored (`loadState` has never branched on it). `StateMode` the type is deleted. The error messages, the README's state-mode section, the ADRs' forward references and the code comments that say `stateMode:'none'` / `'trie'` are rewritten in the new terms. The changeset marks it breaking.
- **The flat state is authoritative for every node.** `MerkleStateManager` stops being a node state manager. The trie is maintained directly with `@ethereumjs/mpt`: an account trie keyed by `keccak(address)` plus one storage trie per account keyed by `keccak(slot)`, with each account's `storageRoot` set from its storage trie when the account is written into the account trie.
- **The input is the per-block change set** introduced by `bounded-state-history` (its open record names every key a block changed; the new values are read from the flat state). That spec maintains the open record whenever `stateHistory` OR `computeStateRoot` is set, so a `computeStateRoot` node without history still has it. This is why this spec is tasked after that one. Using the change set, not the node's `touchedAccounts`, removes the incomplete-tracking gap by construction.
- **When roots are computed:** at the end of each mined block, before the block is stored (its header carries the root, as today), and in `getStateRoot()` for writes pending since the head. Both already run inside the serialisation point.
- **EIP-7610 is spec-current in EVERY mode** (decided 2026-09-27). The flat state gets a synchronous "does this account hold storage" answer (the overlay manager can give it in O(1)), and the collision guard reads that instead of `storageRoot`, so creating a contract at an address that already holds storage fails with `CREATE_COLLISION` on both engines and in both modes. This CHANGES `'none'` mode, which today clears the storage and proceeds: a behaviour change for the changeset, and the README's state-mode asymmetry paragraph and the note in `state-manager.ts` are rewritten, not appended to. **RISK, to verify first:** it is NOT verified that `revm-wasm` implements the storage half of EIP-7610. If it checks only nonce and code, revm would clear and proceed while the default engine refuses, and the node cannot refuse on the engine's behalf because the collision can happen on an inner `CREATE`/`CREATE2` mid-execution. The first task measures it (a creation at an address holding storage, top-level and inner, on both engines). If revm lacks it, stop and bring it back: the options then are an upstream fix, or the store presenting such an account to revm in a way its nonce/code check already rejects, and either is a decision.
- **Dump/load:** a `computeStateRoot` node dumps and loads exactly like any other; on load the trie is rebuilt from the loaded flat state once (O(state), paid at load only). The trie itself is never serialised.
- **revm's construction-time refusal of trie mode is removed**; ADR 0005's "`stateMode:'trie'` is a no" section gets a superseding amendment, and a new ADR records "the trie is derived from the flat state, not a state manager".

## Testing Decisions

- **The roots are the bar.** The existing `statetest.spec.ts` (GeneralStateTests post-state roots) and the trie-backed `@ethereumjs/vm` conformance reference must pass unchanged with `computeStateRoot: true`, and additionally with revm installed.
- **A differential against `MerkleStateManager`:** the same chain (the post-state battery's shapes, cheats between blocks, cheats after the head) through the old `stateMode:'trie'` and `computeStateRoot: true` yields identical per-block roots. Keep the old path available to the test as the reference while the task lands, then retire it.
- **Persistence:** a trie-mode dump now includes storage, and a reload reproduces every root.
- **Cost:** a benchmark row for `computeStateRoot: true` against a plain node on the same transactions, to show the difference is the per-block root update only.

## Out of Scope

- State history (that is `bounded-state-history`), historical roots beyond what block headers already carry, and retaining old trie nodes.
- `eth_getProof` (it becomes implementable at the head once the trie exists, but it is its own spec).
- `transactionsRoot` / `receiptsRoot` (still documented zero placeholders).

## Further Notes

- Decided with the user on 2026-09-27: do it, understanding that the trie gives roots and not history.
- ADR 0010 anticipated this route: "a state root computed OUTSIDE revm over the authoritative state stays reachable".
