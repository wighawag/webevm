---
title: @webevm/devnode: export a dump as a genesis alloc for forge's vm.loadAllocs
slug: devnode-alloc-export-for-forge
spec: dev-node-package
blockedBy: [devnode-package-dev-accounts-funded-at-genesis]
covers: [18, 19]
---

## What to build

`toAllocs(state: SerializedState)`, a pure function exported by the package: the node's state as a genesis alloc map `{address: {nonce, balance, code, storage}}`, which forge's `vm.loadAllocs` accepts. Nonce and balance are decoded from each account's RLP (`dumpState().accounts` holds `[nonce, balance, storageRoot, codeHash]`) and written as hex quantities; code from `dumpState().code`; storage from `dumpState().storage`, keys already 32-byte `0x` hex, values PADDED to 32 bytes (the dump writes them in shortest form). Every account with code, balance, nonce or storage is present; the storage root and code hash are dropped (forge recomputes both). It works on any dump, a persisted one included, and on a chain whose transactions used fabricated signatures (the alloc carries state only).

Plus a short MANUAL script (not run in CI; forge is not installed there) that exports a deployment and runs a real `forge test` loading it, as rocketh did by hand with forge 1.7.1, to be run once and its result recorded in the done record.

## Acceptance criteria

- [ ] A unit test pins the shape against the case rocketh proved: a contract whose constructor stores a value, its nonce, balance, code and the slot, with 32-byte padded keys and values.
- [ ] The dev accounts' genesis balances appear in the export.
- [ ] The unit test runs in Node (the export is pure and is what a CLI such as rocketh calls) as well as in the browser harness.
- [ ] The manual forge script exists, is documented in the package README, and its run against forge is recorded in the done record.
- [ ] Changeset.

## Blocked by

- `devnode-package-dev-accounts-funded-at-genesis`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`). Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`, `SerializedState` in `packages/webevm/src/types.ts`, and `dumpState` in `packages/webevm/src/node.ts` (what each field holds). Decode accounts with `@ethereumjs/util`.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
