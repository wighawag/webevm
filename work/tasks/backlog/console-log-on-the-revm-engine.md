---
title: Console logging on webevm/revm, once a revm-wasm release carries outcome format 5
slug: console-log-on-the-revm-engine
spec: solidity-console-log
needsAnswers: true
blockedBy: [console-log-delivered-from-transactions-and-eth-call, console-log-from-the-first-estimation-on-request]
covers: []
---

<!-- open-questions -->

## Open questions

1. **Has revm-wasm published a release that carries outcome format 5 (`recordCallsTo` on the execute options, `recordedCalls` on the outcome)?** Which version? This task depends on an EXTERNAL release that `blockedBy` cannot express: the capability is work in progress in the `wighawag/revm-wasm` repository (session `revm-wasm/call-recorder`, started 2026-11-24; when this task was written it was committed on revm-wasm's local `main` as `23cb473` but not released, and the latest published `revm-wasm@0.5.0` has outcome format 4). Clear this flag only when the release exists, and write its version here.
2. **Did the released API keep the approved shape?** The design this task assumes: `recordCallsTo?: Address` on `ExecuteOptions` (flag bit 9), `recordedCalls?: Uint8Array[]` on the outcome, present only when requested, matched by code address in `FixedPrecompiles::run` (not an inspector), and `outcomeFormatVersion` on the instance; an older artifact refused at call time. If the release differs, amend this task before building.

<!-- /open-questions -->

## What to build

Lift the refusal: `webevm/revm` supports console logging, so `createNode({engine: await createRevmEngine({wasm}), consoleLog: consoleLog()})` works and delivers the same entries as the default engine.

- Raise the `revm-wasm` dependency to the release named in the open questions.
- `createRevmEngine` declares the call-recording capability only when the loaded artifact's `outcomeFormatVersion` is 5 or higher, decided when the engine is built so that `connectEngine` checks it at construction, never at the first call; an older artifact (a consumer passing their own `wasm`) keeps being refused at construction, naming the outcome format it has and the one it needs.
- `call` and `transact` pass the request's `recordCallsTo` through to revm-wasm and map its `recordedCalls` onto the result's `recordedCalls`, present exactly when requested.
- The same battery on both engines: the seam's recorded-call assertions, the console-log delivery specs, the estimation opt-in and the worker case run on revm too.

## Acceptance criteria

- [ ] An engine-parameterised test asserts the SAME recorded list on both engines for the same fixture, including a DELEGATECALL into the console address, frames in a reverting sub-call, a transaction that reverts as a whole, and a CREATE (not recorded).
- [ ] The console-log delivery, gas-identity and estimation specs pass on revm (revm variants beside the existing `revm-*.spec.ts` files, or parameterised); gas, receipts and state are identical with console logging on and off on revm.
- [ ] A worker node built with `createEngine: () => createRevmEngine({wasm})` and `createConsoleLog` delivers entries to a main-thread subscriber.
- [ ] An artifact with outcome format below 5 is refused at construction on a console-log-enabled node, naming both formats; the construction-time refusal test that `console-log-delivered-from-transactions-and-eth-call` wrote for revm is updated to that case.
- [ ] README's console.log section no longer says revm is refused; ADR 0018's last consequence gains a dated note that the dependency landed; a changeset (minor).

## Blocked by

- `console-log-delivered-from-transactions-and-eth-call`
- `console-log-from-the-first-estimation-on-request`
- External: a published revm-wasm release with outcome format 5 (see the open questions; not expressible as a `blockedBy`).

## Prompt

You are working in webevm (`packages/webevm`), on `src/revm.ts` (`createRevmEngine`, its `call` and `transact`) and the revm test variants (`test/revm-*.spec.ts`, `test/helpers/revm-*.ts`, `test/helpers/cut-revm.ts`). Read `docs/adr/0018-console-log-is-observed-never-answered.md` (the declared capability and why it is checked at connect), `docs/adr/0003-revm-wasm-is-the-engine-direction.md`, and the done records of `the-engine-seam-records-calls-to-an-address`, `console-log-delivered-from-transactions-and-eth-call`, `console-log-from-the-first-estimation-on-request` and, if it is done, `console-log-in-a-worker`. Read the revm-wasm release's own docs for `recordCallsTo` and `recordedCalls` (its README and `docs/outcome-format.md`); never modify the revm-wasm repository from this task.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency (raising `revm-wasm` to the release named in the open questions is part of this task). The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
