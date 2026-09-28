---
title: A worker-hosted node keeps the RPC error code and data across the thread boundary
slug: a-worker-node-keeps-the-rpc-error-code-and-data
blockedBy: []
covers: []
---

## What to build

A node created with `createWorkerNode` must reject with the SAME error a main-thread node (`createNode`) and a `serveOn` port reject with: same `code`, same `message`, same `data`. Today it does not. comlink's default `throw` transfer handler serialises a thrown `Error` as `{message, name, stack}` only, so every `RpcError` a worker-hosted node raises reaches the main thread with `code === undefined` and no `data`. That covers `-32000 historical state not available`, `-32000 header not found`, `-32601` method not found, `-32602` bad params, `3 execution reverted` (whose `data` is the revert payload a viem client decodes into a custom error), `-32004` from `getStateRoot()`, and the rest. Only the message survives. `serveOn` ports are not affected (`@eip-1193/over-port` carries `code`, `message` and `data`), so the two worker transports currently disagree with each other, and the README's claim that a worker node is interchangeable with a main-thread one does not hold for errors. A consumer that branches on `code` (viem does, for reverts) behaves differently in a Worker.

Found by `state-history-docs-and-worker`, whose transport test (`test/helpers/state-history-transports.ts`) had to compare worker refusals by message only and COUNTS the lost codes (`workerCodesLost`, 778 in one run) instead of asserting them.

Fix it at the worker seam (`src/worker-host.ts` / `src/worker-client.ts`), for every method of the proxied node that can throw an `RpcError`, not only `request`. Two shapes are plausible; choose one and record why:

- A comlink transfer handler that serialises `RpcError` with its `code` and `data` and rebuilds it on the other side. Beware that comlink's `transferHandlers` is a module-global map: replacing the built-in `throw` handler also changes error handling for any other comlink use in the consumer's app, which this package does not own.
- An envelope the worker host returns (`{ok}` or `{error: {code, message, data}}`) that the client unwraps and rethrows, which touches no global state.

Whichever is chosen, the main thread must receive a real `RpcError` (so `instanceof RpcError` and `name === 'RpcError'` hold, as on a main-thread node), and a plain non-RPC `Error` thrown in the worker must still arrive as an `Error` with its message, as today.

## Acceptance criteria

- [ ] For a representative set of failures (a reverted `eth_call` with revert data, a historical read beyond the `stateHistory` window, an unknown block hash, an unknown method, malformed params, `getStateRoot()` on a node without `computeStateRoot`), a `createWorkerNode` node rejects with the same `code`, `message` and `data` as a `createNode` node on the same chain, and the error is an `RpcError` instance on the main thread.
- [ ] The revert case carries its `data`, and viem's `readContract` against a worker-hosted node decodes a custom error exactly as it does against a main-thread node.
- [ ] `test/helpers/state-history-transports.ts` compares the worker leg by code AND message like the port legs, and `workerCodesLost` is removed (or asserted to be 0).
- [ ] A plain `Error` thrown in the worker (for example the misused-`createEngine` refusal) still reaches the caller with its message, and `test/worker.spec.ts` stays green.
- [ ] No module-global comlink state is changed, OR the task records (JSDoc at the choice site plus a decisions note) why changing it is safe for a consumer that also uses comlink.
- [ ] A `patch` changeset describing the fix.
- [ ] The full verify (`pnpm format:check && pnpm build && pnpm test`) is green on chromium and webkit.

## Blocked by

None: can start immediately.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code? If comlink or the worker seam already carries the code, or the transport test already asserts it, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`), an in-browser EIP-1193 Ethereum node. `RpcError` is in `src/types.ts`. A node runs in a Worker through `exposeNode` (`src/worker-host.ts`, which builds the comlink API) and `createWorkerNode` (`src/worker-client.ts`, which wraps it and returns the same `SlimNode` shape as `createNode`). `node.serveOn(port)` relays requests over a `MessagePort` through `@eip-1193/over-port`, which already keeps `code` and `data`: use it as the reference behaviour. Read comlink's `throwTransferHandler` in `node_modules/comlink/dist/esm/comlink.mjs` with a bounded read (it is a small file, but do not grep `node_modules` recursively). Test through the public surface with the harness pattern in `test/helpers/cut.ts` (see `test/worker.spec.ts`, `test/serve-on-port.spec.ts` and `test/state-history-transports.spec.ts`).

The gate's `pnpm test` includes `packages/benchmarks`, whose `bundle size per backend` test pins the default entry's size (`DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts`). If your change grows that bundle, re-pin it in the same change after `pnpm build`, with a history entry at the top of the RE-PINNED list. The worker client is its own entry, so it may not.

Command cost rules: put `timeout` in front of any shell command whose cost you have not reasoned about and cap output with `head`; never run an unbounded regex over `dist`, `node_modules`, `.git`, wasm or minified files. No em dash characters in anything you write. Markdown prose is one line per paragraph. Done means: the acceptance criteria pass, the full playwright suite is green on chromium and webkit, and prettier is clean.
