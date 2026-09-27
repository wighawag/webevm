---
'webevm': minor
---

A node can now SERVE its EIP-1193 `request` on a `MessagePort` it is handed: `node.serveOn(port)` on `SlimNode`, on a worker-hosted node (`createWorkerNode`, which transfers the port into the node's worker) and a main-thread node (`createNode`) alike. Whoever holds the other end of the channel uses it with `providerOverPort(port)` from `@eip-1193/over-port`, so a consumer in another worker (an indexer, say) talks to a worker-hosted node directly, with no page code relaying its requests. Errors keep their `code`, `message` and `data`. Each call serves one port and returns a handle whose `close()` stops it; `dispose()` stops them all. `@eip-1193/over-port` is a new direct dependency, and `ServedPort` is exported as a type.

It costs the default bundle 1.4 KB (424.8 -> 426.2 KB raw / 128.1 -> 128.6 KB gzip), re-pinned in `packages/benchmarks/test/evm.spec.ts` in this change: `serveOn` is on `SlimNode`, so the main-thread node carries `serveProvider` too, which is what keeps `createNode()` and `createWorkerNode()` interchangeable. Still zero bytes of `revm-wasm` in the core graph.

Measured while testing it: on WebKit, `MessagePort` traffic between two workers is carried through the main thread inside the engine, so a page that holds its thread busy stalls a worker-to-worker consumer until it yields (Chromium does not). No page code relays the requests on either engine; the README says so.
