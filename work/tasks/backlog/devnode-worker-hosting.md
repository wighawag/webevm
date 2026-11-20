---
title: @webevm/devnode: on the main thread over a worker, and inside a worker
slug: devnode-worker-hosting
spec: dev-node-package
blockedBy: [worker-host-takes-a-node-factory, devnode-impersonation]
covers: [21, 22]
---

## What to build

Both worker shapes the maintainer asked for.

- **Keys on the main thread**: `wrapDevNode` over the proxy `createWorkerNode()` returns works (execution in the worker, keys and signing on the main thread); `devAccountBalances(options)` (from the package task) gives the funded `initialBalances` for an accounts configuration so the main thread can pass them to `createWorkerNode()`, and the package README shows the recipe.
- **Keys in the worker**: `@webevm/devnode/worker-host` exports `exposeDevNode({createEngine, accounts, balance, impersonation, ...})`, built on `webevm/worker-host`'s `createNode` factory (`options => createDevNode({...options, ...devConfig})`), so the worker's genesis is funded and the keys never reach the main thread, which uses webevm's own `createWorkerNode()` unchanged. `comlink` is an optional peer, as in webevm. A bad key, mnemonic or factory rejects the main thread's `createWorkerNode()` with its message instead of hanging it, and `exposeDevNode` never throws at module scope.

## Acceptance criteria

- [ ] Over a worker proxy on the main thread: `eth_accounts`, a funded send and a signature work, in Chromium and WebKit.
- [ ] Inside a worker via `exposeDevNode`: the same, every `SlimNode` member crosses the boundary, an `RpcError` the layer raises arrives whole, and no key or mnemonic appears in anything the main thread receives.
- [ ] A bad key or mnemonic in `exposeDevNode` rejects `createWorkerNode()` and logs in the worker.
- [ ] The package README documents both recipes, including that a main-thread layer over a worker proxy serves its ports from the main thread (giving up `serveOn`'s worker-to-worker path) while the in-worker one keeps it.
- [ ] The `webevm` peer-dependency minimum is raised to the release that ships `worker-host-takes-a-node-factory`: on an older `webevm` the `createNode` option would be IGNORED silently and the worker would run a plain node with no dev accounts.
- [ ] Changeset.

## Blocked by

- `worker-host-takes-a-node-factory`
- `devnode-impersonation`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`). Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`, CONTEXT.md's *worker host* entry, `packages/webevm/src/worker-host.ts` (and its `createNode` factory, from `worker-host-takes-a-node-factory`), `src/worker-client.ts`, and the worker test helpers in `packages/webevm/test/helpers/` (`worker-roundtrip.ts`, `engine-misuse.ts`, `revm-worker.ts`) whose shapes these tests follow.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
