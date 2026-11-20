---
title: @webevm/devnode: the package, its dev accounts, funded at genesis
slug: devnode-package-dev-accounts-funded-at-genesis
spec: dev-node-package
needsAnswers: true
blockedBy: []
covers: [1, 2, 20, 23, 24, 25, 26]
---

<!-- open-questions -->

## Open questions

1. **The package's license.** The repository and `webevm` are MIT; the maintainer's default for NEW projects is AGPL-3.0. A package inside this MIT monorepo is proposed to be MIT, to match. Confirm before publishing configuration is written.

<!-- /open-questions -->

## What to build

The new workspace package `@webevm/devnode` in `packages/devnode`, with the first vertical slice of it: `createDevNode(options)` and `wrapDevNode(node, options)`, dev accounts answering `eth_accounts`, funded at genesis, and every other method forwarded to the node untouched.

- **The package**: published config like `packages/webevm` (ESM, `dist`, types), `webevm` as a PEER dependency with a minimum version (the worker task raises it to the release with the worker-host factory), the direct dependencies listed in ADR 0017 (`@scure/bip39`, `@scure/bip32`, `@noble/curves`, `@noble/hashes`, `@ethereumjs/tx`, `@ethereumjs/util`, `@eip-1193/over-port`; `comlink` comes with the worker task), prettier and test setup in the repo's style (Playwright, Chromium and WebKit, through `playwright-browser-harness`), included in the root `format:check` / `build` / `test` and in `scripts/check-type-deps.mjs`'s scan.
- **Accounts**: built in, the well-known anvil / Hardhat test accounts (the standard test mnemonic, path `m/44'/60'/0'/0/i`), 10 by default as on anvil; configurable as a mnemonic (`mnemonic`, `count`, `path`, `initialIndex`) or a list of private keys. `eth_accounts` lists exactly these, in order, and never an impersonated address.
- **Funding at genesis**: `createDevNode({...nodeOptions, accounts, balance, fund, fundAccounts})` derives the accounts, merges `balance` (default 10,000 ETH) for each into `initialBalances` plus `fundAccounts` (a map of extra addresses to balances in wei, anvil's `--fund-accounts`), and creates the node with webevm's `createNode`; a caller's own `initialBalances` entry for the same address wins. A state restored by `loadState` or persistence keeps its own balances (webevm applies `initialBalances` to a new genesis only). `wrapDevNode` on an existing node funds nothing.
- **The decorator**: a `Required<SlimNode>` that overrides `request` (the methods above, everything else forwarded with its result or error unchanged), `serveOn` (serving its own `request`) and `dispose` (closing the ports it served, then delegating), and delegates every other member.

## Acceptance criteria

- [ ] With no options, `eth_accounts` returns anvil's ten default addresses, each holding 10,000 ETH at block 0 (read with `eth_getBalance` at `0x0`).
- [ ] A mnemonic and a private-key list yield the addresses the standard path derives (checked against published vectors) and theirs; `count`, `path` and `initialIndex` are honoured.
- [ ] `balance`, `fundAccounts` and `fund: false` work, and `devAccountBalances(options)` returns the `initialBalances` the same options would fund (for a node created elsewhere); a dump of a funded chain loaded into a new `createDevNode` keeps the dump's balances.
- [ ] Every method the layer does not implement reaches the node unchanged, including the node's own `-32601` (asserted for a sample: an `eth_call`, a cheat, an unknown method).
- [ ] A port served by the layer answers `eth_accounts`, and stops answering after `dispose()`.
- [ ] It runs in Chromium and WebKit on both engines (default and `webevm/revm`).
- [ ] The package README describes it, and the root README (which is also `webevm`'s npm README) gains a short pointer to the package; a changeset for the new package.

## Blocked by

- None. Can start immediately.

## Prompt

You are creating `@webevm/devnode`, a package in the webevm monorepo layered on `webevm` (`packages/webevm`, an execution-only EIP-1193 node). Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md` first: it is the design this task builds. Then read `packages/webevm/src/types.ts` (`SlimNode`, `NodeOptions.initialBalances`), `packages/webevm/src/worker-host.ts` (the `Required<SlimNode>` proxy pattern to mirror for the decorator), `packages/webevm/package.json`, `packages/webevm/playwright.config.ts` and `packages/webevm/test/helpers/cut.ts` (the test harness to copy), `serveProvider` from `@eip-1193/over-port` as `packages/webevm/src/node.ts` uses it (for the decorator's `serveOn`), and ADRs 0002 and 0004 (why this is not in the core).

Test through the public surface only: create a dev node, drive it with viem (a dev dependency), read results back over RPC.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
