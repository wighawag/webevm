---
title: 'A worker node serves EIP-1193 on a port it is handed'
slug: a-worker-node-serves-eip-1193-on-a-handed-port
blockedBy: []
covers: []
---

## What to build

A node hosted in a Worker (`createWorkerNode({worker})`, `webevm/worker-client`) is reachable only through the page that created it: every other context that wants it as an EIP-1193 provider has to go through the page's comlink proxy. The concrete case is an indexer that itself runs in ANOTHER worker (`etherfold`'s browser indexer, whose worker host takes its provider as a `MessagePort`, `a-worker-host-takes-its-provider-and-settings-from-the-tab` in `wighawag/etherfold`): it should talk to the webevm worker directly, worker to worker, with the page relaying nothing.

So a worker-hosted node can SERVE its EIP-1193 `request` on a `MessagePort` it is handed, using `@eip-1193/over-port` (published, `^0.1.0`, MIT, made for this: `serveProvider(provider, port)` on the side that holds the provider, `providerOverPort(port)` on the side that uses it; errors keep `code`, `message`, `data` and `cause`). The page creates a `MessageChannel`, hands one end to the node through the worker client (transferred, never cloned), and gives the other end to whoever needs the provider. A main-thread node needs nothing new: `serveProvider(node, port)` already works on it, and the README should say so.

Shape it the way this package already does things: one call on the SlimNode surface the worker client returns (for example `serveOn(port)`), available the same on the main-thread node so the two stay interchangeable, typed on `SlimNode` so `worker-host.ts`'s `Required<SlimNode>` proxy keeps it complete. It can be called more than once (several consumers), and each served port can be stopped. `@eip-1193/over-port` should be a dependency only of the entry points that need it; record the choice.

## Acceptance criteria

- [ ] A worker-hosted node, handed one end of a `MessageChannel`, answers EIP-1193 requests made on the other end with `providerOverPort`, in a real Worker on Chromium and WebKit (the existing worker round-trip harness), with no request passing through the page after the hand-off.
- [ ] An error the node raises (for example an unsupported method's `-32601`) arrives with its code and message.
- [ ] The same call works on a main-thread node, so the two remain interchangeable.
- [ ] Two ports served at once both answer; a served port can be stopped.
- [ ] The README documents the worker-to-worker case with a short example; a changeset is added (0.x: minor).

## Blocked by

- None: can start immediately.

## Prompt

> Goal: a worker-hosted node serves EIP-1193 `request` on a handed `MessagePort` (see What to build). Look at `packages/webevm/src/worker-host.ts`, `worker-client.ts`, `types.ts` (`SlimNode`), the worker round-trip test helpers, and the `@eip-1193/over-port` README (`node_modules/@eip-1193/over-port/README.md` once installed; read only that file). Comlink transfers a `MessagePort` with `transfer(port, [port])`.
>
> FIRST, check this task against current reality: if a node can already serve itself on a port, route to needs-attention saying so.
>
> RECORD every non-obvious in-scope choice in a `## Decisions` block at the end of your final report; do not write the done record or commit message yourself. Never write an em dash character. Bound exploratory shell commands (`timeout`, `head`), and never grep `node_modules`, `dist` or minified bundles.
