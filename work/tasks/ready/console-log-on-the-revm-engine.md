---
title: Console logging on webevm/revm, on revm-wasm 0.6.0 (outcome format 5)
slug: console-log-on-the-revm-engine
spec: solidity-console-log
blockedBy: [console-log-delivered-from-transactions-and-eth-call, console-log-from-the-first-estimation-on-request, console-log-in-a-worker]
covers: []
---

## The external dependency (resolved 2026-11-24)

`revm-wasm@0.6.0` is PUBLISHED (npm, verified 2026-11-24; release PR wighawag/revm-wasm#9, revm-wasm ADR `docs/adr/0007-call-input-recorder.md`) and carries outcome format 5 with the approved shape, as reported by the revm-wasm session that built it:

- `evm.call` / `evm.transact` / `evm.create` take `recordCallsTo?: Address` (flag bit 9); the outcome carries `recordedCalls: Uint8Array[]`, present (possibly empty) exactly when requested.
- Matched on the CODE address in `FixedPrecompiles::run` (not an inspector): CALL, STATICCALL, DELEGATECALL and CALLCODE, plus the top-level frame; frames that revert and transactions that revert are included; works with commit and with `returnState: false`. A top-level call refused by validation reports an empty list.
- Gas and the full outcome are identical with the recorder on and off (revm-wasm `test/record-calls.test.ts`, 9 scenarios, including a cold first touch of the target and a recorded call inside a reverting sub-call); no measurable cost when off.
- `evm.outcomeFormatVersion` is 5; the loader throws if `recordCallsTo` is used on an artifact below 5. The connect-time gate is `outcomeFormatVersion >= 5`.

If the published package turns out to differ from this, route the task to needs-attention rather than building on it.

## What to build

Lift the refusal: `webevm/revm` supports console logging, so `createNode({engine: await createRevmEngine({wasm}), consoleLog: consoleLog()})` works and delivers the same entries as the default engine.

- Raise the `revm-wasm` dependency to `^0.6.0`.
- `createRevmEngine` declares the call-recording capability only when the loaded artifact's `outcomeFormatVersion` is 5 or higher, decided when the engine is built so that `connectEngine` checks it at construction, never at the first call; an older artifact (a consumer passing their own `wasm`) keeps being refused at construction through the engine-supplied unavailable reason the seam task added (`the-engine-seam-records-calls-to-an-address`), naming the outcome format it has and the one it needs.
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
- `console-log-in-a-worker` (acceptance criterion 3 needs `createConsoleLog`)
- External, MET: `revm-wasm@0.6.0`, outcome format 5, published 2026-11-24.

## Prompt

You are working in webevm (`packages/webevm`), on `src/revm.ts` (`createRevmEngine`, its `call` and `transact`) and the revm test variants (`test/revm-*.spec.ts`, `test/helpers/revm-*.ts`, `test/helpers/cut-revm.ts`). Read `docs/adr/0018-console-log-is-observed-never-answered.md` (the declared capability and why it is checked at connect), `docs/adr/0003-revm-wasm-is-the-engine-direction.md`, and the done records of `the-engine-seam-records-calls-to-an-address`, `console-log-delivered-from-transactions-and-eth-call`, `console-log-from-the-first-estimation-on-request` and `console-log-in-a-worker`. Read the revm-wasm release's own docs for `recordCallsTo` and `recordedCalls` (its README and `docs/outcome-format.md`); never modify the revm-wasm repository from this task.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency (raising `revm-wasm` to `^0.6.0` is part of this task). The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
