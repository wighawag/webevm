---
'webevm': minor
---

**Fix state corruption between overlapping requests: a node now serves one request at a time.** A `minor` rather than a `patch` because the fix is a correctness one whose observable behaviour a consumer can depend on: a request issued while another is executing is now ANSWERED LATER (it used to be answered sooner, sometimes with state that no block contained), and a `persistence.save()` hook that called back into the node would now wait for itself — the same reasoning that made `0.4.0`'s `eth_estimateGas` change a minor.

`createNode()`'s dispatcher had no serialisation of any kind, while both halves of execution open checkpoint levels on the ONE state manager a node owns — `engine.transact` checkpoints, executes and commits, and the default engine's `eth_call` checkpoints and reverts to stay pure. `commit()` merges the top level downward and `revert()` discards it, and neither knows who opened the level it is acting on, so any two overlapping EVM executions destroyed each other's writes **while both reported success**. It needed no unusual usage: one transaction and one `eth_call` from a poller is enough, and a browser tab with a game loop in it produced it constantly.

Measured through the RPC surface: a transaction's write lost entirely (with a plain transfer it is the sender's NONCE, so every later transaction from that account is then refused as `nonce too high`); state TORN at a message-frame boundary, leaving a combination no execution of that transaction could produce; an `eth_call`'s OWN `SSTORE` committed rather than reverted; and — because this is not about reads — two overlapping transactions losing a write the same way and being handed the same block number.

`request`, `mine`, `dumpState`, `loadState` and `getStateRoot` now queue onto a single chain inside the node, so every request is answered against a settled state. The fix is in `createNode` rather than in an engine (write-versus-write interleaves too, and both engines read the node's state through the same stacks) or in a transport (`worker-host` forwards straight to `node.request` and comlink delivers concurrently).

What changes for a consumer:

- **Nothing you have to do.** No API change; the node just stops interleaving.
- **Latency, not throughput.** A cheap read issued while a long execution is in flight now waits for it (a concurrent `eth_getBalance` during a 209 ms `eth_estimateGas` search: 0.1 ms → 208 ms). It used to answer sooner and could answer with state no block contained. There was never any parallelism to lose — one thread runs one of these at a time regardless.
- **An `onNewHead` subscriber MAY call back into the node**; its request queues behind the block it was just told about.
- **A `persistence.save()` hook must not await a call back into the node.** The hook runs while the queue is held, so that the dump it receives is a real snapshot and so that your request does not resolve before the write is durable; a request awaited from inside it would wait for itself. This is the one new rule, it is documented on `PersistenceAdapter.save`, and it affects only that hook: a request issued from anywhere else while a save is in flight simply queues, as everything else does.
- **Interval mining coalesces.** `{type: 'interval'}` ticks that arrive while the node is busy no longer stack up; at most one is ever waiting, so a short interval behind a long execution stops producing a burst of empty blocks.

It costs the default bundle 0.1 KB (424.7 -> 424.8 KB raw; the gzip bound moves 128.4 -> 128.1), re-pinned in `packages/benchmarks/test/evm.spec.ts` in this change, with zero bytes of `revm-wasm` still in the core graph.

See `docs/adr/0012-one-request-at-a-time-the-node-serialises-its-whole-public-surface.md`; regression coverage in `packages/webevm/test/concurrency.spec.ts` and `test/revm-concurrency.spec.ts`, both verified to fail with the fix removed.
