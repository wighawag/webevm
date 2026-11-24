---
title: The engine seam records calls to an address, declared by the engine and enforced by connectEngine
slug: the-engine-seam-records-calls-to-an-address
spec: solidity-console-log
blockedBy: []
covers: []
---

## What to build

The engine-seam half of console logging, with the default `@ethereumjs/evm` engine implementing it, so that a later task can switch it on from `createNode` (`console-log-delivered-from-transactions-and-eth-call`). Nothing user-visible changes yet, and a node behaves exactly as before.

- **The request opt-in.** `ReadCallRequest` and `TransactionRequest` gain an optional `recordCallsTo` (an `Address`, like the requests' other addresses; named after revm-wasm's option, as the result field is named after its outcome field). When set, the engine records the input bytes of every call frame whose CODE ADDRESS is that address, in execution order, whatever the frame's outcome: CALL, STATICCALL, DELEGATECALL and CALLCODE are recorded (and the request's own top-level call when its `to` is the address, as revm-wasm counts it), CREATE never is, and a frame refused before it runs (depth over 1024, a value the caller cannot afford) is not.
- **The observation field.** `ReadCallResult` and `TransactionResult` gain `recordedCalls?: readonly Uint8Array[]`, present exactly when the request set `recordCallsTo` (possibly empty), absent otherwise. Their type docs, which today say the result is what a receipt (or `eth_call`) needs and nothing else, are amended to name this as the ONE non-receipt observation field, and why (ADR 0018).
- **The declared capability.** `Engine` gains an optional readonly member by which an engine declares that it honours `recordCallsTo` (name it in its JSDoc at the choice site). `connectEngine` takes whether call recording is required and, when it is, refuses an engine that does not declare it, at construction, in the style of its existing refusals: naming the engine id, the missing capability, and that the node does not fall back. Without the requirement it checks nothing new.
- **The default engine** declares the capability and records through the EVM's `beforeMessage` event (`@ethereumjs/evm` 10.1.2 emits it for every frame, top-level and nested, with `message.codeAddress` and `message.data`, before the frame's checkpoint, so frames that later revert are seen; depth and balance refusals happen in `_baseCall` before it, so refused frames are not). The listener is attached only for the duration of a request that set `recordCallsTo` and removed in a `finally`, so a request without it pays nothing.
- **`webevm/revm` does not declare the capability** in this task (its revm-wasm has no outcome format 5 yet), so `connectEngine` requiring it refuses that engine. Lifting this is `console-log-on-the-revm-engine`.

## Acceptance criteria

- [ ] On the default engine, a read and a transaction with `recordCallsTo` set to a target address return `recordedCalls` holding the input of every CALL, STATICCALL, DELEGATECALL and CALLCODE frame into it, in execution order, including frames inside a sub-call that reverts, in a transaction that reverts as a whole, and the top-level call when `to` is the address; a CREATE is not recorded; a frame refused before it runs (unaffordable value, and depth over 1024 if a fixture can reach it cheaply) is not recorded.
- [ ] Without `recordCallsTo`, both results carry no `recordedCalls` field at all.
- [ ] With and without `recordCallsTo`, the same read and the same transaction give identical return data, gas, status, logs and post-state (gas identity, asserted).
- [ ] `connectEngine` with recording required refuses an engine that does not declare the capability (a stub engine, and `webevm/revm`), with a message naming the engine id and the capability; the default engine passes; without the requirement nothing new is checked (the existing engine-seam and engine-misuse specs pass untouched).
- [ ] The fixture contract is committed with its precompiled bytecode, as the existing fixtures are (no solc at test time).
- [ ] ADR 0006 gains a short amendment note at its head pointing to `docs/adr/0018-console-log-is-observed-never-answered.md` (the one non-receipt field and the declared capability); CONTEXT.md's engine seam entry mentions both.
- [ ] If the default-entry baseline in `packages/benchmarks/test/evm.spec.ts` trips, re-pin it in the same change with the measured delta; a changeset (minor: the `Engine` interface gains optional members).

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm (`packages/webevm`), on the engine seam: `Engine`, `ReadCallRequest`, `ReadCallResult`, `TransactionRequest`, `TransactionResult` in `src/types.ts`, and `createEthereumjsEngine` plus `connectEngine` in `src/engine.ts`. Read `docs/adr/0018-console-log-is-observed-never-answered.md` first (why the engine observes rather than answers, why the capability is declared and enforced, why `recordedCalls` is the one non-receipt field), then `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` and its amendments (the seam's shape and its refusal rule), and `test/helpers/engine-seam.ts`, `test/helpers/engine-misuse.ts` and `test/helpers/counter.ts` for the test shapes and the precompiled-fixture convention. The address the next task will pass is the console address `0x000000000000000000636F6e736F6c652e6c6f67`; a test may use it or any other address, since this layer records calls to whatever address it is given and decodes nothing.

Test at the seam: drive the default engine (and `connectEngine`) directly from the test helpers, which already import from `src/`. `createNode` does not set `recordCallsTo` until the next task.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
