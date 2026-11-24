---
title: Console logging in a Worker, enabled by exposeNode({createConsoleLog}) and delivered over comlink
slug: console-log-in-a-worker
spec: solidity-console-log
blockedBy: [console-log-delivered-from-transactions-and-eth-call, worker-host-takes-a-node-factory]
covers: [12, 20]
---

## What to build

A worker-hosted node with console logging, enabled inside the worker module and observed from the main thread.

- **The host option.** `exposeNode({createConsoleLog})` (and `createNodeWorkerApi`, which it wraps) takes an optional `createConsoleLog: () => <what consoleLog() returns>`, shaped like `createEngine`: called once per `createNode()` on the worker thread, its result merged into the main thread's options as `consoleLog`, exactly as the engine is merged. When `exposeNode` was also given a `createNode` factory (task `worker-host-takes-a-node-factory`), the factory receives the console-log option merged in, as it receives the engine. A `createConsoleLog` that is not a function (a built object, a promise) is refused the way a bad `createEngine` is: as a VALUE, with both signals (the worker console at once, and the main thread's `createWorkerNode()` rejecting with the same text), never a module-scope throw that would hang the main thread. One that throws makes `createWorkerNode()` reject with its message.
- **Sinks by thread.** The default sink prints in the worker's console; a custom `onLog` runs on the worker, the thread that built the node.
- **Main-thread subscribers.** `onConsoleLog(cb)` on the `createWorkerNode()` proxy subscribes across comlink exactly as `onNewHead` does (the callback crosses as a comlink proxy, the unsubscribe comes back as one). It throws synchronously, naming `createConsoleLog`, when the worker node was created without console logging. The client can only throw synchronously if it learns at creation whether the worker node has console logging, as it already reads `computeStateRoot`, `senderMode` and `engine` once; how the host reports that is this task's choice (prefer a value on the proxy over a new public `SlimNode` member, and ask before adding one), recorded at the choice site. This replaces the always-throwing member the previous task left on worker nodes.
- **The client refusal.** `WorkerNodeOptions.consoleLog` is typed `never`, and `createWorkerNode({consoleLog})` is refused at runtime with a message saying to enable it in the worker module through `exposeNode({createConsoleLog: () => consoleLog()})`, in the style of the `engine` refusal in the worker client, so a consumer never meets an opaque `DataCloneError`.

## Acceptance criteria

- [ ] A main-thread subscriber receives the entries of a transaction and an `eth_call` run on a worker node enabled with `createConsoleLog`, with the same fields as on the main thread, and unsubscribe stops them; asserted for the default engine (the revm worker case comes with `console-log-on-the-revm-engine`).
- [ ] The default sink's output appears in the worker's console; a custom `onLog` passed in the worker module receives the entries there.
- [ ] `createWorkerNode({consoleLog: consoleLog()})` rejects with the message, before anything is cloned.
- [ ] A non-function `createConsoleLog` and a throwing one both reject the main thread's `createWorkerNode()` instead of hanging it, and the non-function case also logs in the worker (in the shape of `test/helpers/engine-misuse.ts` and `test/helpers/misused-engine-worker.ts`).
- [ ] With a `createNode` factory and `createConsoleLog` together, the factory receives `consoleLog` in its options.
- [ ] `onConsoleLog` on a worker node created without `createConsoleLog` throws synchronously, naming the option; worker nodes without it behave exactly as before (the existing worker specs pass untouched).
- [ ] README's worker section and CONTEXT.md's *worker host* entry describe the option; a changeset (minor).

## Blocked by

- `console-log-delivered-from-transactions-and-eth-call`
- `worker-host-takes-a-node-factory`: not a logical dependency (the spec says console logging in a worker does not need the factory), but both tasks change `WorkerHostOptions` and `createNodeWorkerApi` in the worker host, so they are serialized to avoid a merge conflict, and this order lets the factory-plus-console-log case be asserted rather than left conditional. If that task is cancelled, drop the blocker and the factory criterion.

## Prompt

You are working in webevm (`packages/webevm`): `src/worker-host.ts` (`WorkerHostOptions`, `createNodeWorkerApi`, the `Required<SlimNode>` node proxy, `engineSupplierRefusal`) and `src/worker-client.ts` (`WorkerNodeOptions`, the `engine` refusal, the `onNewHead` subscription). Read `docs/adr/0018-console-log-is-observed-never-answered.md` ("In a Worker, console logging is enabled in the worker module"), CONTEXT.md's *worker host* entry (the single proxy, refusals as values, both signals), `docs/spikes/a-bad-createengine-hangs-the-main-thread-instead-of-rejecting/decisions.md`, and the done records of `console-log-delivered-from-transactions-and-eth-call` (the entry and `onConsoleLog`) and `worker-host-takes-a-node-factory` (the factory). Test shapes: `test/worker.spec.ts`, `test/helpers/worker-roundtrip.ts`, `test/helpers/engine-misuse.ts`, `test/helpers/misused-engine-worker.ts`.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
