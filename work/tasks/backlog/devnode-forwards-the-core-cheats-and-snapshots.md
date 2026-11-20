---
title: @webevm/devnode: the core's cheat aliases and snapshots reach the node through the dev node
slug: devnode-forwards-the-core-cheats-and-snapshots
spec: dev-node-package
blockedBy: [devnode-package-dev-accounts-funded-at-genesis, hardhat-and-anvil-names-for-the-state-cheats, snapshots-in-the-core]
covers: [13, 14, 15, 16]
---

## What to build

Nothing new in behaviour: prove that what rocketh and test suites call beyond accounts reaches the node through the dev node untouched, now that the core serves them. `hardhat_setBalance` / `anvil_setBalance` (rocketh's `fundImpersonatedAccounts` lends and takes back ETH with it), `hardhat_setCode` / `setNonce` / `setStorageAt` and their `anvil_` names, `evm_mine` and `anvil_mine` / `hardhat_mine` (rocketh's `autoMine`), and `evm_snapshot` / `evm_revert` (a revert also restoring what the dev node reads, e.g. a dev account's pending nonce for its next send).

## Acceptance criteria

- [ ] Each method above, sent through a dev node, has the effect it has on the bare node, asserted through the dev node's own reads.
- [ ] A snapshot taken before a dev-account send and reverted after it lets the same account send again at the earlier nonce.
- [ ] Kept in its own small test file, so nothing else in the package waits on the core tasks.

## Blocked by

- `devnode-package-dev-accounts-funded-at-genesis`
- `hardhat-and-anvil-names-for-the-state-cheats`
- `snapshots-in-the-core`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`). The core tasks `hardhat-and-anvil-names-for-the-state-cheats` and `snapshots-in-the-core` define these methods in `packages/webevm`; read their done records for the exact wire shapes. Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md` (why aliases and snapshots are the core's, and the layer only forwards them).

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
