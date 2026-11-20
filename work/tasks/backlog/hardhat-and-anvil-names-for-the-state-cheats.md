---
title: Answer the state cheats under hardhat's and anvil's names too
slug: hardhat-and-anvil-names-for-the-state-cheats
blockedBy: []
covers: []
---

## What to build

webevm's state cheats are `evm_setBalance`, `evm_setNonce`, `evm_setCode` and `evm_setStorageAt`. Hardhat calls the same four `hardhat_setBalance` / `hardhat_setNonce` / `hardhat_setCode` / `hardhat_setStorageAt`, and anvil answers those and its own `anvil_*` names. Add both sets of aliases to the node's dispatcher, mapped onto the existing implementations, so that tooling written against Hardhat or anvil (and viem's test actions in `hardhat` and `anvil` mode) sets state on webevm unchanged.

Why the core and not a layer above it: ADR 0016 settled the principle when it put anvil's and hardhat's names for mining and time into the core. A cheat that is not account policy (ADR 0004) and fabricates nothing a client could mistake for a real node's answer belongs here, under the names the other dev nodes use, so a consumer of the core gets one dialect rather than half of one. ADR 0017 (`docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`) records the same answer, and that package depends on this task: rocketh's `fundImpersonatedAccounts` calls `hardhat_setBalance`.

Wire shapes are the ones the two nodes use: `[address, quantity]` for balance and nonce, `[address, code]` for code, `[address, slot, value]` for storage, where `value` is a 32-byte word. Verify each against Hardhat's and anvil's documentation before pinning it, including what each returns (Hardhat answers `true`; check what anvil answers and whether viem's test actions care), and how each treats a slot or value that is not 32 bytes. Where the two disagree, follow the precedent ADR 0016 set (anvil's behaviour, with any deliberate difference recorded).

## Acceptance criteria

- [ ] `hardhat_setBalance`, `hardhat_setNonce`, `hardhat_setCode`, `hardhat_setStorageAt` and the four `anvil_*` names answer, on both engines, with the same effect as the `evm_*` cheat they alias (including `getStateRoot()` and the next block's root under `computeStateRoot: true`, and the `stateHistory` change set).
- [ ] Return values and parameter validation are pinned per name against what Hardhat and anvil do, with the sources cited in the test or a code comment.
- [ ] viem's `createTestClient` in `hardhat` and `anvil` modes drives `setBalance`, `setNonce`, `setCode` and `setStorageAt` against the node unchanged, asserted in the test.
- [ ] Persistence saves after an aliased cheat exactly as it does after the `evm_*` one.
- [ ] README's RPC surface table and CONTEXT.md's *cheat method* entry name the aliases.
- [ ] A changeset (minor).

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm (`packages/webevm`), an execution-only in-browser EIP-1193 node with two engines (the default `@ethereumjs/evm` and revm through `webevm/revm`). Add Hardhat's and anvil's names for the four state cheats, mapped onto the existing `evm_setBalance` / `evm_setNonce` / `evm_setCode` / `evm_setStorageAt` cases in `request()` in `src/node.ts`. Read ADR 0016 (`docs/adr/0016-the-node-has-a-clock-and-time-cheats-move-it.md`), which put anvil's names for mining and time in the core and is the precedent this follows, and the README's RPC surface section.

FIRST, check this task against current reality: if the aliases already exist, or ADR 0016's principle has been reversed, route the task to needs-attention instead of building.

Verify the wire shapes and return values against Hardhat's and anvil's own documentation or source, cite what you used, and pin them in tests. Test through the node's public surface, on both engines (follow the shape of `test/helpers/block-clock.ts` and its two specs), including viem's test client in `hardhat` and `anvil` modes.

Record any non-obvious choice (a return value, a validation difference from either node) where a reviewer will find it: a code comment at the choice site, or a `## Decisions` block in the done record. Never write the em dash character. Bound shell commands with `timeout` and cap their output; never grep `node_modules`, `dist` or minified bundles. The verify gate is `pnpm format:check && pnpm build && pnpm test`.
