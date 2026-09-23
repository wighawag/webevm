# embedded-eth-node

## 0.6.0

### Minor Changes

- d6dbb96: **Fix state corruption between overlapping requests: a node now serves one request at a time.** A `minor` rather than a `patch` because the fix is a correctness one whose observable behaviour a consumer can depend on: a request issued while another is executing is now ANSWERED LATER (it used to be answered sooner, sometimes with state that no block contained), and a `persistence.save()` hook that called back into the node would now wait for itself — the same reasoning that made `0.4.0`'s `eth_estimateGas` change a minor.

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

## 0.5.0

### Minor Changes

- c391f68: Renamed the package from `embedded-eth-node` to `webevm`.

  This is a rename, not a rewrite: the api, the exports and the four subpaths are unchanged, so migrating is `npm i webevm`, removing `embedded-eth-node`, and rewriting the import specifier:

  ```diff
  -import {createNode} from 'embedded-eth-node';
  -import {createRevmEngine} from 'embedded-eth-node/revm';
  +import {createNode} from 'webevm';
  +import {createRevmEngine} from 'webevm/revm';
  ```

  `/revm`, `/worker-entry`, `/worker-host` and `/worker-client` move with it under the new name. `createNode()` and every other exported symbol keep their names.

  `embedded-eth-node` is deprecated on npm at 0.4.0 and receives no further releases. Why the name changed is `docs/adr/0011-the-package-is-named-webevm.md`.

## 0.4.0

### Minor Changes

- fe793e0: **`eth_estimateGas` now returns the smallest gas LIMIT at which a transaction succeeds, found by re-executing it, instead of the gas it CONSUMES.** The old answer (`executionGasUsed` + intrinsic gas + the request's access list) was exact and was the wrong question: a client turns this number into the transaction's gas limit, and under EIP-150's 63/64 rule a `CALL` or `CREATE` is forwarded at most 63/64 of the gas remaining at that point, so a limit equal to total consumption starves the sub-call by the 1/64 the outer frame keeps.

  **The failure it fixes, as reported.** Deploying through the standard Arachnid CREATE2 factory (`0x4e59b448...`) with a limit taken from this node's own `eth_estimateGas`: the funding transfer mined, the factory itself deployed (140 bytes of code), and the deployment THROUGH the factory came back `status: 0x0` with no contract created. The caller then pointed a proxy at the address that was never deployed, and every call to it returned `0x` rather than failing — so the receipt that named the problem was three transactions upstream of the symptom. The node's own suite had already recorded the same shape from the other side, in the comment on `test/helpers/post-state.ts` explaining why every transaction there carries an explicit gas limit.

  **What the method does now**, which is what geth has always done:
  - one run at the UPPER BOUND — the request's `gas` if it named one, capped at the block gas limit, since a limit above that is refused at submit and the node must never recommend a number it will not accept. If the request fails there it fails everywhere, and the method throws;
  - one probe at the MEASURED CONSUMPTION. A request that makes no sub-call and no create succeeds at exactly what it consumes, so a value transfer is still 21000, a plain deployment is still intrinsic + execution, and the common case costs ONE extra execution and stops;
  - otherwise a bounded search above it, bracketing from below at the scale of the 63/64 rule before bisecting, so a window that starts 30,000,000 gas wide is never walked down from the top. The answer is the MINIMUM: one gas less fails.

  **Where "the minimum" is exact, and the two places it is an over-estimate instead.** For a request carrying no access list the search is exact to the gas, which is what the battery asserts by mining at `estimate - 1` and requiring `status: 0x0`. Two cases sit deliberately above the true minimum, both erring in the safe direction (unused gas is not charged; an under-estimate is a transaction that runs out of gas): a request that names an EIP-2930 **access list**, because the charge is added while the probe underneath still prices those entries cold — the pre-existing skew documented on `accessListGas`, unchanged by this work — and a **gas-sensitive contract** that reads `GAS` and spends what it finds, which can exhaust the probe budget and get the smallest limit the search has proven to work.

  **The cost, measured at the seam.** A request that succeeds at what it consumes costs exactly TWO engine calls; a realistic single-level 63/64 shortfall (the 3,099 gas the CREATE2 case measures) costs 15. Both are pinned as assertions against stub engines rather than described, the second by reproducing the shortfall with arithmetic so the number is deterministic.

  **A request that cannot succeed at any limit gets an error, never a plausible-looking number — and the error says WHICH problem it is.** A REVERT keeps the leading clause `execution reverted` with the callee's bytes on `data` (that pair is what viem decodes), and the message now adds what only this method knows: that no gas limit would have helped, the revert reason decoded from `Error(string)` when there is one, and the engine's own words. A request that is simply too big for the allowance is `-32000` "gas required exceeds allowance" instead, geth's vocabulary and the same code this node already answers a transaction whose gas limit it refuses: nothing reverted, so a client reading a revert there would hunt for return data that does not exist, and a user would be told their contract failed when their gas allowance did. Both shapes of it are covered — an allowance below the intrinsic floor, where nothing executes, and one that starts the transaction and cannot finish it. The two are told apart STRUCTURALLY (did the request spend everything it was given and return nothing?), never by matching on an engine's words for running out of gas, which are not the same words on the two engines.

  **Identical on both engines**, asserted directly: same estimates (21000 / 266748 / 270826 for the three shapes above), same receipt, same `-32000` for an out-of-gas at the allowance and the same code-3-with-data for a revert, on `@ethereumjs/evm` and revm alike.

  **`eth_fillTransaction` fills its `gas` from the same search**, for the same reason: what it fills is a limit. It still deliberately does not charge the request's access list, because the transaction it returns carries none.

  **What did NOT change:** the intrinsic-gas arithmetic (base, calldata, the EIP-3860 initcode term) and the EIP-2930 access-list charge, which are now the FLOOR of the search rather than the answer; every estimate is still at least that, so the intrinsic-gas refusal still points callers here safely. Gas CONSUMED is still verified equal to the reference `runTx`'s `totalGasSpent` — the conformance battery's two estimate steps now assert that against the node's own receipt `gasUsed`, which is the value that has that property, and hold the estimate to being a usable limit.

  The default entry point's bundle baseline is re-pinned 422.5 -> 424.7 KB raw / 127.6 -> 128.4 KB gzip. (Published as 424.0 / 128.2 and corrected in the commit after this release: that pin had been measured against a `dist/` build predating this change's own review round, so CI — which builds first — read 0.7 KB more. The bundle test resolves the package through its `exports` map, i.e. `dist/`, never `src/`.) The 2.2 KB is the search itself, the `Error(string)` revert-reason decoder that puts the reason into the failure, and the prose of the two refusals this method can now throw. It is paid by every consumer including the JS-only one, and it is the feature: an estimate a transaction does not survive is what this change exists to remove.

  Covered by a new battery (`test/estimate-gas.spec.ts`) built on the real CREATE2 factory, deployed by its own keyless presigned transaction: the deployment through it mines at the estimate and fails one gas below, a transfer is 21000 and a deployment equals its own `gasUsed`, a revert produces an error carrying `Error("boom")`, and one estimate against a stub engine costs exactly two engine calls. The engine-seam battery's call count moves from 3 to 5 for the same reason.

- eb1d5e0: New subpath `embedded-eth-node/worker-host`: host a node in a Worker that builds its OWN engine, without hand-copying the `SlimNode` proxy. Additive: `embedded-eth-node/worker-entry` still exposes the node at import time, still exports `workerApi`, and nothing on the main thread changes.

  ```ts
  // my-worker.ts: the whole module
  import {exposeNode} from 'embedded-eth-node/worker-host';
  import {createRevmEngine} from 'embedded-eth-node/revm';
  import wasm from 'revm-wasm/revm.wasm';

  exposeNode({createEngine: () => createRevmEngine({wasm})});
  ```

  Why it exists: an engine cannot cross a thread boundary (`createWorkerNode({engine})` is refused, since the options are structured-cloned and an `Engine` is a function-bearing object holding thread-bound live state), and `worker-entry` deliberately builds no engine for you, because that would mean the core naming engines by string and importing them, which [ADR 0006](https://github.com/wighawag/embedded-eth-node/blob/main/docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md) refuses (a JS-only consumer would pay for revm). So a consumer had to write their own worker module, and `worker-entry` calls comlink's `expose()` at MODULE SCOPE, so it could not be imported to reuse the proxy: importing it would have exposed the wrong api on that thread. Everybody copied the proxy block instead. `worker-host` is `worker-entry` without the side effect, and `worker-entry` is now that module plus its one line.

  `createEngine` is a FACTORY, called once per `createNode()`, because building an engine is async and because one engine instance serves one node (`connect()` binds it, so an engine value would work for the first node and throw for the second). Passing a built engine there is refused with a message naming both forms. The main thread's options (`chainId`, `miningConfig`, and the rest) still travel through `createWorkerNode()` unchanged; only the engine is the worker's.

  The proxy now exists in exactly ONE place, and staying complete is the compiler's job rather than anyone's memory: it is a literal typed `SlimNode`, so a field added to `SlimNode` later fails the build there, and `worker-client`'s `as any` casts (which are what hid `senderMode` when it was silently dropped from that block for a month) are gone. The Worker test additionally compares a Worker-backed node against a main-thread one field by field, naming no field, so the same class of gap is caught at runtime for any future one too.

  The README's revm-in-a-Worker recipe is now shown INLINE (it is four lines), and its pointer at this repository's executed example says plainly that those are repository files rather than something in your `node_modules`. The published `files` list is unchanged.

  `src/index.ts` is untouched, so the default entry point's bundle is unmoved and the benchmark baseline is not re-pinned. Decisions taken while building this, including the naming and the two rejected alternatives: `docs/spikes/make-the-worker-node-proxy-reusable-instead-of-hand-copied/decisions.md`.

### Patch Changes

- ce91700: A misused `exposeNode({createEngine})` now REJECTS the main thread's `createWorkerNode()` instead of hanging it forever.

  The refusal added with `embedded-eth-node/worker-host` (passing an engine, or the promise of one, where the factory belongs) threw while the worker module was still EVALUATING. That is before comlink's `expose()` runs, so the worker registered no message listener, answered nothing, and an awaited `createWorkerNode()` on the main thread never settled: the consumer saw a hang and the explanation reached only the worker's console, which in a bundled app is easy to miss entirely. An infinite pending promise is a worse failure than the `DataCloneError` the sibling refusal exists to prevent, because it produces no error at all.

  The refusal is now a recorded VALUE rather than control flow. `exposeNode()` always calls `expose()`, so the worker can always answer; the message is still logged on the worker thread at the moment the mistake is made (the early signal a developer with the console open sees), and `createNode()` rejects with the same text, so it crosses the boundary to the caller. Neither thread is left guessing.

  The message also names the PROMISE case as itself: `createEngine: createRevmEngine({wasm})` (no arrow) is told that the factory was called rather than passed, and shown both forms, instead of being told that a value one arrow from correct "is not a function".

  Two documented hazards go with it, on the `exposeNode` doc comment and in the README's Worker section: do not `await` at the top level of a worker module before `exposeNode()` (the main thread's first message can be lost while your module is still evaluating, which hangs `createWorkerNode()` for a reason this package cannot fix), and `createEngine` is a function precisely so the await belongs to `createNode()`.

  Behaviour change for anyone already misusing the option: `createNodeWorkerApi()` / `exposeNode()` no longer throw synchronously, they return normally and the failure surfaces at `createNode()`. Asserted from the main thread in a browser on both engines (`test/worker.spec.ts`, `test/revm-worker.spec.ts`) so a regression back to the hang is caught as a `NEVER_SETTLED` outcome rather than an undiagnosed timeout. Reference gas is unchanged. Decisions: `docs/spikes/a-bad-createengine-hangs-the-main-thread-instead-of-rejecting/decisions.md`.

- d0bd3df: **Two RPC responses now have the SHAPE a caller reads, not merely the right values.** Both came out of a downstream debugging session where the symptom was the same unhelpful sentence, `Cannot mix BigInt and other types`, thrown far from the node that caused it. Neither changes a number; both change what a consumer's ordinary idiom does with the answer.

  **`eth_feeHistory` returns one `reward` entry per REQUESTED percentile, per block.** It ignored `rewardPercentiles` and always answered a single entry per block, so a caller asking for several and INDEXING them read `undefined` at every index but the first: rocketh requests `[10, 50, 80]` and reads indices 1 and 2. This node has a flat fee model, so every percentile carries the same value — but the shape has to match the request, and a response that is well-formed enough to parse while being wrong for anybody who indexes it is the hardest kind to trace back.

  **`eth_getTransactionByHash` OMITS `maxFeePerGas` / `maxPriorityFeePerGas` on a legacy transaction** instead of reporting them as `null`, which is what geth does. The difference is not cosmetic: `'maxFeePerGas' in tx` is the standard way to tell a 1559 transaction from a legacy one, so a key that EXISTS and is `null` routes the caller down the 1559 branch, which then dies on `BigInt(null)`. A key that exists only when it means something keeps that idiom honest. A type-2 transaction still carries both.

  Both are now asserted rather than described, and each assertion is the one a value check would miss. The fee-history widths are held for a 3-percentile request AND a 1-percentile one (`viem-surface`), so a hardcoded 3 fails as loudly as a hardcoded 1, and the values are deliberately not asserted because a flat fee model makes them all equal. The fee fields are read by PRESENCE with `in`, off the raw JSON-RPC object rather than through viem (which normalises the shape away), on BOTH transaction types from the same node (`slim-node-checks`), because omitting them always would satisfy the legacy half while breaking every 1559 consumer. Each assertion was confirmed RED against the previous behaviour.

- 5161f19: Documentation and a runnable example: the revm-in-a-Worker recipe the README recommends is now EXECUTED on every test run, on Chromium and WebKit. No library code changed, so `patch` is the honest level and nothing about the node's behaviour moved.

  `createWorkerNode({engine})` is refused (the options are structured-cloned and an `Engine` is a function-bearing object holding thread-bound live state), so the README told consumers to build the engine inside their own worker module and comlink-expose the node. Nothing in this repo did that, so the one combination a consumer most likely wants (revm AND off the main thread) was the only one recommended without evidence.

  There is now a copyable worker module, `packages/embedded-eth-node/test/helpers/revm-worker.ts`, which builds the revm engine INSIDE the Worker and imports `embedded-eth-node` / `embedded-eth-node/revm` by package name (so the published export map is exercised the way a consumer resolves it), and a spec that drives it through the ORDINARY `createWorkerNode()` client with unchanged main-thread code: the engine identity crossing the boundary reads `revm-wasm`, the reference execution gas measured THROUGH the Worker is exact (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 and its result hash), a deploy plus 20 committing transactions land and their post-state reads back through the node's own surface, the `stateMode:'trie'` refusal fires inside the Worker with its full text reaching the caller, and the main thread stays responsive throughout (a load-invariant ratio, never a millisecond bound).

  The integration risk that made this worth proving, whether the revm `.wasm` configuration reaches the WORKER bundle and not only the page, resolved positively: the harness builds both entry points in one esbuild pass, so one `binary` loader covers both. The generalisation for a consumer is that their bundler's asset rule has to apply to the worker entry too, which the README bullet now says, along with what each delivery shape costs inside a worker chunk. Findings, measurements and the decisions taken while building this: `docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/measurements.md`.

  `src/` is untouched, so the default entry point's bundle is unmoved and the benchmark baseline is not re-pinned.

## 0.3.0

### Minor Changes

- cf377cd: **The block gas limit is ENFORCED, on both engines, and `blockGasLimit` is what lifts it (behaviour change on the default engine).** A transaction whose gas limit exceeds the block's is now REFUSED. It used to be mined on the default `@ethereumjs/evm` engine, because the node passed `@ethereumjs/vm`'s `skipBlockGasLimitValidation` to `runTx`, and REJECTED on revm, which expresses the same relaxation as a simulation switch it refuses to combine with committing. Same node, same transaction, two answers depending on which EVM was installed. That flag is gone.

  If you want enormous gas limits, ask for them: `createNode({blockGasLimit: 100_000_000n})` (default still `30_000_000n`, so nothing changes for a node that never asked for more). The permissiveness stops being a hidden per-transaction exemption that one engine cannot honour and becomes a visible property of the block that BOTH honour by construction, because both are handed the same block. It is also more honest: the transaction is no longer accepted against a limit the block does not have, and `GASLIMIT` reports the configured number to a contract, as does `eth_getBlockByNumber`.

  **The refusal names what was exceeded and what raises it**, identically on every engine, because the NODE answers it at submit rather than each EVM at execution: the block is the node's half of the seam on any engine, and neither EVM's own words carry the numbers or know that `blockGasLimit` exists (`@ethereumjs/vm` says "tx has a higher gas limit than the block", revm says `Transaction(CallerGasLimitMoreThanBlock)`). It is an `RpcError` with code `-32000` (the range geth uses for a transaction its pool refuses), thrown by the `eth_sendRawTransaction*` call that submitted it, so an over-limit transaction never enters the pending queue and cannot take a later `mine()` batch down with it. Both engines still enforce the same rule underneath as the backstop.

  **The default read budget is deliberately NOT tied to `blockGasLimit`.** An `eth_call` that names no `gas` still gets a fixed 30,000,000, so raising the block gas limit does not silently buy every unbudgeted read a proportionally longer runaway before it halts (and the revm engine's Osaka refusal quotes that budget as a fixed number). Pass `gas` on the call when you want a bigger one. The reasoning is recorded at the code site in `src/node.ts`.

  This supersedes the "one asymmetry stated rather than worked around" note in the revm-transactions entry of this same release: the asymmetry is not shipped, it is removed.

  The default entry's bundle-size baseline is re-pinned 417.2 -> 417.8 KB raw / 125.7 -> 126.0 KB gzip. The 0.6 KB is the refusal's prose in the core bundle, paid by every consumer including the JS-only one, and it is the feature: an error that does not say which limit was exceeded or which knob raises it is the thing this change exists to remove.

  Covered by the differential conformance battery on BOTH engines and both state modes (`block gas limit refuses an over-limit tx; blockGasLimit lifts it`), asserting the NODE's own answer rather than the reference's, because that battery's reference `runTx` passes `skipBlockGasLimitValidation` itself and is therefore blind to exactly this bug. Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 085aa37: **BREAKING (no alias):** the engine seam now covers TRANSACTIONS as well as reads, so `ReadEngine` is `Engine` and `node.readEngine` is `node.engine`. No behaviour changes.

  The node had ONE seam for reads and a HARDCODED path for writes: an injected engine
  answered `eth_call`, while transactions bypassed it and went straight to
  `@ethereumjs/vm`'s `runTx`. The seam is now ONE interface with TWO operations —
  `call` (read-only) and `transact` (executes and commits) — the default
  `@ethereumjs/evm` engine implements both, and the node's mining path executes
  through the engine rather than calling `runTx` itself.

  Renamed on the public surface, with **no deprecation alias**, because a shim would
  have left two words for one concept from the day it landed:
  - `ReadEngine` → `Engine` (and it gained `transact`)
  - `ReadEngineContext` → `EngineContext`
  - `ReadEngineInfo` → `EngineInfo`
  - `SlimNode.readEngine` → `SlimNode.engine` (same `{id}` value, over comlink too)
  - `ReadCallRequest` / `ReadCallResult` keep their names: they are the READ
    operation's request and result, and that is still what they are.

  New, and the point of the change: `TransactionRequest` (the signed transaction the
  node parsed, plus the block it is mined in) and `TransactionResult` — what a
  RECEIPT needs from an EVM and nothing else: `status`, `gasUsed` (net of refunds),
  `effectiveGasPrice`, `logs` in emission order (`TransactionLog`: address, topics,
  data as raw bytes), `logsBloom`, and `createdAddress`. `runTx`'s `amountSpent`,
  `gasRefund`, `minerValue`, `accessList` and `execResult` are deliberately absent:
  no receipt reads them, and a field that exists only because one engine returns it
  is what makes two engines incomparable. `effectiveGasPrice` now comes from the
  engine that executed the transaction (the node's legacy-safe computation moved
  behind the default engine), so the fee arithmetic has one implementation per engine
  and none in the node.

  What did NOT move, on any engine: block construction, `cumulativeGasUsed`, receipt
  assembly, the RPC layer, transaction parsing and sender recovery are still the
  node's. `@ethereumjs/vm`'s `skipBlockGasLimitValidation` / `skipHardForkValidation`
  stayed INSIDE the default engine rather than becoming neutral request fields — they
  are one EVM's vocabulary, and `revm-wasm` refuses to combine its equivalent
  relaxation with committing, so a neutral field would have been a promise another
  engine could only throw at. The reasoning is at the code site in `src/engine.ts`.
  (Later in this same release, `skipBlockGasLimitValidation` was DROPPED rather than
  relocated. See the block-gas-limit entry: a relaxation only one engine could honour
  was the divergence, wherever it lived. `skipHardForkValidation` still lives there.)

  `transact` was OPTIONAL, transitionally: an engine that omitted it left transactions
  on the node's own `@ethereumjs/vm`, which is exactly what every non-default engine
  did before this change, and `createRevmEngine()` from `embedded-eth-node/revm` was
  in that state — it served the seam's read half only, so a node with it installed
  still mined on `@ethereumjs/vm` and a receipt could not be attributed to
  `node.engine.id`. **That state did not survive the release**: the sibling entry for
  `revm-executes-the-first-transaction-with-commit` makes `transact` REQUIRED, deletes
  that fallback and gives the revm engine its write half, so no published version ever
  shipped the optional marker (written in the past tense for that reason — the two
  entries land under one version heading). A `transact` that is present but is not a
  function is refused at construction, next to the existing engine refusals, because a
  half-built engine silently mining somewhere else is the same class of lie those
  refusals exist to prevent.

  No behaviour change anywhere: reference gas is identical (`number()` 2446,
  `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 →
  `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), and the
  differential conformance battery (both state modes, and again with the revm engine
  installed), the GeneralStateTests, trusted-sender, persistence, worker and
  viem-surface suites all pass unchanged. `test/engine-seam.spec.ts` gained the bar
  for the new half: an engine whose `transact` returns values no EVM would produce
  for a 21000-gas transfer, so the receipt proves the ENGINE executed the transaction
  rather than `runTx` having been called anyway. The default entry's bundle-size
  baseline is re-pinned 416.3 → 417.1 KB raw / 125.4 → 125.7 KB gzip (the result
  mapping plus one more refusal string; still zero bytes of `revm-wasm`).

  `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` carries a
  dated amendment: the injected-object decision is unchanged, its scope widened.

- 59f2df2: **A replayed or invalid transaction is REFUSED by the NODE, in one vocabulary, on every engine.** A transaction whose nonce the sender has already used, whose nonce this node will never reach, whose sender cannot cover `value + gasLimit * maxFeePerGas`, or whose gas limit is below its intrinsic gas is now refused above the engine seam, with an `RpcError` code `-32000` and no `data`, before any EVM sees it.

  It used to be whichever EVM was installed that answered, and the two have nothing in common: revm rejected a replay with `Transaction(NonceTooLow { tx: 0, state: 1 })` — Rust's debug rendering of an enum variant, arriving where a client expects prose — and `@ethereumjs/vm` with `the tx doesn't have the correct nonce. account has nonce of: 1 tx has nonce of: 0` followed by a dump of the whole block and transaction. Neither carried a JSON-RPC code at all. This is the transaction-path twin of the divergence removed from the read path in the same release (revm's validation text arriving as `eth_call` return data), and it is fixed the same way: the engine-specific artifact stops reaching a surface that is meant to be engine-independent.

  **The words are geth's**, so a client already knows them (viem maps these phrases onto typed errors): `nonce too low: address 0x…, tx: 0, state: 1`, `nonce too high: …`, `insufficient funds for gas * price + value: address 0x… have … want …`, `intrinsic gas too low: have 20999, want 21000`. Each is followed by this node's own half — what happened and what to do about it — including the thing a real node would not have to say: there is NO MEMPOOL here, so a too-high nonce is refused rather than queued until the gap is filled.

  **Two behaviour details worth knowing.** Affordability is checked against `value + gasLimit * maxFeePerGas` (EIP-1559's own assertion — the MAX fee, not the effective price the transaction will actually be charged), which is exactly where both engines already drew the line. And the intrinsic-gas floor is the transaction's own, so it includes an EIP-2930 access list (2,400 per address, 1,900 per key); the read path's shared `intrinsicGas()` has no access-list term and is deliberately left alone. Both are measured against both engines in `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`, which also records the decisions taken.

  The nonce and affordability rules are checked at MINE time, immediately before the engine would execute the transaction (their answers change while a transaction waits in `pending`, e.g. nonce 0 and nonce 1 submitted back to back under `manual` mining); the intrinsic-gas floor is refused at SUBMIT, like the block gas limit, since neither can change with time. Each engine's own checks remain underneath as the backstop, and still answer the causes the node does not pre-check (EIP-3607, a type-3 transaction's blob fee).

  Covered by a new battery run against BOTH engines (`test/revm-invalid-transactions.spec.ts`, `test/helpers/invalid-transactions.ts`), which asserts far more than "it threw": after each refusal, every balance, the sender's nonce, a storage slot the transaction would have written, the block number, the receipt, the stored transaction and the block's transaction list are unchanged, the node still mines at the very nonce the refused transaction claimed, and the next receipt's `cumulativeGasUsed` equals its own `gasUsed`. The battery's ability to go red is measured by mutation, including an injected half-committed rejection.

  The default entry's bundle-size baseline is re-pinned 417.9 -> 419.7 KB raw / 126.0 -> 126.6 KB gzip. The 1.8 KB is those four refusals' prose in the core bundle, paid by every consumer including the JS-only one, and it is the feature.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 134b82f: **A revm-executed transaction now leaves post-state `@ethereumjs/vm` cannot be told apart from — for a creation, a nested creation, storage written through nested call frames, an account emptied to nothing, and a selfdestruct.** Gas equality is what the cross-backend gate measures, and it says nothing about balances, code or storage: an engine can charge every transaction correctly and commit the wrong account changes. This is the other half of the correctness bar, diffed through the node's PUBLIC surface (`eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `dumpState`) against a default-engine node built from identical state, plus absolute numbers so two engines cannot agree on a state neither should have produced (`test/revm-post-state.spec.ts`, `test/post-state-expected.ts`).

  **Behaviour change on the DEFAULT engine, in `stateMode:'none'`: a deleted account now takes its STORAGE with it.** `SimpleStateManager.deleteAccount` tombstones the account and never touches storage, so a `SELFDESTRUCT` (or an EIP-161 empty-account clearing) left a dead contract's slots readable at its address and `dumpState` kept serialising them. Measured through the node's own surface, one transaction that writes slot 0 and selfdestructs in the same transaction answered `0x…2a` in `'none'` on `@ethereumjs/vm` and `0x…00` in `'trie'` and on revm. A trie settles which side is wrong — deleting the account removes its storage trie with it — so the fix is ours, in `OverlayStorageStateManager.deleteAccount`, and it is O(1) on the per-account overlay layout. Destroyed contracts' slots now read `0`, and a `dumpState` (hence IndexedDB persistence) taken after a selfdestruct no longer carries them. Nothing else moves; the account's CODE is still kept, on both engines. Recorded in the 2026-08-10 amendment to `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`, measured by a committed probe in `docs/spikes/revm-write-callbacks-reproduce-the-post-state/`, and asserted in BOTH state modes in `test/slim-node-checks.spec.ts`.

  **The receipt's `contractAddress` is proved on a NESTED creation.** `revm-wasm`'s outcome carries no created-address field, so the node derives it from the account changes — and "the entry flagged created" is ambiguous the moment a transaction creates two accounts. The derivation (`keccak(rlp(sender, nonce))`) is now asserted against `@ethereumjs/vm` on a transaction whose init code CREATEs a child; taking the first flagged entry passes every simple deploy and names the child here.

  **The zero-tip coinbase disappearing from state is CORRECT and is now asserted as such, on both engines.** With no priority fee the block's beneficiary is credited nothing, ends each transaction touched-and-empty, and is deleted under EIP-161 — `@ethereumjs/vm` does exactly the same. It is the case in a state diff most likely to be filed as a bug.

  `dumpState` is compared STRUCTURALLY between the engines (same accounts, same code, same slots, same values) and not byte for byte: key order is insertion order, which is each engine's write order — revm hands its account changes over sorted by address, `@ethereumjs/vm` writes them in touch order — so a byte comparison of two CORRECT dumps fails as soon as one transaction creates two accounts.

  The default entry's bundle-size baseline is re-pinned 417.8 -> 417.9 KB raw (gzip unchanged at 126.0). The 0.1 KB is the two-line `deleteAccount` override above; it sits in the core graph because `OverlayStorageStateManager` is the default state manager for `stateMode:'none'`, which is every consumer who passes no options, and it is what buys them post-state that agrees with a trie.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- d494efe: **The revm engine now EXECUTES AND COMMITS transactions, and `Engine.transact` is REQUIRED (breaking for a hand-written engine).** A node with `createRevmEngine()` installed runs ONE EVM: `eth_call`, `eth_estimateGas` and every mined transaction go to revm, against the node's own state.

  `createRevmEngine()` gained the seam's transaction half, built on `revm-wasm`'s committing execute, plus the write half of the state store (five callbacks that previously threw). A signed transaction is executed with FULL validity — nonce checked, real fees charged, base fee burnt, coinbase credited — and its receipt is built from revm's own outcome. Measured against a trie-backed `@ethereumjs/vm` `runTx` reference by the differential conformance battery, which now runs _every_ transaction in it on revm (deploys, storage writes, logs, a real EIP-2930 access list, a legacy fee, a revert, two transactions in one block) and diffs receipts field by field plus post-state: zero mismatches.

  Three details of the mapping, because they are the ones a reimplementation gets wrong:
  - **The receipt's `gasUsed` is revm's `gasUsed`, not its `totalGasSpent`.** Those are two different fields: the first is NET of refunds (what a receipt reports, and what `@ethereumjs/vm`'s confusingly-named `totalGasSpent` already is) and the second is the gross figure before them. The READ path deliberately takes the gross one, because a read has no refund and `eth_estimateGas` wants it. Copying that mapping across would put gas-before-refunds on every receipt, and a value transfer (zero refund) cannot detect it — so the case is measured: `totalGasSpent` 26004, `gasRefunded` 4800, `gasUsed` 21204.
  - **The transaction path carries NONE of the read path's simulation switches** (`disableBaseFee`, `disableBlockGasLimit`, `disableEip3607`, `disableBalanceCheck`), and their absence is ASSERTED rather than assumed. Each relaxes a transaction's VALIDITY, and a transaction that runs with them relaxed is not a transaction.
  - **Nonce checking is chosen by the call path and is not reachable as an option.** The binding defaults it ON for a committing execute precisely because forgetting it yields a silently replayable transaction, so the engine passes nothing for it and `TransactionRequest` carries no way to.

  **`Engine.transact` is no longer optional, and the node's fallback is deleted.** It was optional for exactly one reason — the revm engine had no write half — and that reason is gone. An engine that brings only `call` (or a `transact` that is not callable) is now refused at `createNode()` with a real error naming the missing operation; the node does not fill it in with its own `@ethereumjs/vm`. So `node.engine` names the EVM that answered a node's reads AND executed its transactions, and a receipt can be attributed to it. `transacts()` and the `TransactingEngine` type are gone from the public surface. A third-party engine can no longer ship reads first and grow writes later; an engine that genuinely cannot commit should implement `transact` as a throw.

  One asymmetry was stated rather than worked around here: the node let a client set a gas limit above the block's and told `@ethereumjs/vm` to skip that check, while `revm-wasm` expresses the same relaxation as a simulation switch it refuses to combine with committing, so a transaction whose gas limit exceeded `blockGasLimit` was REJECTED on revm and accepted on the default engine. **SUPERSEDED LATER IN THIS SAME RELEASE** (see the block-gas-limit entry): the skip flag is gone, both engines refuse such a transaction, and `blockGasLimit` is what lifts the limit. It never shipped as a divergence.

  State stays the NODE's on both engines, read and written through host callbacks with nothing copied into wasm — so `dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats are untouched. The decision, its measured affordability (2000 `SLOAD`s of one slot cause ONE host callback at 283,003 gas; 2000 distinct slots cause 2,000 at 4,283,003; a transaction writing one slot of a 1000-slot contract causes exactly one `setStorage`) and the caveat that cuts against it (EIP-2929 resets warmth every transaction, so a game loop re-pays the crossings every tick — wall clock only, gas is identical) are in the new `docs/adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md`, with a re-runnable probe in `docs/spikes/revm-executes-the-first-transaction-with-commit/`. `docs/adr/0006-...` carries a second dated amendment for the contraction.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 → `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`) and the default engine's behaviour is untouched. `OverlayStorageStateManager` gained `setStorageAt()` / `clearStorageAt()`, the synchronous write twins of `storageAt()`, and the revm store's shape guard requires them. The default entry's bundle-size baseline is re-pinned 417.1 → 417.2 KB raw (gzip unchanged at 125.7); still zero bytes of `revm-wasm`.

- fc8b1c7: **In `senderMode:'recover'`, the node now derives the sender with the INSTALLED ENGINE's `ecrecover` when it has one — ~3x on a small transaction, at zero additional engine bytes, and proven to authenticate identically to the implementation it replaces.**

  `'recover'` pays a fixed ecrecover on every transaction and it is the single dominant cost of a small one. `embedded-eth-node/revm` already contains that exact code — the `0x01` precompile's secp256k1 — so the seam now offers it and the node uses it. With no such engine, recovery is `tx.getSenderAddress()` exactly as before.
  - `Engine` gains an **OPTIONAL** `ecrecover(hash, recoveryId, r, s) => Uint8Array | undefined`. It is the seam's only optional operation, and deliberately: `call` and `transact` are refused at construction because the node cannot supply them, while this one it can and always could. Omitting it costs a third-party engine nothing but speed.
  - **The engine is lent the CURVE STEP, never the decision.** Deciding _who sent this transaction_ stays the node's on every engine (`docs/adr/0006-...`, amendment 4): the new `src/sender-recovery.ts` computes the message hash, enforces EIP-2's low-`s` rule, and converts the wire's `v` — 27/28, `chainId * 2 + 35/36`, or a bare y-parity — into a 0/1 recovery id before the curve is asked. An engine is handed a question about a SIGNATURE and never one about a TRANSACTION, so it can neither admit a transaction the node would refuse nor refuse one it would admit.
  - **EIP-2 is the reason that division is load-bearing, not tidiness.** revm's ecrecover is the `0x01` precompile's, which NORMALISES a high-`s` signature and returns an address — correctly, since EIP-2 constrains transactions rather than the precompile. A node that simply forwarded `(hash, v, r, s)` would ADMIT, on the revm engine, a transaction the default engine REFUSES: nothing throws, the receipt looks right, and it is attributed to the right signer. Removing the node-side check turns the new suite red with the transaction mined and the balance moved (`docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md`).
  - **`senderMode:'trusted'` is untouched.** It still skips recovery ENTIRELY — now measured, by counting the engine's `ecrecover` calls and requiring zero — and the `evm_*As` cheats still throw `-32601` outside that mode, whatever engine is installed.

  **Proven on failures, not only on successes.** `test/revm-sender-recovery.spec.ts` (battery in `test/helpers/sender-recovery.ts`) runs the two implementations side by side in three layers: as a PRIMITIVE over a table of signatures (`@ethereumjs/util`'s `ecrecover` + `publicToAddress` against `engine.ecrecover`, valid / flipped recovery id / malleable high-`s` twin / `r=0` / `s=0` / `r=n` / `s=n` / `r=n-1` / recovery ids 2, 3, 4, 27, 28); through TWO NODES built from identical state, one with the engine and one without, asserting the recovered sender is the known signer for legacy, EIP-2930 and EIP-1559 transactions; and on four transactions that must be REFUSED (a structurally malformed signature, one that reaches the curve and recovers nothing, a high-`s` one, and a wrong recovery id) where both must reject with nothing mined and no balance or nonce moved. A counting wrapper proves the engine really recovered them, so the differential cannot pass vacuously by comparing the fallback with itself.

  **The numbers moved, and the docs move with them.** The `'recover'` vs `'trusted'` figures the repo quoted (~13x isolated, ~2.3x end to end) were measured on `runTx` before ADR 0009's storage re-layer and had drifted by half. Re-measured on the current node: **~6.2x isolated / ~3.6x end to end on the default engine**, and **~2.8x / ~1.8x with a revm engine**, whose recovery is ~4.3x cheaper (2.02 → 0.65 ms per isolated transaction, and `callAvg` 1.92 → ~1.08 ms in Chromium). `'trusted'` remains worth having and has stopped being the dominant lever. Updated in `src/types.ts`, `src/node.ts`, `src/engine.ts`, the README, the trusted-sender suite and `packages/benchmarks`; `CHANGELOG.md` is history and `docs/adr/0002-...` takes a dated amendment rather than an edit.

  **Decisions taken while building this** (the optional seam operation, the `ecrecover` naming against `CONTEXT.md`'s glossary, two implementations rather than one pluggable path, the refusal's shape, and the core-graph bundle cost) are recorded in `docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md#decisions-taken-while-building-this`, with the seam decision itself in `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md` (amendment 4) and the mode's re-described trade in `docs/adr/0002-...` (2026-08-11).

  The default entry point's bundle grows 420.0 → 421.1 KB raw / 126.7 → 127.1 KB gzip (re-pinned in `packages/benchmarks/test/evm.spec.ts`) — that is `src/sender-recovery.ts`, still zero bytes of `revm-wasm`. Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 → `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- ccacf35: **The RPC block now reports the block the EVM actually ran: `miner`, `mixHash` and a real `logsBloom` (behaviour change on all three).** A node created with `blockEnv: {coinbase, prevRandao}` mined blocks whose `COINBASE` / `PREVRANDAO` opcodes returned the configured values while `eth_getBlockByNumber` reported `miner: 0x0000…0000` and no `mixHash` field at all, and every block's `logsBloom` was a hard-coded 256 zero bytes even when its receipts carried real ones. The RPC surface and the EVM disagreed about the same block, and no document said so. If your tooling reads a constant-zero `miner`, it now gets the configured coinbase; if it pre-filtered blocks by the header bloom before calling `eth_getLogs`, it stops silently finding nothing.

  **The reload was the real defect, and it was worse than an RPC one.** `eth_call` executes against the STORED `Block` object of the latest block, and `loadState` rebuilt that object from six header fields with the coinbase and the mixHash among the ones it dropped. So a node that had loaded a persisted state (an ordinary IndexedDB page reload) handed contracts a ZERO `COINBASE` / `PREVRANDAO` while the same node's mined blocks used the configured ones: the node changed its own execution semantics across a reload. `SerializedBlock` now carries the values, `loadState` restores them onto the rebuilt block, and `test/rpc-block.spec.ts` makes every assertion twice, on the original node and on a fresh one built with NO `blockEnv` that knows only what the dump gave it. The IndexedDB suites (`test/persistence-reload.spec.ts` and its revm twin) carry the same three values across a REAL page reload, again with the post-reload node configured with no `blockEnv` of its own.

  The same reconstruction also fixes the chain's own continuity: because the rebuilt header is now field-for-field the one that was mined, its `hash()` matches the hash the RPC reports, so the first block mined after a reload names a parent that resolves. It used to name one no lookup could find. That invariant is stated at the `loadState` site and asserted through the RPC.

  **The persisted format stays `version: 1`.** The three fields are OPTIONAL, so a state dumped by any earlier version still loads: an absent `miner` / `mixHash` reads as zero (never as a missing RPC field), and an absent `logsBloom` is REBUILT from the receipts the dump already carries, rather than defaulted to the zero placeholder this change exists to remove. Asserted against a dump with the fields stripped.

  **Genesis honours `blockEnv.coinbase` and `blockEnv.prevRandao` too**, and only those two: they describe the environment the chain runs under, whereas `number` / `timestamp` / `gasLimit` place a block within it (block 0 is block 0). Block 0 used to be the one block that ignored `blockEnv` entirely.

  Not changed, deliberately: the conformance battery's `block environment through a contract` step still diffs those two values against the configuration rather than against the now-honest block, because swapping an oracle changes what a step can catch and belongs to its own reasoning. The header's `gasUsed` is still always `0x0` (the header is built before its transactions execute) — out of scope here, but now STATED in the README's `eth_getBlockByNumber` row alongside the remaining placeholders, so a consumer meets it.

  The default entry's bundle-size baseline is re-pinned 422.0 -> 422.5 KB raw / 127.4 -> 127.6 KB gzip. The 0.5 KB is the bloom OR loop (shared by the mining path and the old-dump rebuild), the three fields crossing `SerializedBlock`, and the coinbase/mixHash restoration in `loadState`; it is in the core graph because block construction and the RPC layer are the node's on every engine.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 7ba77f8: **The SENDER now crosses the engine seam as a value: `TransactionRequest.sender` (required — breaking for a hand-written engine), so a trusted-sender transaction executes as the CLAIMED sender on any engine.**

  `senderMode:'trusted'` exists so a caller who already knows the sender can skip ecrecover, which means it deliberately admits a transaction whose claimed sender differs from what its signature recovers to (and a fabricated signature has no meaningful recoverable sender at all). The node used to express that by SHADOWING `getSenderAddress()` on the `@ethereumjs/tx` instance it was about to run — fine while the node itself called `runTx`, which reads the sender through exactly that one call, but once transactions cross the engine seam it became an undocumented convention holding ACROSS an engine boundary. **An engine that recovers its own sender does not fail loudly**: it charges a different account, advances a different nonce, commits, and hands back a receipt that looks completely right.
  - `TransactionRequest` gains a required `sender: Address` — the node's authoritative answer to who sent the transaction: `msg.sender` of the top-level frame, the account charged, the nonce advanced, the `from` on the receipt. An engine executes on behalf of it and derives nothing.
  - **The instance shadowing is gone**, not kept as a second mechanism. `parseTx` decides the sender ONCE per transaction (recovered, or the claimed address) and carries it to the engine, the receipt and the stored transaction, so "who the engine executed as" and "who the receipt names" cannot drift apart by engine. Transactions are parsed FROZEN again in both sender modes. One user-visible consequence: an unrecoverable signature is now rejected by the `eth_sendRawTransaction*` call that submitted it rather than by a later `mine()` (recovery is eager, and it always happened before the block was returned anyway).
  - The default `@ethereumjs/evm` engine pins the sender for `runTx` **inside the engine**, where that EVM's vocabulary belongs (like the two `skip*Validation` flags): a prototype VIEW of the transaction whose `getSenderAddress()` returns `request.sender`, so the node's own frozen transaction is never mutated and the pin lives for exactly one call. `embedded-eth-node/revm` needs none of that — revm's execute takes `from` directly — and it no longer asks the transaction either.
  - **`senderMode:'trusted'` is unchanged in scope**: still opt-in at `createNode()`, and the `evm_*As` cheats still throw `-32601` in the default `'recover'` mode, whatever engine is installed (ADR 0002 carries a new dated consequence; `docs/adr/0006-...` carries amendment 3).

  **Proven, and proven to be provable.** The trusted-sender suite is now ENGINE-PARAMETERISED (the precedent the conformance battery set) and runs on the default engine _and_ on the revm engine, from one shared suite rather than a copy: `test/trusted-sender.spec.ts` + `test/revm-trusted-sender.spec.ts`. Its claimed-sender check is built so that the wrong answer is SILENT — the transaction is signed by an account that is interchangeable with the claimed one as far as validity goes (same nonce, both funded), so a re-recovering engine executes it happily and only the post-state disagrees. Both specs assert, to the wei: the claimed account paid `value + gasUsed * effectiveGasPrice` and its nonce advanced, the signer paid NOTHING and its nonce did not move, the receipt names the claimed sender, the call's state change happened, and the resulting post-state matches the SAME pinned literals on both engines (`test/trusted-sender-post-state.ts`). `test/engine-seam.spec.ts` pins the seam itself: a stub engine reports both the sender it was handed and the one it would have recovered, and they must differ for such a transaction. Each half was verified to FAIL under a one-line re-recovering engine (`docs/spikes/trusted-sender-transactions-run-on-the-write-engine-as-the-claimed-sender/re-recovering-engine-probe.md`).

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 → `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), and the conformance battery (both state modes, and again on revm), the GeneralStateTests, persistence, worker and viem-surface suites pass unchanged.

### Patch Changes

- a7eeecf: **EIP-2930 access lists are proven CHARGED and WARMED on both engines, and `eth_estimateGas` now charges a request's access list.**

  A dropped access list is invisible to every differential in this repo: the transaction then costs the same wrong number on both engines, the receipts match field for field and the post-state is identical. That is measured rather than argued (`docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md`): with the list stripped on both sides the battery reports an EMPTY `mismatches` beside seven wrong gas figures. So the new `test/revm-access-list.spec.ts` (battery in `test/helpers/access-list.ts`) is ABSOLUTE, and it is a DIFFERENCE: the same type-1 transaction WITH its access list and with an EMPTY one, on a revm-backed node and on a default-engine node built from identical state.

  The two halves pull in opposite directions, which is what makes the arithmetic diagnostic rather than merely different. Listing an ADDRESS the transaction touches (`BALANCE` against a cold account) costs 2,400 and saves 2,500, so it is **100 gas cheaper**; adding the STORAGE KEY a callee `SLOAD`s costs 1,900 and saves 2,000, again **-100**; naming the callee itself is **+2,400** for an address EIP-2929 had already warmed, which is the shape of a charge that bought nothing; and a list whose entries are NEVER touched is **+6,200 exactly** (2,400 + 2 \* 1,900) and buys nothing at all, the case where a dropped list changes nothing any other measure can see. A dropped list gives 0 on all four. A listed address is also shown to be WARMED, not touched: it is absent from `dumpState` afterwards.

  **The behaviour change: `eth_estimateGas` charges a request's `accessList`** (2,400 per address, 1,900 per storage key), as geth does. It had ignored the field, so it answered 21,000 for a type-1 transaction whose intrinsic floor is 27,200 while the node's own intrinsic-gas refusal was telling callers that `eth_estimateGas` reports what a transaction needs: the node refused the very number it had just recommended. The battery closes that loop rather than asserting a figure, by signing a transaction at exactly the recommended gas limit and requiring it to mine. The charge sits BESIDE the shared intrinsic formula (`accessListGas` in `src/intrinsic-gas.ts`), never inside it, because the engine seam's read request carries no access list and `embedded-eth-node/revm` SUBTRACTS that formula from revm's total. It is a slight over-estimate for entries a transaction really touches, since the read underneath prices those accesses cold, which is the safe direction for a number a client uses as its gas limit. `eth_fillTransaction` deliberately does not charge it: the transaction it returns carries no access list.

  Mined transactions are unchanged: both engines already charged and warmed the list, and the revm mapping was verified still in place. Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 90f56f8: The bottom storage overlay no longer accumulates a tombstone per cleared account, which was one permanent entry per contract creation for the life of the process.

  `stateMode:'none'` storage is per-account with per-checkpoint OVERLAYS (ADR 0009), and an overlay's tombstone set exists to hide the slots overlays BELOW it hold. The BOTTOM overlay is committed state, so it has nothing below and a tombstone there hides nothing — but nothing removed it either, and `@ethereumjs/evm` calls `clearStorage` on EVERY contract creation. A long-lived in-browser node therefore kept one packed address key per CREATE ever executed, and walked all of them again in `liveStorage()`, i.e. in every `dumpState`.

  Nothing answered WRONG because of it: a tombstone over an account with nothing beneath it is a no-op that happens to cost memory. It is pruned at the two places one could be created, rather than swept later: `commit()` skips it when the overlay it is merging into is the bottom one, and `clearStorageAt()` skips it when no checkpoint is open. The `delete` that performs the clear is untouched in both, so a cleared account still reads as cleared — the stack walk falls off the end, which is the same "no value here" a tombstone produced.

  Both sites are reachable and they are reachable from DIFFERENT engines. `runTx` checkpoints, so on the default `@ethereumjs/evm` engine the EVM's `clearStorage` lands three overlays deep and the tombstone is pruned as the frames commit down; `embedded-eth-node/revm` commits its state changes through synchronous host callbacks with no checkpoint around them, so every CREATE on that engine clears at depth 1 and never went through `commit()` at all (measured: three contract creations, three permanent tombstones).

  `test/storage-overlay.spec.ts` asserts both halves at both sites — no tombstone in the bottom overlay, and the account still reads as cleared and is absent from `liveStorage()` — plus the case that must NOT change: a commit into a non-bottom overlay still leaves the tombstone that hides the frame below it. The six checkpoint/commit/revert semantics, the 20,000-operation randomised differential against the frozen pre-overlay layout, the naive control's continued failure of 4 of the 6, and the byte-identical `dumpState` fixture are all unchanged and unweakened. No API, no serialised format and no gas moved. The default entry's bundle-size baseline is re-pinned 421.9 -> 422.0 KB raw (gzip unchanged at 127.4): the 0.1 KB is the two depth tests, in the core graph because this is the default state manager for `stateMode:'none'`.

- 7738986: **`dumpState`, `loadState`, IndexedDB persistence and the `evm_set*` cheats keep working EXACTLY as they do today when a revm engine is installed — proved by running the existing suites on it and changing nothing they assert.**

  No production code changed, and that is the result rather than the absence of one. State stays the node's on every engine, read AND written through host callbacks with nothing copied across ([ADR 0010](https://github.com/wighawag/embedded-eth-node/blob/main/docs/adr/0010-revm-reads-and-writes-through-host-callbacks-the-node-keeps-owning-state.md)), so the node's state-facing surface never learns which engine is installed and none of these features has an engine-conditional path to acquire. The three suites were PARAMETERISED by engine — the precedent the conformance battery set — and every expectation in them is the one it already had: the IndexedDB persist/reload flow (`revm-persistence-reload.spec.ts`), and the custom-genesis + cheat halves of the genesis suite (`revm-genesis-cheats.spec.ts`), now run on `embedded-eth-node/revm` against literals shared with the default-engine run (`test/genesis-cheats-expected.ts`). The genesis suite's trie-vs-none PERF half stays on the default engine by construction: it is a comparison BETWEEN the state modes, so it needs a `stateMode:'trie'` node, which this engine refuses at construction (ADR 0005).

  **The two cases worth adding are both about a WRITE crossing a transaction boundary** (`state-roundtrip.spec.ts` and `revm-state-roundtrip.spec.ts`, suite in `test/helpers/state-roundtrip.ts`), because every other differential in this repo lives inside ONE transaction and would pass unchanged for an engine that cached state between them. All four cheats are applied BETWEEN two transactions and the next transaction is built so that EXECUTION has to observe each: it is accepted at the cheated NONCE, paid out of the cheated BALANCE, increments the cheated STORAGE (`number` goes 1 -> 41 -> 42), and a third transaction CALLS the cheated CODE. Then a `dumpState` taken AFTER a transaction is reloaded into a fresh node, compared structurally, and handed the SAME signed transaction as the original — same receipt, same post-state, same dump.

  **Neither failure mode throws**, which is why the expectations are absolute literals shared by both engines rather than a cross-engine diff. Measured with the cheats deliberately skipped (`docs/spikes/every-node-feature-survives-a-revm-write-engine/measurements.md`): every structural check still passes — success receipts, empty `mismatches`, the reloaded node still agreeing with the original field for field, both dumps still equal — and only the four absolute readings move (42 becomes 2, 99 becomes 0). A self-consistent engine executing against stale state is invisible to a differential.

  `dumpState` is compared STRUCTURALLY, never byte for byte: key order is insertion order, which is each engine's write order (revm's account changes arrive sorted by address, `@ethereumjs/vm` writes in touch order), so a byte comparison of two CORRECT dumps fails the moment a transaction creates two accounts. Cross-engine dump equality for the same transactions was already covered that way by `revm-post-state.spec.ts` and is not restated here.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- cc448d0: **The MONEY a transaction costs is now diffed between engines on BALANCES, not on receipts** (`test/revm-fees.spec.ts`, `test/helpers/fees.ts`). `effectiveGasPrice` already has exactly one implementation per engine and none in the node — the default engine computes it where `@ethereumjs/vm` charges the transaction, the revm engine reports revm's own `Transaction::effective_gas_price` off its outcome, and the node copies whichever number the engine that ran the transaction handed back. What no receipt field can prove is that the matching amount of ether actually MOVED: a receipt can carry the right price while the wrong amount left the sender, and the cross-backend gas gate cannot see that class of bug at all.

  So seven transactions now run on a revm-backed node and on a default-engine node built from identical state, and three balances are read before and after each one: the sender is charged `value + gasUsed * effectiveGasPrice`, the coinbase is credited `gasUsed * (effectiveGasPrice - baseFee)`, and `gasUsed * baseFee` is BURNT — the burn measured as the drop in total supply across every account in `dumpState`, so money appearing at a fourth address cannot hide inside a subtraction. The four readings must also CLOSE against each other. The base fee is seven wei, so every figure is checkable by eye: a 1,000 wei transfer at 21,000 gas and an effective price of 10 charges the sender 211,000, credits the coinbase 63,000 and burns 147,000.

  The cases are chosen for where the engines are most likely to disagree first: a **LEGACY transaction ABOVE a non-zero base fee** (at `gasPrice == baseFee` a mispriced legacy transaction is invisible, because every wrong answer coincides with the right one), **EIP-2930** with its access list charged, **EIP-1559 capped by `maxFeePerGas`** as well as by the tip (only the capped one measures the `min`), a **zero priority fee**, and a **STORAGE-CLEARING REFUND** priced at the effective gas price — with the same call repeated against the now-zero slot, 2,000 gas dearer, so the refund is known to have happened rather than assumed. A refund valued at the base fee instead would leave the sender short by `refund * tip` with every receipt field still reading correctly.

  **The zero-tip coinbase disappearing from state is CORRECT, and now has its control.** Credited nothing, the block's beneficiary ends the transaction touched-and-empty and is deleted under EIP-161 on both engines. The tipped case asserts the same coinbase IS in the dump, so its absence means "credited nothing" rather than "never written".

  That the battery can go RED is measured, not assumed: three deliberate mutations (a legacy transaction priced at the base fee, the revm engine reporting gross gas instead of net, and a hand-rolled `baseFee + tip` beside revm's own answer) each with the run they produced, in `docs/spikes/fees-refunds-and-effective-gas-price-come-from-the-engine/measurements.md`.

  Tests only — no library code changed, and no behaviour with it. Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 77ef1ec: The revm engine's exported hardfork tables are FROZEN, so the construction guard cannot be assigned away.

  `REVM_SPEC_BY_HARDFORK` and `REVM_REFUSED_HARDFORKS` are public on the
  `embedded-eth-node/revm` subpath so "which forks does this engine serve" is
  answerable in code rather than by provoking a throw. They were typed
  `Readonly<Record<...>>`, which is erased at runtime, so a consumer could re-admit
  a refused fork with one assignment (`REVM_SPEC_BY_HARDFORK.prague = 'PRAGUE'`)
  and `createRevmEngine()` would then connect on it — producing an
  `eth_estimateGas` revm itself rejects (`GasFloorMoreThanGasLimit`, and on Osaka
  `TxGasLimitGreaterThanCap` for the default 30M read budget). A client uses an
  estimate as the transaction's gas limit, so that guard is the only thing between
  such an assignment and a silently wrong number.

  Both tables are now `Object.freeze`d. Reading them is unchanged; WRITING to
  either now fails at the assignment (a `TypeError` in strict mode, a dropped write
  in sloppy mode) instead of silently removing the guard. The guard deliberately
  still reads the tables themselves rather than a copy taken at module load, so the
  table a consumer inspects and the table the engine consults cannot disagree; the
  reasoning is recorded at the code site in `src/revm.ts`.

  No behaviour changes for any admitted fork (`berlin`, `london`, `paris`,
  `shanghai`, `cancun` — unchanged), and no refusal message changed. Also asserted
  now, in `test/revm-engine.spec.ts`: the tables report frozen, a re-admitting edit
  leaves them exactly as they were, the guard still refuses `prague` afterwards in
  the same words, and the engine's existing refusal to serve a read before
  `connect()` bound it to a node is measured rather than merely written.

- e2db3f3: The `stateMode:'none'` storage key is now PACKED, which takes 70-73% off every cold revm storage access.

  A storage key inside the node is no longer a `0x`-hex string (42 characters for the account, 66 for the slot) but two bytes per UTF-16 code unit: 10 code units and 16. It is `revm-wasm`'s own `MemoryStore` encoding, and it became available only when the node took ownership of its storage representation (`stateMode:'none'` storage is per-account with per-checkpoint overlays, ADR 0009); before that the format was `SimpleStateManager`'s and had to be reproduced byte for byte.

  Measured against the SHIPPED store over a real `OverlayStorageStateManager`, through the real wasm module, with the key encoding as the only difference between the arms: **a cold revm storage access went from 1.31-1.33 µs to 0.36-0.39 µs**, of which 0.17-0.18 µs is the wasm crossing itself (measured by a store that answers without looking at the key). The JS half alone went from 1.11-1.12 µs to 0.22 µs. The spike that proposed this predicted 50% from a prototype; the shipped version does better, because the encoder is unrolled into a single `String.fromCharCode` call and because the store's per-account view — a `Map` lookup and a closure per access that never saved anything, since the address key had to be built first to find the view — went with it. Both runs and the re-runnable probe are in `docs/spikes/revm-state-store-packed-storage-keys/measurements.md`.

  **Nothing a consumer can see changes.** `dumpState` / `loadState` output is persisted data and stays `{address: {slot: value}}` in `0x`-hex, key order included — the internal key moves UNDER that format, `liveStorage()` converts on the way out, and the existing byte-identical assertion against a dump captured before the layout ever changed still passes, unweakened. Accounts and code are untouched: those stacks are `SimpleStateManager`'s and stay keyed `address.toString()`. Gas is untouched on either engine (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

  **The risk this carries is a key format disagreeing with itself, and it has its own test.** `@ethereumjs/evm`, genesis, `loadState` and the `evm_set*` cheats write storage through the ASYNC `putStorage`; revm reads it through the SYNCHRONOUS `storageAt`. Two formats that each work on their own make every cross-route read a MISS — and a miss is a ZERO, not an error, at identical gas, so the cross-backend gas gate, the conformance differential's receipts and every `dumpState` diff would stay green while the node read nothing. So both halves import the SAME encoder (`src/storage-keys.ts`), and the new `test/revm-storage-keys.spec.ts` asserts the agreement end to end in both directions on absolute values, with a default-engine node as the oracle: storage seeded at genesis, set by a cheat between transactions and rehydrated by `loadState` is read back by an `SLOAD` on revm, and a slot revm's `SSTORE` committed is read back through `eth_getStorageAt` and `dumpState`. Mutating either half of the encoder back to hex turns it red, with the transcripts recorded beside the measurement.

  The default entry's bundle-size baseline is re-pinned 421.1 -> 421.9 KB raw / 127.1 -> 127.4 KB gzip. The 0.8 KB is `src/storage-keys.ts` — two unrolled encoders, the inverse pair that keeps `dumpState` in hex, and a 256-entry hex table — and it is in the core graph because this is the DEFAULT state manager's key format: the async `putStorage` that `@ethereumjs/evm` drives builds keys with the same module, which is the whole point.

  One internal detail worth stating for anyone deep-importing `src/state-manager.ts`: the `AddressKey` / `SlotKey` type aliases are gone, replaced by `PackedAddressKey` / `PackedSlotKey` (and `HexKey` for what `liveStorage()` returns). They were never exported from the package entry point.

- 350fc62: `stateMode:'none'` storage is now per-account with per-checkpoint OVERLAYS, so a checkpoint stops copying all of state — 18-28x faster on four transactions at 100,000 slots, and FLAT in state size.

  `SimpleStateManager` keeps storage in one flat `${address}_${slot}` map and copies
  it WHOLE on every `checkpointSync()`. `@ethereumjs/evm` checkpoints once per
  message frame, so every transaction paid `frames + 1` copies of all of state, and
  `clearStorage(address)` — which the EVM calls on every contract creation — could
  only be a prefix scan of the whole map.

  Storage is now `Map<address, Map<slot, value>>`, and a checkpoint pushes an
  **overlay**: only what that checkpoint changed, plus a tombstone set of the
  accounts it cleared. A commit merges the top overlay down, a revert drops it, and
  a read walks the stack.

  Measured on the shipped class against the layout it replaces
  (`docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`,
  re-runnable):

  |                                                 | before           | after                 |
  | ----------------------------------------------- | ---------------- | --------------------- |
  | one checkpoint, 100,000 slots                   | 20,213–22,901 µs | 0.34–0.37 µs          |
  | `clearStorage`, 100,000 slots                   | 15,647–17,458 µs | ~0.53 µs              |
  | four transactions, 1,000 slots                  | 14.3–15.8 ms     | ~12.0 ms              |
  | four transactions, 100,000 slots                | 301–336 ms       | 11.9–16.8 ms (18–28x) |
  | one transaction through the node, 100,000 slots | 38.9–94.0 ms     | 2.4–3.0 ms            |
  | one `eth_call` through the node, 100,000 slots  | 49.6 ms          | ~0.33 ms              |

  ~12 ms whether state holds 1,000 slots or 100,000: flat in state size rather than
  merely faster, which is the property that matters — the old layout kept getting
  worse as state grew. (Both figures per cell are two consecutive runs of the same
  script; the 100,000-slot row is the allocation-heaviest and moves tens of percent,
  so read the flatness rather than a single ratio.) This is a cost the DEFAULT engine paid, not a revm one:
  swapping the interpreter could not have touched it, because the copying was in
  the state manager.

  **No API and no serialised format changed.** `dumpState` output is asserted
  byte-identical against a dump captured from the previous version, and that dump
  is asserted to load back — it is persisted data, and the internal layout moved
  under it. `loadState`, IndexedDB persistence and the `evm_set*` cheats are
  untouched, and the conformance differential, the GeneralStateTests run and the
  cross-backend gas gate are unchanged.

  One INTERNAL breaking change, for anyone who reached past
  `StateManagerInterface`: the `'none'`-mode state manager is now
  `OverlayStorageStateManager` (was `SimpleStateManagerWithClearStorage`) and its
  inherited flat `storageStack` is no longer maintained — READING it throws an error
  naming the replacement (`storageAt(addressKey, slotKey)` for one slot,
  `liveStorage()` for all of them). That is deliberate: left present and empty, it
  made three shipped readers answer "this slot is zero" for a slot holding a value,
  with no error at all.

  The default entry point grew 413.7 -> 416.3 KB raw / 124.6 -> 125.4 KB gzip, and
  the benchmark's bundle baseline is re-pinned in this same change. The 2.6 KB is
  the overlay walk, the commit merge, the two synchronous accessors and the retired
  stack's error text; it is in the core graph because this is the default state
  manager, and it is what buys that same default consumer that flatness. Still zero bytes
  of `revm-wasm` in the default graph.

  Correctness is asserted before speed, in `test/storage-overlay.spec.ts`: six
  checkpoint/commit/revert semantics, a 20,000-operation randomised differential
  against the previous flat layout comparing every read and periodic full
  snapshots, and the same battery run against a NAIVE per-account layout (shared
  inner maps) which must FAIL it — 4 of the 6 — so the assertions are known to have
  teeth.

- 83d62e5: **`embedded-eth-node/revm`: a call the engine REFUSES no longer answers with revm's error text as `eth_call` return data.** `revm-wasm` reuses the outcome's return-data slot for the text of a validation error, so an unaffordable value-bearing `eth_call` on the revm engine came back as `RpcError(3, 'execution reverted', '0x5472616e…')`, whose `data` decodes to the ASCII of `Transaction(LackOfFundForMaxFee { fee: 1, balance: 0 })`. The default `@ethereumjs/evm` engine returns `0x` for the identical call. `data` on that error has ONE meaning to a client — the callee's revert payload, which viem tries to decode as a revert reason — so this put a non-answer where an answer is expected, on one engine only. Both engines now return `0x`, and this was the last known behavioural divergence between them ON THE READ PATH, on the forks revm admits. The TRANSACTION path still differs in the words a rejection reaches the caller with, which is open and tasked; and this node runs no blob fee market, so nothing here should be read as a claim that the two engines agree everywhere.

  **A real revert still delivers its own bytes**, on both engines: the two cases are told apart by revm's own `outcome.status` (`validation-error`, which spends no gas and executes nothing, versus `revert`/`halt`), never by matching its message. Measured across all four statuses in `docs/spikes/stop-forwarding-revms-validation-error-text-as-eth-call-return-data/`.

  **The engine's explanation is not discarded, it moves to the error.** `ReadCallResult.error` now carries a node-voiced refusal quoting revm's reason verbatim ("the call is invalid and was NOT executed: `Transaction(LackOfFundForMaxFee { .. })`. Nothing ran, so this is a refusal rather than a revert…"), which is the same field the default engine reports `insufficient balance` in — a place nothing can decode as a contract's answer. `eth_call` itself is unchanged: the node still flattens every engine failure into one `execution reverted` with code 3, on both engines.

  Asserted engine-against-engine (`test/helpers/revm-engine.ts`): the same unaffordable call carries the same `data` on both engines, and a callee that reverts with a reason still delivers its bytes on both. Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- 01363c1: **A log emitted inside a sub-call that then REVERTS is now proved absent from the receipt, from its bloom and from `eth_getLogs` — on both engines.** This is a test-only change (`patch`): no behaviour moved, and the reason it did not is itself the news. `logsBloom` already comes from the engine that executed the transaction, on both paths (`@ethereumjs/vm`'s `runTx` bloom on the default engine, `revm-wasm`'s own decoded outcome on the revm one) and the node contains no bloom implementation to drift from them, so story 6 of the transaction-engine spec needed the log CASES rather than another move.

  The interesting case is the one that looks plausible when it is wrong. A receipt carrying a log from a frame that reverted has a real address, real topics and sane ordering; the only thing wrong with it is that the event never happened, and `eth_getLogs` then reports it to an application that acts on it. Nothing in the battery reached that case before — `boom()` reverts before emitting anything — so it is now covered by a fixture built for it (`test/contracts/DiscardedLogProbe.sol`) in three shapes: a sub-call that emits and reverts BETWEEN two surviving events, the same frame as a whole transaction (a failed receipt that must keep nothing at all), and both inside a block alongside other log-emitting transactions.

  **The bloom is asserted without computing one.** A second bloom implementation on the test side would be the same drift the engine seam exists to remove, and a receipt diffed against our own arithmetic is not diffed against an EVM. So the absence is stated two ways instead: the whole 256 bytes are diffed against the trie-backed `@ethereumjs/vm` reference like every other receipt field, AND the reverting transaction's bloom must be BYTE-IDENTICAL to a baseline transaction that emits the same two events from the same address with the same indexed arguments and makes no reverting sub-call. A bloom is over log addresses and topics only, so those two can differ by exactly one thing: the discarded frame's topic leaking in. That pair is load-bearing — with the sub-call's revert removed, the receipt diff against the reference stays perfectly clean (the reference executes the same contract and leaks the same log) and only the baseline comparison, the topic check and the `eth_getLogs` filter go red.

  **The division of labour is pinned too, on a block that can see it.** The engine owns a log's address, topics, data and emission order; the node owns block hash, block number, transaction hash, transaction index and a `logIndex` that runs across the BLOCK. A block of one log per transaction cannot tell a block-wide index from a per-transaction one, so the new step mines a block emitting 2, then 0, then 2 logs: continuity reads 0,1,2,3 where a per-transaction index reads 0,1,0,1, and the zero-log transaction in the middle proves the running total counts logs and not transactions. `eth_getLogs` for that block must then return exactly the receipts' logs, field for field, and a filter on the discarded event's topic must return nothing while the same filter on a surviving event returns the survivors.

  A zero-log transaction's bloom is also now stated absolutely as the all-zero 256 bytes, not only diffed. That is the value revm's wire format OMITS when the log count is zero, so it is the case a hand-rolled decoder turns into an empty `logsBloom` on the cheapest transaction there is.

  The new fixture is a SEPARATE contract rather than two more functions on `ConformanceProbe`, deliberately: that probe's creation bytecode is shared with the trusted-sender suite, which pins the resulting sender balance as an absolute literal, so growing it would mean editing another suite's oracle to match an observation.

  Reference gas is unchanged (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`).

- f048042: **What a transaction actually costs on each engine, measured by SHAPE and reported whatever it says** (`docs/spikes/measure-what-transactions-on-revm-actually-cost/`, produced by the re-runnable `measure-transaction-cost.mjs` in that folder). Story 8 of `work/specs/tasked/revm-engine-behind-runtx.md` wants transaction execution "measurably faster", and the honest form of that is a measurement rather than an assertion. Three changes had moved the baseline since the last figures were taken — ADR 0009's storage re-layer, the engine's `ecrecover`, and the packed storage key — so nothing is quoted here; it is all re-derived against the current tree, and the script exits non-zero if any of its own checks fail.

  **The headline, and it is smaller than the compute rows suggest.** For the configuration a consumer actually ships (`senderMode:'recover'`, the default), a transaction is **3.0-3.3x cheaper on revm for every light shape** (transfer, storage write, creation, logs) and **3.9-7.3x for slot-heavy ones**. But **88-101% of the light-shape saving is `Engine.ecrecover`, not the interpreter**: with recovery taken out of the window, a plain **value transfer is 0.93x / 1.02x, i.e. no measurable difference at all**, and the other light shapes are 1.35-1.70x. A transaction is not compute, and on a 21,000-gas transfer the node's own dispatch, block building and receipt assembly are essentially all of it.

  **The interpreter and the state seam start to matter with DISTINCT storage slots**, which is the axis the host-callback design is sensitive to (a boundary crossing is paid once per COLD access, ADR 0010): 1.8x at 16 slots, 3.1-3.2x at 64, 6.8-6.9x at 256, 16.3-16.5x at 12,288 — which is near the most one transaction can reach, since the block gas limit refuses much more. The marginal cost of one further cold slot is **0.55-0.58 µs on revm against 9.3-9.7 µs on the default engine**. There is no crossover where the default engine wins; the crossover that exists is the FRAME BUDGET, and it falls between 1,024 and 2,048 distinct slots per transaction, where the default engine goes from 55% to 109-116% of a 16.6 ms frame and revm is at 8-9%.

  **The COMMIT path is measured for the first time.** Host writes are exactly proportional to what the transaction touched (a transfer: three account reads and three account writes on revm, nothing else) and the commit is 2.0-3.2% of a light transaction, rising to 23% of a 256-slot write. **One premise this was asked to check turned out to be inverted**: crediting the coinbase a real fee costs FEWER host writes than deleting it, not more — one `setAccount` against `clearStorage` plus `removeAccount` on revm (3 writes against 4), and 6 against 7 on the default engine.

  **Stated as a finding rather than acted on** (ADR 0010 asks for exactly this trigger): a wasm-side cache spanning transactions would remove at most the read-callback time, about 15% of a 256-slot transaction, and would need invalidating on the `evm_set*` cheats — a poor trade at today's numbers. Revisit if a tick needs SEVERAL thousand-slot transactions, since four 4,096-slot transactions is 10-11 ms of a 16.6 ms frame.

  Documentation and a spike script only — no library code changed, and no behaviour with it. Reference gas is unchanged, and the script asserts it on BOTH engines before it prints a single timing (`number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 -> `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`), plus 15 further per-shape and per-sweep-point gas equalities between the two engines.

## 0.2.0

### Minor Changes

- 654bb91: `intrinsicGas()` gates EIP-3860 by fork, and the revm read engine admits `berlin`, `london` and `paris` again.

  `revm-wasm@0.3.1` fixes the upstream bug this repo filed as
  `wighawag/revm-wasm#4`: `CallExecutor::new` now rebuilds the gas-parameter table
  for the requested spec instead of leaving it pinned at the `Context::mainnet()`
  default, so revm no longer charges EIP-3860's initcode word cost on forks that
  predate Shanghai. That INVERTS the previous release's remedy. The two engines
  used to agree on a wrong number there; with revm fixed, the node was the only
  party still charging the term, and a CREATE-shaped `eth_estimateGas` differed by
  engine (default 53302 vs revm 53298 for a 64-byte initcode, where the protocol
  charges 53298). The fork gate that was the wrong fix against `0.3.0` is the
  required one against `0.3.1`.

  So `src/intrinsic-gas.ts` now takes the node's `Common` and charges the initcode
  word cost only where `common.isActivatedEIP(3860)` says the protocol does. The
  parameter is that `Common` ITSELF, not a hardfork name: `node.ts` hands the
  engine the very same instance through `ReadEngineContext.common`, so the caller
  that ADDS the intrinsic gas and the caller that SUBTRACTS it cannot name
  different forks — which is the drift that shared file exists to prevent. It is
  also the table `@ethereumjs/vm`'s `runTx` consults, so a deployment estimated on
  the read path is charged what this node's own transaction path spends on it.

  **Observable changes.** `eth_estimateGas` for a CREATE is unchanged on the fork
  the node runs (Cancun) and on Shanghai. `REVM_SPEC_BY_HARDFORK` is now
  `{berlin, london, paris, shanghai, cancun}` and `REVM_REFUSED_HARDFORKS` is
  `{prague, osaka}`; code reading either table sees the new contents, and the
  `PRE_EIP_3860` refusal text is gone. `revm-wasm` moves to `^0.3.1`. The revm
  engine now throws if `call()` is reached before `connect()` bound it to a node
  (it has no hardfork to cost against) — unreachable through `createNode()`.

  **Still refused, unchanged:** `prague` and `osaka`. Their refusal never depended
  on the upstream bug — revm enforces EIP-7623's calldata floor and EIP-7825's gas
  limit cap, neither of which this node's arithmetic implements — and both were
  re-measured on `0.3.1` rejecting the node's estimate and read budget exactly as
  before.

  ADR 0008 gains a second amendment recording the reversal, the evidence it rests
  on, and that `prague`/`osaka` are untouched. See
  `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and §6-§7
  of `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/measurements.md`.

## 0.1.0

### Minor Changes

- 6694ffc: Make the EVM behind the READ path swappable: `createNode({engine})`.

  `eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s gas estimation now run
  on an ENGINE rather than reaching `@ethereumjs/evm` directly. Supplying none
  keeps exactly today's behaviour — the default engine wraps the node's own
  `@ethereumjs/evm`, including the pure-read checkpoint/revert and the EIP-2929
  warm/access reset that keeps a repeated estimate for a warm SSTORE from coming
  back ~2000 gas too low.

  An engine is an INJECTED OBJECT (`ReadEngine`), never a name the core resolves,
  so the core imports no engine a consumer did not and a JS-only consumer pays
  nothing for one they never use. See
  `docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`.

  Everything an engine needs to keep a read pure is the ENGINE's business: the
  default engine checkpoints and resets warmth because `@ethereumjs/evm` requires
  it, and an engine that is structurally incapable of committing pays for neither.

  Scope, deliberately narrow: only READS are routed through the engine.
  Transactions still run on `@ethereumjs/vm`, which is why the active engine reads
  as `node.readEngine` (`{id: '@ethereumjs/evm'}` by default) rather than
  `node.engine` — a receipt can never be attributed to it.

  New exported types: `ReadEngine`, `ReadEngineContext`, `ReadEngineInfo`,
  `ReadCallRequest`, `ReadCallResult`. No new runtime dependency.

- 172d1ad: The revm read engine now runs reads against the node's REAL block environment,
  on `revm-wasm@^0.3.0`.

  `BASEFEE` inside an `eth_call` used to read `0` on `embedded-eth-node/revm` and
  the block's real value on the default `@ethereumjs/evm` engine: the zeroed base
  fee was the only way to keep a read from an unfunded address (`from` defaults to
  the zero address) from failing revm's transaction validation. `revm-wasm` now
  exposes the switches every real client uses to serve `eth_call`, so the engine
  passes the node's own base fee and `prevRandao` and turns the VALIDITY RULES off
  instead: `disableBaseFee`, `disableBlockGasLimit`, `disableEip3607`.

  Observable consequences, all of them removing a divergence between the two
  engines:
  - `BASEFEE` and `PREVRANDAO` inside a read now report the node's block on revm,
    as they always did on the default engine (`COINBASE`, `NUMBER`, `TIMESTAMP`
    and `GASLIMIT` already did).
  - `eth_call` / `eth_estimateGas` with `from` set to an address that HOLDS CODE
    now succeeds on revm (EIP-3607 is a rule about sending a transaction;
    `@ethereumjs/evm`'s `runCall` never enforced it). Smart-account, ERC-4337 and
    multicall-aggregator previews work on either engine.
  - A read's gas budget is no longer capped at the block gas limit on revm, so a
    call needing within intrinsic gas of the whole block limit no longer runs out
    of gas on one engine and completes on the other.
  - A read from an address holding no ether keeps working, which is what the
    zeroed base fee was buying.

  What is relaxed is a transaction's VALIDITY, never the VALUE TRANSFER: revm's
  `disableBalanceCheck` is deliberately left off, so an `eth_call` carrying more
  ether than the sender holds still fails on either engine, as it does on geth
  (`ErrInsufficientBalance`). A read never invents funds it can then report.

  The differential conformance battery grew two steps for the two divergences no
  gas bar can see: one that reads the block-environment opcodes THROUGH A CONTRACT
  and diffs them (gas is identical either way), and one that pins whether a
  value-bearing read succeeds or fails per sender (a rejected read charges no gas
  at all). Both run on both engines: in both state modes on the default engine, and
  in `stateMode:'none'` on revm, which refuses `'trie'` at construction.

- 52d03c6: The revm read engine refuses `berlin`, `london` and `paris` too: it now admits `shanghai` and `cancun` only.

  `src/intrinsic-gas.ts` adds EIP-3860's initcode word cost (`ceil(len/32) * 2`)
  to every CREATE with no hardfork gate, and EIP-3860 arrived in Shanghai. That
  was previously judged harmless because `revm-wasm` over-charges identically on
  the earlier forks, so the two engines agree and no cross-engine divergence
  reaches an estimate. Measured against the shipped artifact, the agreement is
  real and the conclusion was not: for a 64-byte initcode both sides charge 53296
  where the protocol charges 53292, so `eth_estimateGas` for a deployment on those
  forks over-charges by 2 gas per initcode word (3072 for a maximum-size initcode)
  against what this node's own `@ethereumjs/vm` transaction path spends. The node
  disagreed with itself, and an invariant that compares the node with revm could
  not see it.

  Gating the term would not have fixed it: the engine subtracts the node's
  intrinsic gas from what revm spent and the node adds the same number back, so a
  gate moves the default engine's estimate and cannot move revm's, turning an
  agreed wrong number into a cross-backend gas divergence. So the three forks are
  refused at construction instead, naming EIP-3860 and where the measurements are,
  and `intrinsicGas()` keeps its unconditional term — now true at every fork any
  part of this node can run.

  Nothing a consumer can reach changes: the node runs Cancun and exposes no
  hardfork option, so this is a guard that fires the day that moves.
  `REVM_SPEC_BY_HARDFORK` is now `{shanghai, cancun}` and `REVM_REFUSED_HARDFORKS`
  gains `berlin`, `london` and `paris`; code that reads either table sees the new
  contents.

  ADR 0008's admission rule is amended with it: agreement between the node and
  revm is necessary and NOT sufficient, because they share one intrinsic-gas
  answer by construction, so admission now also requires the protocol's agreement,
  judged by a witness that is neither of them (`@ethereumjs/common`'s EIP
  activation table, asserted per admitted fork in the test suite).

  See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
  measurements in
  `docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/`.

- f145bb5: Add `embedded-eth-node/revm`: a revm-wasm engine behind the node's READ path.

  ```ts
  import {createNode} from 'embedded-eth-node';
  import {createRevmEngine} from 'embedded-eth-node/revm';

  const node = await createNode({engine: await createRevmEngine({wasm})});
  ```

  `eth_call`, `eth_estimateGas` and `eth_fillTransaction`'s estimation then run on
  revm, returning the SAME results and the SAME gas as the default
  `@ethereumjs/evm` engine (`number()` 2446 execution gas, `sumTo(2000)` 498689,
  `keccakLoop(2000)` 1107052 — asserted, not asserted-about). Transactions are
  unchanged: they still run on `@ethereumjs/vm`, so a node with this engine runs
  two EVMs and `node.readEngine` says which one produced a read.

  The engine reads the node's OWN state, which stays authoritative — nothing is
  copied across, and a value written by a transaction is visible to the next
  `eth_call` with no sync step. It does that through `SimpleStateManager`'s public
  checkpoint stacks, the only synchronous view of the node's state that exists, so
  it serves `stateMode:'none'` ONLY and REFUSES `stateMode:'trie'` at construction
  with an error naming the reason (see
  `docs/adr/0005-revm-reads-the-nodes-state-through-simplestatemanagers-stacks.md`).
  An `eth_call` on it cannot mutate state: `Revm#call` cannot commit, and every
  write method on the state adapter throws.

  The wasm is whatever you have — bytes, a `URL`, a `Response` or a compiled
  `WebAssembly.Module` — passed straight through to `revm-wasm`, so a
  bundler-resolved asset and a runtime-fetched URL are the same code path. In
  Node, note that `revm-wasm/wasm-url` is a `file:` URL and Node's `fetch` cannot
  resolve that scheme: read the bytes and pass those.

  One engine instance serves ONE node. Handing an already-connected engine to a
  second `createNode()` is refused, because rebinding it would silently re-point
  the FIRST node's reads at the second node's state. Running several nodes means
  calling `createRevmEngine()` per node — pass each the same compiled
  `WebAssembly.Module` to compile the wasm only once.

  `revm-wasm` is a plain `dependency` rather than an optional peer, because a
  missing optional peer fails worse than the install costs. **A JS-only consumer
  pays install bytes and ZERO bundle bytes**: the core entry point never imports
  the subpath, and `packages/benchmarks` now ASSERTS the default entry's bundle
  size against a pinned baseline and that `revm-wasm` is absent from its dependency
  graph. (The default entry moved 412.3 KB -> 412.4 KB raw: that 0.1 KB is the new
  `getBlockHash` accessor in the node itself, not revm.)

  `ReadEngineContext` gains a `getBlockHash(blockNumber)` accessor (additive), so
  an engine can answer `BLOCKHASH` from the node's real blocks instead of
  silently answering zero.

- 322097e: Add `senderMode: 'recover' | 'trusted'` to skip ecrecover on a local chain.

  `ecrecover` is a fixed ~2ms per transaction and dominates small ones (~80% of a
  21k-gas transfer; EVM execution only overtakes it at ~33k gas of execution). A
  client that signed a tx already knows the sender, so re-deriving it on a local
  chain is pure waste.

  `senderMode: 'trusted'` (opt-in; default stays `'recover'`) enables
  `evm_sendRawTransactionAs` / `evm_sendRawTransactionSyncAs`, which take
  `[raw, from]` and pin the sender instead of recovering it. Measured ~13x on
  `runTx` in isolation, ~2.3x end-to-end through a viem-style client, and ~3.9x
  when the caller also skips signing (fabricated signature). Gas, status, logs,
  receipts and post-state are byte-identical to `'recover'`, asserted field by
  field in a new differential test.

  The primitive is just "execute as this sender, do not recover". It serves both an
  ordinary signed tx bypassing a redundant recovery and a higher layer implementing
  anvil-style impersonation on top with a fabricated signature. Impersonation
  itself is account policy and remains out of scope for this package.

  **`'trusted'` removes the only thing binding a tx to its sender**, so any caller
  can claim any address. It is gated behind an explicit option, the cheat methods
  throw `-32601` in the default mode, and it must never be exposed to untrusted
  callers. See the README section "Sender mode" for the full caller contract.

- f3dcc2d: The revm read engine admits only the hardforks it can COST: `prague` and `osaka` are now refused.

  `embedded-eth-node/revm` mapped seven hardfork names onto revm specs, but the
  node's shared intrinsic-gas arithmetic (`src/intrinsic-gas.ts`) implements the
  pre-Prague formula only, and revm enforces more than that from Prague onwards.
  Measured against `revm-wasm@0.3.0`, a call carrying 100 non-zero calldata bytes
  costs the node's arithmetic 22600 while revm demands EIP-7623's floor of 25000
  and rejects the difference outright with `GasFloorMoreThanGasLimit`. That is the
  `eth_estimateGas` failure this node exists to prevent: a client uses an estimate
  as the transaction's gas LIMIT, so an under-estimate is not a warning, it is an
  out-of-gas transaction.

  Osaka fails a second, independent way — EIP-7825 caps a transaction's gas limit
  at 16777216, below the node's default read budget of 30000000, so every ordinary
  `eth_call` there is rejected before the first opcode.

  So `createRevmEngine()` now refuses those two forks at construction, naming the
  EIP, the file that would have to change, and the ADR, exactly as it already
  refuses `stateMode:'trie'`. Nothing a consumer can reach changes today: the node
  runs Cancun and exposes no hardfork option, so this is a guard that fires the day
  that moves rather than letting an estimate go out that the engine which produced
  it would reject.

  Two new exports on the `embedded-eth-node/revm` subpath say which forks are
  served, in code rather than by triggering the refusal:
  `REVM_SPEC_BY_HARDFORK` (admitted) and `REVM_REFUSED_HARDFORKS` (refused, with
  the reason). The `eth_estimateGas` for a calldata-heavy call is now fed back to
  revm AS a gas limit under every admitted spec in the test suite, so re-admitting
  a fork without doing the costing work fails the build.

  See `docs/adr/0008-the-revm-engine-admits-only-hardforks-it-can-cost.md` and the
  measurements in `docs/spikes/prague-intrinsic-gas-floor-or-refuse/`.

- 7325bf1: Document the read-engine seam, and fail LOUDLY at its new edges.

  The engine seam is now a documented public feature: the README has a **Read
  engine** section beside the `stateMode` / `senderMode` ones (what an engine is,
  the default, how to opt into `embedded-eth-node/revm`, both wasm delivery shapes,
  which `stateMode` the revm engine serves, and the measured reason it exists), and
  the RPC-surface table says which methods route through the engine.

  The number published there is measured on **the node with the revm engine
  installed** (frame of 100 small view reads, 16.6 ms budget: 10.3 → 3.8 ms on
  Chromium, 13.0 → 4.0 ms on WebKit), not on the raw interpreters, because the
  node's own dispatch sits on top of the engine and a raw-engine figure would
  overstate what a consumer gets. Scope is stated plainly: reads only, transactions
  unchanged on `@ethereumjs/vm`.

  Three new loud failures, all at construction, none of which existed before:
  - An engine whose `connect()` throws — because it cannot initialise, or because
    it refuses this node's configuration — now fails `createNode()` with an error
    naming the engine and carrying the engine's own cause. There is deliberately NO
    fallback to the default `@ethereumjs/evm` engine: a node quietly running an
    engine you did not ask for works, returns correct results, and is an order of
    magnitude slower than you believe, with no signal at all.
  - A value passed as `engine` that is not a `ReadEngine` (missing `call`/`id`, or
    an un-awaited `createRevmEngine()` promise) is refused at construction, instead
    of surfacing as a `not a function` TypeError at the first `eth_call`.
  - `createWorkerNode({engine})` is refused with a real error explaining that the
    options are structured-cloned into the Worker and an engine is a
    function-bearing object, and pointing at the supported shape (build the engine
    inside your own worker module). Previously this produced an opaque
    `DataCloneError` from inside comlink. `WorkerNodeOptions['engine']` is now typed
    `never`, so TypeScript catches it at compile time too.

### Patch Changes

- 80d0954: Fix: a contract created at an address that already held storage no longer inherits it (`stateMode:'none'`).

  `@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage` as an empty no-op that also drops its `address` argument, while `@ethereumjs/evm` calls it on every contract creation precisely to guarantee a fresh contract starts with empty storage. In `stateMode:'none'` (the default) that meant a create landing on an address with pre-existing storage kept it: seed slot 0, deploy a `Counter` onto that address, and `number()` returned the seeded value instead of `0`, with a success receipt and no warning.

  The node now uses its own `SimpleStateManager` subclass which implements `clearStorage(address)`. Reported upstream with a reproduction; this override is what protects consumers meanwhile. It is a subclass rather than a dependency patch because a patch would fix only this repo's tests and leave every installed consumer exposed.

  `stateMode:'trie'` was already correct (its real `storageRoot` makes the EIP-7610 collision guard fire, so the creation is rejected rather than cleared). The two modes therefore differ on this case, deliberately and now asserted in the test suite: `'none'` clears and succeeds, `'trie'` rejects. Neither inherits. See ADR 0007 and the state-mode section of the README.

  Also in this release: `senderMode` is now forwarded across the comlink Worker boundary (`createWorkerNode(...).senderMode` previously read `undefined` on a property typed `'recover' | 'trusted'`), and two wall-clock test assertions that could flip on a loaded machine were replaced with load-invariant ones.

## 0.0.2

### Patch Changes

- f7fe263: Fix contradictory install instructions in README: `@ethereumjs/*` and `@noble/hashes` are direct dependencies (installed automatically), not peer deps. Only `comlink` is an optional peer dependency.

## 0.0.1

### Patch Changes

- first
