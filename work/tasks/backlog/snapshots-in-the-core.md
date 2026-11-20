---
title: Snapshots in the core (evm_snapshot / evm_revert, and anvil's names)
slug: snapshots-in-the-core
blockedBy: [hardhat-and-anvil-names-for-the-state-cheats]
covers: []
---

## What to build

`evm_snapshot` returns an id for the chain as it stands; `evm_revert(id)` restores it (state, blocks, receipts, transactions, logs and the `stateHistory` window alike) and returns `true`, or `false` for an id it does not hold. Reverting consumes that snapshot and every snapshot taken after it, as Hardhat and anvil both do. anvil's `anvil_snapshot` / `anvil_revert` are aliases.

Why the core: by ADR 0016's principle (a cheat that is not account policy, under the names the other dev nodes use, belongs in the core), recorded in `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`. That package forwards these methods rather than implementing them, and so does any consumer of the core alone, which today has no way to roll a chain back between test cases.

The proposed first implementation holds a `dumpState()` per snapshot and reverts with `loadState()`: simple, correct by construction (both are the node's own, serialised entry points), and fine at dev-chain sizes. Its cost is O(state) per snapshot and is to be measured and stated; a cheaper mechanism (the `stateHistory` undo log, ADR 0013) is a later change if the measurement asks for one.

## Acceptance criteria

- [ ] `evm_snapshot`, `evm_revert`, `anvil_snapshot` and `anvil_revert` answer on both engines with Hardhat's and anvil's semantics: ids as they issue them (verify the id format each uses and pin it), revert returns `true` / `false`, and reverting consumes that snapshot and all later ones.
- [ ] A revert restores everything a consumer can read: balances, code, storage, block number and hashes, receipts, logs, `eth_getTransactionByHash`, and pinned reads in the `stateHistory` window.
- [ ] The node's clock state (ADR 0016) after a revert is decided and recorded: whether a pending next timestamp, the offset and the interval are restored or kept (Hardhat and anvil are the reference; cite what they do).
- [ ] Persistence after a revert saves the reverted chain.
- [ ] The cost of a snapshot and of a revert is measured at a few state sizes and stated in the README.
- [ ] viem's `createTestClient` `snapshot` / `revert` actions drive it unchanged.
- [ ] README's RPC surface table and a changeset (minor).

## Blocked by

- `hardhat-and-anvil-names-for-the-state-cheats`: no logical dependency, but both edit `request()` in `src/node.ts` and the README's RPC table, so they are serialised to avoid a merge conflict.

## Prompt

You are working in webevm (`packages/webevm`), an execution-only in-browser EIP-1193 node with two engines. Add snapshots to the node's dispatcher (`request()` in `src/node.ts`), inside the serialisation point every request already runs in (ADR 0012), built on the node's own `dumpState` / `loadState`. Read ADR 0016 (the precedent for anvil's names in the core), ADR 0013 (state history, which a revert must leave consistent) and ADR 0012.

FIRST, check this task against current reality: if snapshots already exist, or the decision to put them in the core has been reversed, route the task to needs-attention instead of building.

Verify Hardhat's and anvil's semantics (id format, return values, consumption of later snapshots, what happens to the clock) against their documentation or source and cite what you used. Test through the public surface on both engines, following `test/helpers/block-clock.ts` and its two specs, and include viem's test client.

Record non-obvious choices durably (a code comment, or a `## Decisions` block in the done record). Never write the em dash character. Bound shell commands with `timeout` and cap their output; never grep `node_modules`, `dist` or minified bundles. The verify gate is `pnpm format:check && pnpm build && pnpm test`.
