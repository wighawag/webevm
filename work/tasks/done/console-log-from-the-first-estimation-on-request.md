---
title: consoleLog({estimateGas: 'first'}) delivers the logs of an estimation's first execution only
slug: console-log-from-the-first-estimation-on-request
spec: solidity-console-log
blockedBy: [console-log-delivered-from-transactions-and-eth-call]
covers: [19]
---

## What to build

`eth_estimateGas` and `eth_fillTransaction` print nothing by default (already true once `console-log-delivered-from-transactions-and-eth-call` lands: the node does not ask for recording on them). This task adds the opt-in: `consoleLog({estimateGas: 'first'})` (the option is `estimateGas?: 'none' | 'first'`, default `'none'`; the name was left to tasking by the spec and is settled here) makes the node set `recordCallsTo` on the FIRST execution of the estimation search only, the top probe at the search's cap, and deliver its entries tagged `source: 'eth_estimateGas'`. `eth_fillTransaction`, which runs the same search, follows the same setting with `source: 'eth_fillTransaction'`. Never every execution: viem estimates before nearly every send and the search re-executes up to about twenty times.

Entries are delivered as a read's are: after the engine returns, before the answer is returned or the error is thrown, through the same sink and subscribers, never awaited. An estimation refused before any probe executes (the allowance cannot pay the intrinsic gas) delivers nothing, since nothing ran.

## Acceptance criteria

- [ ] With the default, `eth_estimateGas` and `eth_fillTransaction` on a logging call deliver nothing.
- [ ] With `estimateGas: 'first'`, each delivers exactly the entries of one execution (the top probe), with the right `source`, however many probes the search makes (asserted on a call whose search takes several probes).
- [ ] The estimate returned is the same with the option on and off.
- [ ] A reverting estimation with the option on delivers its first execution's entries before the error is thrown.
- [ ] README's console.log section and the option's JSDoc describe it; a changeset (minor).

## Blocked by

- `console-log-delivered-from-transactions-and-eth-call`

## Prompt

You are working in webevm (`packages/webevm`): `estimateGas` and the `eth_fillTransaction` case in `src/node.ts` (the search, its `probe` closure and the top `probe(cap)`), and the options type `consoleLog()` takes in the `webevm/console-log` subpath. Read `docs/adr/0018-console-log-is-observed-never-answered.md` ("Estimation prints nothing unless asked") and the done record of `console-log-delivered-from-transactions-and-eth-call` for how reads request recording and deliver entries; reuse that path rather than adding a second one. `test/helpers/estimate-gas.ts` has fixtures whose search takes more than one probe.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
