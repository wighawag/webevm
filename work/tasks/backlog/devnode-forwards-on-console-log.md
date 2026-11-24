---
title: @webevm/devnode: onConsoleLog reaches the node through the dev node
slug: devnode-forwards-on-console-log
spec: solidity-console-log
blockedBy: [devnode-package-dev-accounts-funded-at-genesis, console-log-delivered-from-transactions-and-eth-call]
covers: [13]
---

## What to build

`wrapDevNode` (and so `createDevNode`) forwards `onConsoleLog` to the node it wraps, unchanged: a subscriber on the dev node receives the entries of the transactions and reads that go through it, including a dev account's `eth_sendTransaction`, and `createDevNode({...nodeOptions, consoleLog: consoleLog()})` passes the option to the node it creates. Whichever of the two blocking tasks landed second already had to add the delegating member, because `wrapDevNode` returns a `Required<SlimNode>` and a missing member is a compile error; this task proves the behaviour and documents it, and adds the member if it is somehow still missing.

## Acceptance criteria

- [ ] A subscriber on a dev node created with `consoleLog` receives the entries of a logging `eth_sendTransaction` from a dev account (with its transaction hash and block) and of a logging `eth_call`, as on the bare node.
- [ ] `onConsoleLog` on a dev node whose node has no console logging throws the node's own error, unchanged.
- [ ] Unsubscribing through the dev node stops delivery.
- [ ] Kept in its own small test file; the package README mentions that `onConsoleLog` and the `consoleLog` option pass through; a changeset for `@webevm/devnode` if its published surface or README changed.

## Blocked by

- `devnode-package-dev-accounts-funded-at-genesis`
- `console-log-delivered-from-transactions-and-eth-call`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`), the `SlimNode` decorator layered on webevm. Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md` (every member the layer does not override delegates) and `docs/adr/0018-console-log-is-observed-never-answered.md` (the entry shape and delivery), and the done record of `console-log-delivered-from-transactions-and-eth-call` for `onConsoleLog` and the `consoleLog` option. A logging fixture contract with precompiled bytecode exists in `packages/webevm/test/`; copy what you need rather than importing across packages' test trees if the package's test setup does not allow it.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
