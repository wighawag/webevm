---
title: webevm/worker-host takes an optional node factory
slug: worker-host-takes-a-node-factory
spec: dev-node-package
blockedBy: []
covers: []
---

## What to build

`exposeNode({createEngine, createNode})` in `webevm/worker-host` (and `createNodeWorkerApi`, which it wraps) takes an optional `createNode` FACTORY: when given, the worker calls it with the main thread's options (the engine already merged in, exactly as today) instead of webevm's own `createNode`, and exposes the node it returns through the existing single `Required<SlimNode>` proxy. Without it, a worker behaves exactly as before. Typed `createNode?: (options: NodeOptions) => Promise<SlimNode>`.

Why: `@webevm/devnode` must fund its dev accounts at GENESIS (as anvil and Hardhat do) when it runs inside a worker, so it has to take part in creating the node, not wrap it afterwards; and it must not ship a second worker host, which would duplicate the one place the thread-crossing node proxy exists (`docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`).

A factory that is not a function is refused the way a bad `createEngine` already is: as a VALUE, with both signals (the worker console at once, and the main thread's `createWorkerNode()` rejecting with the same text), never a module-scope throw that would hang the main thread (CONTEXT.md, *worker host*). A factory that throws or rejects makes `createWorkerNode()` reject with its message.

## Acceptance criteria

- [ ] `exposeNode` and `createNodeWorkerApi` accept the optional `createNode` factory; without it nothing changes (the existing worker specs pass untouched).
- [ ] With it, the node the factory returns is what the main thread's `createWorkerNode()` drives, every `SlimNode` member included, asserted the way `test/helpers/worker-roundtrip.ts` asserts parity.
- [ ] The factory receives the main thread's options with the engine merged in when `createEngine` is set.
- [ ] A non-function factory and a rejecting factory both reject the main thread instead of hanging it, and the non-function case also logs in the worker.
- [ ] README's worker section and CONTEXT.md's *worker host* entry describe the option; a changeset (minor).

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm (`packages/webevm`). Add an optional `createNode` factory to `WorkerHostOptions` in `src/worker-host.ts`, used by `createNodeWorkerApi` in place of the direct `createNode` call. Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md` (why a factory, and why not a second worker host), CONTEXT.md's *worker host* entry (the single proxy, refusals as values, both signals), and `test/helpers/worker-roundtrip.ts`, `test/helpers/engine-misuse.ts` and `test/worker.spec.ts` for the test shapes to follow.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
