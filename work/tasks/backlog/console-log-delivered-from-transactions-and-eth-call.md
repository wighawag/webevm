---
title: createNode({consoleLog}) delivers console calls from transactions and eth_call, to the host console and to onConsoleLog
slug: console-log-delivered-from-transactions-and-eth-call
spec: solidity-console-log
blockedBy: [the-engine-seam-records-calls-to-an-address, webevm-console-log-decodes-and-formats-console-calls]
covers: [1, 7, 8, 9, 10, 11, 14, 15, 16, 17, 18, 21]
---

## What to build

The end-to-end path on the main thread: `createNode({consoleLog: consoleLog()})` makes every console call made during a mined transaction or an `eth_call` reach the host console (or the consumer's `onLog`) and every `node.onConsoleLog(cb)` subscriber, as a structured entry, without changing anything about execution.

- **Option and construction.** `NodeOptions.consoleLog` takes the object `consoleLog()` returns (from `webevm/console-log`, by type only: the core graph imports none of the subpath's code). When it is set, `createNode` requires call recording from `connectEngine`, so an engine that does not declare the capability (today `webevm/revm`) is refused at construction, naming the engine and the capability.
- **Observation.** With it set, the node sets `recordCallsTo` to the console address `0x000000000000000000636F6e736F6c652e6c6f67` on every `eth_call` read and every transaction it mines, whichever path mines it (automine, `mine()`, `evm_mine`, interval mining). Not on `eth_estimateGas` or `eth_fillTransaction`: they print nothing (the opt-in is `console-log-from-the-first-estimation-on-request`). When recording was requested and the result has no `recordedCalls`, the request throws rather than deliver nothing. Without the option, nothing is requested and nothing changes.
- **Entries.** Each recorded call is decoded by the injected object into `{args, message}`; undecodable ones are skipped. The entry is `{args, message, source}`, `source` `'transaction'` or `'eth_call'`; a `'transaction'` entry also carries `txHash`, `blockNumber`, `blockHash` and `txIndex`.
- **Delivery timing.** After the engine returns, never from inside the EVM. A mined transaction's entries are buffered per block and delivered once the block is stored, in transaction order, before the `onNewHead` emit, so an entry never names a block a failed batch never stored. A read's entries are delivered before its result is returned or its revert error is thrown, so a reverting `eth_call` still delivers what it logged.
- **`onConsoleLog(cb) => unsubscribe`** is a new `SlimNode` member, shaped like `onNewHead`. The sink and the subscribers are called synchronously and never awaited; a throw or a rejected promise from any of them is caught and reported once through `console.error`, and execution continues. A callback may issue node requests, which queue behind the current one (ADR 0012). On a node created without `consoleLog`, `onConsoleLog` throws, naming the option.
- **Not chain state.** `dumpState` carries no log, and `loadState` or a persistence reload replays none.
- **Keeping `Required<SlimNode>` compiling.** The worker host's node proxy forwards `onConsoleLog` as it does `onNewHead`. A worker node cannot enable console logging until `console-log-in-a-worker`, so the CLIENT's member throws the not-enabled error synchronously WITHOUT calling the remote (the client's `onNewHead` fires and forgets a remote call, `worker-client.ts`, so a forwarded throw would surface as an unhandled rejection, not a throw); `console-log-in-a-worker` replaces it. If `packages/devnode` exists when you build this, its `wrapDevNode` gains the delegating member in the same change (a missing member is a compile error there); `devnode-forwards-on-console-log` adds its tests.

## Acceptance criteria

- [ ] A fixture contract (committed precompiled) that logs in its constructor, in a transaction, in a view, inside a sub-call that reverts, and in a transaction that reverts as a whole: a subscriber receives each entry with the decoded values, the formatted message and the right `source`, and `'transaction'` entries carry the hash, block number, block hash and index of the transaction that logged; the same holds in manual mining with `mine()` and `evm_mine`, with interval mining (entries carry `source: 'transaction'`), and with several logging transactions in one block, in order.
- [ ] The default sink prints each message once, prefixed, through `console.log`; a custom `onLog` replaces it; `onConsoleLog` subscribers receive entries whatever the sink, and unsubscribe stops them.
- [ ] Gas and outcome identity: the same transactions with console logging on and off give identical receipts, gas, return data and state root (with `computeStateRoot: true`); `eth_estimateGas` returns the same number on and off, and delivers nothing.
- [ ] A throwing sink, a throwing subscriber and a rejecting subscriber each leave the transaction and the read unaffected and are reported once through `console.error`; malformed console calldata (a fixture calling the console address with an unknown selector and a truncated payload) delivers nothing and fails nothing.
- [ ] Re-entrancy: an `onConsoleLog` callback that issues a node request resolves after the request that logged, added to `test/helpers/concurrency.ts` in the style of its `onNewHead` case (ADR 0012).
- [ ] `onConsoleLog` on a `createWorkerNode()` node throws synchronously, naming the option (until `console-log-in-a-worker`).
- [ ] `dispose()` drops `onConsoleLog` subscribers, as it drops `onNewHead`'s.
- [ ] `onConsoleLog` on a node without `consoleLog` throws naming the option; a node without it behaves exactly as before (the existing suite passes untouched).
- [ ] `createNode({engine: <webevm/revm>, consoleLog})` rejects at construction naming the engine id and the missing capability, and quoting the engine's own reason (its outcome format and the one needed); an engine stub that declares the capability but omits `recordedCalls` makes the request throw.
- [ ] A dumped and reloaded chain delivers no entry on `loadState` or reload.
- [ ] The default-entry baseline in `packages/benchmarks/test/evm.spec.ts` is re-pinned with the measured delta if the seam plumbing and `onConsoleLog` moved it, and the subpath stays out of the default entry.
- [ ] README (a console.log section, including that `webevm/revm` is refused until webevm moves to revm-wasm 0.6.0, outcome format 5, in `console-log-on-the-revm-engine`) and CONTEXT.md describe the option, the entry and the delivery rules; a changeset (minor).

## Blocked by

- `the-engine-seam-records-calls-to-an-address`
- `webevm-console-log-decodes-and-formats-console-calls`

## Prompt

You are working in webevm (`packages/webevm`), mainly `src/node.ts` (the read path `evmCall` / `eth_call`, the mining loop and the `onNewHead` emit, `createNode`'s `connectEngine` call) and `src/types.ts` (`NodeOptions`, `SlimNode`). Read `docs/adr/0018-console-log-is-observed-never-answered.md` first: it is the design this task builds (entry shape, delivery timing, never-awaited callbacks, the declared capability). Then the done records of `the-engine-seam-records-calls-to-an-address` (the seam's `recordCallsTo` / `recordedCalls` and `connectEngine`'s requirement) and `webevm-console-log-decodes-and-formats-console-calls` (the object `consoleLog()` returns and its decode and sink), `docs/adr/0012-one-request-at-a-time-the-node-serialises-its-whole-public-surface.md` (why callbacks are not awaited and how re-entrant requests queue), and how `onNewHead` is implemented, emitted and forwarded in `src/node.ts`, `src/worker-host.ts` and `src/worker-client.ts`.

Test through the public surface, like the existing Playwright specs: deploy the fixture with viem, subscribe, send, read; `test/helpers/concurrency.ts` and `test/helpers/engine-seam.ts` hold the shapes for the re-entrancy case and the stub engine.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
