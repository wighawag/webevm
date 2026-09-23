# One request at a time: the node serialises its whole public surface

`createNode()`'s dispatcher had no serialisation of any kind, and both halves of execution open checkpoint levels on the ONE state manager the node owns. Two overlapping executions therefore destroyed each other's writes, with success receipts on both. **Every public entry point on the returned node — `request`, `mine`, `dumpState`, `loadState`, `getStateRoot` — now queues onto a single promise chain, so this node runs exactly one piece of work at a time.**

## What was shared

A state manager is a STACK of checkpoint levels. `checkpoint()` pushes a level, a write lands in the TOP one, `commit()` merges the top level into the one below and pops it, `revert()` pops it and discards it. **Neither `commit` nor `revert` knows who opened the level it is acting on** — there is no handle, no owner, no identity — so the stack is only meaningful while a single execution owns it.

Both halves of the node open levels on that one stack, and each was individually right to:

- `engine.transact` is `runTx`, which checkpoints, executes and commits. That is what executing a transaction IS.
- the default engine's `engine.call` checkpoints and reverts in a `finally`. That is what makes an `eth_call` PURE, and it is a requirement of this EVM rather than a choice: `runCall` on a CREATE bumps the caller's nonce for address derivation and writes storage. ADR 0005 also measured the alternative — `SimpleStateManager.checkpointSync()` at 0.384 ms per call at 2002 accounts — and ADR 0009 replaced storage with overlays precisely so that a checkpoint copies nothing, so "copy state per call instead" was priced and rejected long before this.

Both are `async`, and `@ethereumjs/evm` yields to the microtask queue while it interprets. Nothing held a lock, so this interleaving was reachable — and a browser tab with pollers in it produced it constantly:

```
tx   checkpoint   [base, tx]
call checkpoint   [base, tx, call]   <- the read arrives mid-execution
tx   write        -> lands in the TOP level, which is the CALL's
tx   commit       -> merges that level down and pops it
call revert       -> pops the merged level: the transaction's write is GONE
```

Six lines reproduce it with no node at all:

```js
const sm = new SimpleStateManager();
await sm.putAccount(a, new Account(0n, 0n));
await sm.checkpoint();                        // the transaction
await sm.checkpoint();                        // an eth_call, inside it
await sm.putAccount(a, new Account(7n, 0n));  // the transaction writes
await sm.commit();                            // the transaction commits
await sm.revert();                            // the eth_call reverts
(await sm.getAccount(a)).nonce                // 0, and it should be 7
```

## What it did to a consumer, measured

Deterministic tick-offset scans through the node's own RPC surface, one fresh node per offset (`test/helpers/concurrency.ts`). Before the fix, with the default engine and ONE `eth_call` in flight:

| scan | before | after |
| --- | --- | --- |
| a read-only `eth_call` overlapping one increment | 23 of 32 offsets lost the write (window opens at tick 9 in node, 9 in chromium) | 0 |
| the same with a plain TRANSFER, no contract | 26 of 32 lost the sender's NONCE | 0 |
| state TORN at a message-frame boundary | 27 of 32; over a wider 0-60 sweep: 14 clean, 27 `outer=0 inner=1`, 20 `outer=1 inner=0` | 0 |
| the overlapping `eth_call` pointed at a contract that SSTOREs | 32 of 32 | 0 |
| TWO TRANSACTIONS, no read anywhere | 32 of 32 in node; 3 of 32 in chromium on revm | 0 |
| a non-executing `eth_getBalance` mid-transaction | 27 of 32 readings came from a block that did not exist | 0 |

Four things in that table are worth stating in words, because each one changes what a consumer can conclude from a receipt:

1. **The whole write is lost while the receipt says success.** With a plain transfer the casualty is the sender's NONCE, so every later transaction from that account is refused with `nonce too high` and — this node having no mempool — refused rather than queued. One interleaving stops the ACCOUNT, not one transaction.
2. **State TEARS.** A writes its own slot then CALLs B, which writes its own. The EVM checkpoints per MESSAGE FRAME, so the read's level can land between an inner frame's checkpoint and its commit: `outer=1 inner=0` is a state no execution of A could produce. So this is not "a transaction is atomic and sometimes lost", it is "a transaction's writes are cut at an arbitrary frame boundary".
3. **A READ CAN WRITE.** Point the concurrent `eth_call` at a contract that SSTOREs and the counter comes back at 2 after a single increment: the call's own write was committed rather than reverted, because the TRANSACTION's `commit()` popped the call's level into the committed one.
4. **IT IS NOT ABOUT READS.** Two overlapping transactions from two senders lose a write the same way, both reporting success and both holding a receipt — and they were handed the same block number too, each reading `latestNumber + 1` before the other had stored a block.

What is NOT a factor, so nobody re-derives it: volume (60 transactions from one sender and 40 across eight, strictly sequential, lose nothing), caching (a lost nonce cannot be cached, storage read live afterwards shows the old value, and a LATER transaction executes against the pre-transaction state), and pure state reads taken alone.

## The decision, and where the seam is

**The serialisation point is in `createNode`, not in an engine and not in a transport.**

- **Not in `engine.call`.** Write-versus-write interleaves too, so a lock around the read path is half a fix. `test/revm-concurrency.spec.ts` is that half made visible: with the lock removed, the revm spec's read scans stay CLEAN (that engine's `call` is structurally incapable of committing, so it opens no level) while write-versus-write fails at offsets 0-2 and the twelve-requests-at-once check dies on a nonce it lost. Both engines read and write the node's state through the same stacks (ADR 0005, ADR 0010), so the fix has to sit above both.
- **Not in a transport.** `src/worker-host.ts` forwards straight to `node.request` and comlink delivers concurrently, so a lock in the Worker pair would protect only consumers who use the Worker pair.
- **Per NODE, which is per STATE MANAGER by construction.** `createNode` builds its own state manager and takes no option to supply one, and an injected engine binds to the first node it is given to and refuses a second (`createRevmEngine`). One node, one state manager, one engine, one lock. There is no configuration in which a second node could share the state this lock protects, so "per state manager" would be the same lock with a longer explanation.

## Why EVERY request, and not only the ones that execute

This was the real question, because the obvious worry is a cheap read queued behind a slow `eth_estimateGas` search in a game loop, which is this package's main use. It was **measured rather than assumed**, and the measurement went the other way:

A read that never touches the EVM never checkpoints, so it can never corrupt anything — but it walks the live stack INCLUDING uncommitted levels. With a single transfer in flight, `eth_getBalance` reported the sender DEBITED from tick 5 and `eth_getTransactionCount` reported the nonce ADVANCED from tick 6, while `eth_blockNumber` still said `0x0`: 27 of 32 offsets. That reading is not merely early: it is a state that may never exist, because an overlapping `eth_call` could then revert it away — which is failure mode 1 above. The node's own block and receipt maps have the same shape (`receipts.set` runs per transaction INSIDE the mining loop, before the block is stored), so a mid-execution `eth_getTransactionReceipt` could name a `blockHash` that no lookup yet resolves.

A per-method exemption list was therefore rejected. Not because every method is equally dangerous, but because such a list is a promise that has to be re-proven every time a method is added, by somebody who will not know that is what they are doing. One rule — a request is served against a settled state — is checkable by reading the node's public surface, and it is also what a real node's semantics already are.

## What it costs

**A cheap read issued during a long execution now waits for it.** Measured with a `keccakLoop(4000)` estimate, which runs the full binary search: `eth_estimateGas` takes 209 ms, and a concurrent `eth_getBalance` used to answer in 0.1 ms and now answers in 208 ms. Five such reads issued during one estimate all land at ~209 ms.

That is the honest number, and two things bound what it means. First, the thread is saturated either way: the estimate's `await`s yield to the MICROTASK queue, not the task queue, so a main-thread consumer never got a rendered frame out of the early answer — only an answer that might be wrong. Second, in the arrangement this package recommends (the node in a Worker), the main thread is free regardless and what is delayed is the freshness of a poll, which is exactly the trade any node with block-atomic reads makes. The pathological case is `eth_estimateGas`, which re-executes up to `MAX_ESTIMATE_PROBES` times; a game loop that polls every frame should not be estimating every frame.

`eth_sendRawTransactionSync` keeps awaiting mining INSIDE the call and therefore holds the lock across submit AND mine. Releasing between the two was rejected: the receipt it returns must be the one from the block it mined, and a window there is the same window this ADR closes.

## Consequences

- **A `persistence.save()` hook may not call back into the node. That is a RULE, not a check, and the attempt to make it a check was removed.** The hook is awaited inside the request so that the dump it is handed is a snapshot of a settled state and so that the request does not resolve before the write is durable (`test/persistence-reload.spec.ts` reloads the page on the strength of that). A hook that AWAITS a call back into the node therefore waits for itself forever. Since a hang is the least legible failure available, the obvious move is to detect it — raise a flag around the awaited hook and refuse requests while it is set — and that was built, and it does not work. The flag is necessarily held across the hook's I/O, the `await` yields the event loop for that entire window, and JavaScript offers no way (there is no `AsyncLocalStorage` in a browser) to tell a request issued from the hook's own stack from one issued by anyone else. Measured on a 20 ms save: an ordinary `setInterval` poller that had never heard of persistence collected four rejections, each confidently telling it that IT had deadlocked the node. **A false refusal with a wrong diagnosis is worse than the hang it replaces**, and it fires for every consumer who has persistence and a poller, which is this package's main use. So the rule is documented where an adapter is actually written (`PersistenceAdapter.save`) and everyone else queues, which `test/concurrency.spec.ts` asserts from the poller's side.

  The alternative worth revisiting is moving the hook's I/O onto its OWN queue: take the dump inside the chain, hand it to a second promise chain, and let the request resolve. Saves stay ordered (dumps are enqueued in chain order) and the rule disappears entirely. What it gives up is that a request currently resolves only once its state is DURABLE, which is what makes the persistence-reload test able to reload the page immediately — so it needs an explicit flush before it can be taken, and it is a separate change rather than part of this fix.
- **An `onNewHead` subscriber MAY call back into the node.** The emit does not await its callbacks, so a request issued from one queues behind the transaction and runs when the chain drains — and it sees the block it was just told about. This is the game-loop pattern (refetch on new head). It is asserted as an ORDER (the callback's request must resolve after the transaction's own), because `latestNumber` is updated before the emit loop, so asserting the VALUE it reads would prove only that nothing deadlocked.
- **A failing request does not stop the queue.** The chain's tail only ever holds a FULFILLED promise, so one refused transaction cannot reject everything behind it and turn a bad nonce into a dead node.
- **Interval mining goes through the chain too, and COALESCES.** A timer is a concurrency source the consumer never sees; it used to fire in the middle of whatever `eth_call` was executing. Queueing it is necessary but not sufficient: `setInterval` keeps firing while the chain is busy, so a period below the work in flight (`intervalMs: 50` against the 209 ms estimate above) would stack a mine per tick and drain them afterwards as a burst of empty blocks, without bound if mining outran the period. At most one tick is ever waiting.
- **The timer is armed only once construction is finished.** The construction-time `loadState` that the `persistence` option performs is deliberately NOT serialised — nothing can reach the node yet, because it has not been returned — so a timer armed earlier was the one thing that could interleave with it.
- **`dispose()` is deliberately NOT serialised**, and does less than its name suggests. It stops the timer and drops subscribers, touches no state, and would be useless at the back of a queue it is meant to wind down. It does NOT cancel work already queued: that still runs to completion, including a `persistence.save()`. A caller that needs the node quiet stops issuing requests and awaits the ones it holds.
- **An injected engine is still handed the live state manager.** `connect(context)` passes it (ADR 0005/0010), and that object belongs to the consumer for the node's lifetime, so code that drives `engine.call` or `engine.transact` DIRECTLY bypasses the serialisation point exactly as the old dispatcher did. Nothing in this package does that; it is the one remaining door, and it is open by design, because reading the node's state through those stacks is what the engine seam is for.
- **Nothing inside the node may call a public wrapper.** The internal `request`, `mineBlock`, `dumpState`, `loadState` and `currentStateRoot` are called directly and only the returned object's members are wrapped, which is what makes one chain safe. This was verified rather than assumed: the only in-node call to `request` is `persistingRequest` reaching `baseRequest`.
- **No throughput was lost, because there never was any.** JavaScript runs one of these at a time regardless; what the dispatcher used to allow was not parallelism but interleaving, and interleaving is the defect.

## Removing this later

Do not, unless the state manager grows OWNED checkpoint levels (a `checkpoint()` returning a handle that `commit`/`revert` must be given) and both engines are migrated onto it. That is the only change that makes two concurrent executions meaningful here, and it is upstream's to make. In the meantime `test/concurrency.spec.ts` and `test/revm-concurrency.spec.ts` state the property through the node's public surface rather than through this mechanism, so they keep their meaning if the mechanism is ever replaced. Both were verified to FAIL with the serialisation point removed; a regression test for a race that has never been seen to fail is not a regression test. The harness's own anti-vacuity guards were verified the same way, by a second mutation: with `afterTicks` regressed to a no-op the sweep collapses into 32 repeats of offset 0, the overlap count still reads a healthy 32, and only the boundary probe notices.
