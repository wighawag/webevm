---
title: Show Hardhat and forge-std console.log calls made during execution
slug: solidity-console-log
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

> Origin: the same request filed against tevm as evmts/tevm#2057 ("would be great if tevm had an option to show in the console the hardhat console.log calls"). tevm answered it in evmts/tevm#2096 with a zero-gas custom precompile at the console address; this spec deliberately does NOT copy that mechanism (see Implementation Decisions, "observe, never answer").

## Problem Statement

Solidity developers debug with `console.log`: Hardhat's `hardhat/console.sol` and forge-std's `console.sol` / `console2.sol`, which all `STATICCALL` the fixed address `0x000000000000000000636F6e736F6c652e6c6f67` with the ABI-encoded arguments. On Hardhat, anvil and `forge test`, the node watches for those calls and prints them. On webevm nothing happens: the call goes to an empty account, returns nothing, and the message is lost, so a contract that is debugged with `console.log` everywhere else is opaque here. That matters more as webevm becomes the in-process chain for deploy tools (rocketh's `memory` runs, the `@webevm/devnode` layer, spec `dev-node-package`): deployment scripts and constructors routinely log, and the user gets silence.

## Solution

An opt-in console-log capability on the node. When it is enabled, every call made through Hardhat's or forge-std's console libraries during execution (a mined transaction, an `eth_call`, and, only when asked, the first execution of an estimation) is decoded and delivered, in execution order, to the host console by default and to any `node.onConsoleLog(cb)` subscriber as a structured entry: the decoded arguments, the formatted message, and where it came from (`'transaction'`, `'eth_call'`, `'eth_estimateGas'` or `'eth_fillTransaction'`, plus the transaction hash, block number, block hash and index for a mined transaction).

Enabling it changes NOTHING about execution: same return data, same gas, same receipts, same state root, on both engines. A node that does not enable it pays nothing and behaves exactly as today. It works on the main thread and across the Worker boundary, and through `@webevm/devnode`'s wrapper.

## User Stories

1. As a Solidity developer, I want `console.log("x is", x)` in my contract to appear in the browser console when a transaction runs on webevm, so that I can debug it the way I do on Hardhat or anvil.
2. As a developer using forge-std, I want `console.log` and `console2.log` from forge-std to work too, so that one contract debugs the same under `forge test` and in-process.
3. As a developer on old Hardhat versions, I want logs compiled against the legacy non-canonical selectors decoded as well (every signature containing `uint256` / `int256` spelled `uint` / `int`, for example `log(uint)`, `log(uint,string)`, `logUint(uint)`), so that older contracts and artifacts still log.
4. As a developer, I want every console.sol overload decoded: up to four `uint256` / `string` / `bool` / `address` arguments in any combination, `int256`, `bytes`, `bytes1` to `bytes32`, and the typed `logUint` / `logInt` / `logString` / `logBool` / `logAddress` / `logBytes` / `logBytesN` functions, so that no log is silently dropped.
5. As a developer, I want a first `string` argument treated as a format string (`%s`, `%d`, `%i`, `%o`, `%O`, `%%`), as Hardhat prints it, so that `console.log("balance %s of %s", bal, who)` reads as intended.
6. As a developer, I want addresses printed checksummed, integers printed in full decimal (never as a lossy JS number), and bytes as `0x` hex, so that what I read is what the contract held.
7. As a developer, I want logs from `eth_call` too, so that I can debug a view function without sending a transaction.
8. As a developer, I want logs emitted inside a call frame that later reverts (or a transaction that reverts as a whole) still delivered, as Hardhat and anvil deliver them, so that I can see what happened right up to the revert, which is when I need it most.
9. As a developer, I want each entry to say where it came from (its source, and for a mined transaction its hash, block number, block hash and index in the block), so that I can tell which transaction printed what when many run.
10. As a developer, I want to choose where logs go (a custom sink, or a subscriber via `node.onConsoleLog(cb)` returning an unsubscribe, like `onNewHead`), so that a dev tool can show them in its own panel or a test can assert on them.
11. As a test author, I want structured entries (decoded argument values plus the formatted message), so that I can assert on a value without parsing text.
12. As a Worker user, I want to enable console logging in my worker module (`exposeNode({createConsoleLog: () => consoleLog()})`, shaped like `createEngine`) and have the entries reach my subscriber on the main thread, the same way `onNewHead` does, so that hosting off the main thread does not lose them.
13. As a `@webevm/devnode` user, I want the wrapped node to forward `onConsoleLog` unchanged, so that logs work through the dev layer.
14. As a consumer who wants correct gas, I want enabling console logging to change neither gas nor return data nor receipts nor state, so that the gas I measure with logging on is the gas the transaction costs on a real chain (where nothing sits at the console address).
15. As a consumer who does not enable it, I want zero cost and zero behaviour change, so that the feature is free until I ask for it.
16. As a consumer, I want malformed console calldata (an unknown selector, a short or corrupt payload) ignored rather than thrown, and a sink that throws not to break execution, so that a debugging aid can never fail a transaction.
17. As a revm-engine user, I want a clear construction-time refusal if console logging is not yet supported on that engine, naming what is missing, rather than a node that silently prints nothing, until the upstream revm-wasm capability lands.
18. As a maintainer, I want a dumped and reloaded chain not to replay or persist logs, so that console logging stays an observation of execution, not part of the chain's state.
19. As a developer, I want `eth_estimateGas` (and `eth_fillTransaction`, which runs the same search) to print nothing by default (viem estimates before nearly every send, and the binary search re-executes up to ~20 times), with an opt-in to see the logs of its first execution only, so that every transaction's output is not doubled or multiplied.
20. As a Worker user, I want `createWorkerNode({consoleLog: ...})` refused with a message telling me to enable it in the worker module, as `engine` is refused there, so that I never get an opaque `DataCloneError`.
21. As a consumer, I want `onConsoleLog` on a node created without console logging to throw, naming the option, so that subscribing to a feature I forgot to enable is not silent.

### Autonomy notes

- `humanOnly`: omitted. Straightforwardly agent-taskable.
- `needsAnswers`: omitted. The four launch questions (option shape, default sink, estimation, revm dependency) were answered by the maintainer on 2026-11-24 by taking the recommendation on each; the answers are recorded under Implementation Decisions.

## Implementation Decisions

- **Observe, never answer.** The console address holds no code on any real chain, so a call to it costs the cold (or warm) account access and returns empty data. tevm's approach (evmts/tevm#2096) installs a zero-gas custom precompile there, which makes the address warm by construction (precompiles are pre-warmed under EIP-2929) and so changes gas versus a real chain, and it changes `eth_estimateGas` with it. webevm observes call frames instead and leaves execution untouched, which is what keeps story 14 true and keeps the conformance battery's byte-identical gas meaningful.
- **The engine reports raw calls; the node (or the injected decoder) decodes.** Decoding lives in ONE place above the engine seam. The seam gains an opt-in on the neutral request (read and transaction alike) asking the engine to record the input bytes of every call frame whose CODE ADDRESS is the console address, in execution order, whatever the frame's outcome, and the results carry that list. Both engines match the same way: CALL, STATICCALL, DELEGATECALL and CALLCODE into the address are recorded; CREATE never is; a frame refused before it runs (depth over 1024, a value the caller cannot afford) is not recorded.
- **The capability is declared on the engine, and `connectEngine` enforces it.** An engine written against today's `Engine` interface would ignore both the request opt-in and any context field, and the node would come up printing nothing, so the refusal cannot be left to the engine. `connectEngine` refuses an engine that does not declare the capability when console logging is enabled, naming the engine id (ADR 0006 amendment 2's rule: a capability the node cannot supply is refused at construction). When observation was requested, the result field must be present (possibly empty); if it is absent the node throws rather than deliver nothing. `webevm/revm` declares the capability only when its artifact's outcome format is 5 or higher, checked at connect, not at the first call.
- **The seam field is an observation, not receipt data.** `TransactionResult` is documented as everything a receipt needs and nothing else (ADR 0006 amendment 1). The ADR for this spec amends ADR 0006 and the `TransactionResult` / `ReadCallResult` docs to admit ONE non-receipt observation field, optional and present only when requested, named so it cannot be confused with EVM event `logs` (`recordedCalls`, matching revm-wasm).
- **`@ethereumjs/evm` side:** the EVM's `beforeMessage` event (present in `@ethereumjs/evm` 10.1.2, `dist/esm/evm.js`) sees `message.codeAddress` (which falls back to `to`) and `message.data` for every frame, top-level and nested, before the frame's checkpoint, so frames that later revert are seen; the listener is attached only while a request asked for observation, so a node without console logging pays nothing.
- **revm side:** needs an upstream capability in `wighawag/revm-wasm`: a per-call opt-in that records the input of every call frame targeting a given address, returned on the outcome. That is separate work in the revm-wasm repo (session `revm-wasm/call-recorder`, started 2026-11-24). Its approved design: `recordCallsTo?: Address` on `ExecuteOptions`, flag bit 9, outcome `recordedCalls?: Uint8Array[]` in outcome format v5 (the section is present only when requested), hooked in `FixedPrecompiles::run` rather than an inspector and matched by code address. An older artifact is refused at call time. The webevm engine passes the console address as `recordCallsTo` and reads `recordedCalls`. This spec does NOT wait for it: the `@ethereumjs/evm` half ships first, and until the capability lands the revm engine REFUSES a console-log-enabled node at `connect`, naming the missing capability. A follow-up task lifts the refusal and runs the same battery on revm once a revm-wasm release carries it.
- **Decoder:** a selector table that is the union of the signatures in PINNED versions of `hardhat/console.sol` and forge-std `src/console.sol` / `src/console2.sol` (vendored as test fixtures, licences kept), plus the legacy alias of every signature containing `uint256` / `int256` written as `uint` / `int`; a small hand-written ABI decoder for exactly those types (static words, `string`, `bytes`), since the package has no ABI library today and should not gain one for this; a browser-safe `util.format`-style formatter (no `node:util`). Built lazily on first use.
- **Option shape (decided):** an injected object from a new subpath, `createNode({consoleLog: consoleLog()})` with `import {consoleLog} from 'webevm/console-log'`, the same idiom as the engine (ADR 0006), so the selector table, the decoder and the formatter cost the default entry nothing. The seam plumbing, the `beforeMessage` wiring and `onConsoleLog` do live in the core graph, so the task re-pins the default-entry baseline in `packages/benchmarks/test/evm.spec.ts` with the measured delta. `./console-log` is added to the package's `exports` map. Not a `consoleLog: true` flag.
- **Workers (decided at review):** `WorkerNodeOptions.consoleLog` is typed `never` and refused at runtime with a message, in the style of the `engine` refusal in `worker-client.ts` (a function-bearing object cannot be structured-cloned). A Worker node enables console logging inside its worker module through a `createConsoleLog` host option on `exposeNode`, shaped like and refused like `createEngine` (a misuse is a value with both signals, never a module-scope throw). Its default sink prints to the worker's console; a custom `onLog` runs only on the thread that built the node; main-thread consumers get entries through `onConsoleLog`, which crosses as a comlink proxy like `onNewHead`. This does not depend on the `worker-host-takes-a-node-factory` task; if both land, a factory-built node receives the console-log option merged in, as it receives the engine.
- **Default sink (decided):** once enabled, every entry is printed through the host's `console.log`, prefixed (e.g. `[webevm console.log]`), unless the consumer passes its own sink, `consoleLog({onLog})`. `node.onConsoleLog(cb)` delivers structured entries on top, to any subscriber, whatever the sink.
- **Estimation (decided):** `eth_estimateGas` emits nothing by default; `consoleLog({estimateGas: 'first'})` (name to settle in tasking) emits the logs of the first execution only (the top probe of the search), tagged `source: 'eth_estimateGas'`. Never every execution. `eth_fillTransaction` follows the same setting, tagged `source: 'eth_fillTransaction'`.
- **Entry shape:** `{args, message, source}`, `source` one of `'transaction' | 'eth_call' | 'eth_estimateGas' | 'eth_fillTransaction'`; `'transaction'` entries also carry `txHash`, `blockNumber`, `blockHash` and `txIndex`. A transaction's source is `'transaction'` whichever path mined it (automine, `mine()`, `evm_mine`, interval mining), since in manual or interval mining it executes inside the mine, not in the RPC method that submitted it.
- **Delivery timing:** the node delivers entries after the engine returns, never from inside the EVM. For mined transactions they are buffered per block and emitted once the block is stored, in transaction order, before the `onNewHead` emit, so an entry never names a block that a failed batch never stored. For reads they are emitted before the result is returned or the revert error is thrown.
- **Delivery and ADR 0012:** `onConsoleLog(cb) => unsubscribe` is a new `SlimNode` member and crosses comlink exactly as `onNewHead` does (`worker-host.ts`, `worker-client.ts`). The sink and subscribers are called synchronously and NEVER awaited; a throw or a rejected promise is caught and reported once through `console.error`. A callback may issue node requests, which queue behind the current one (ADR 0012). On a node created without console logging, `onConsoleLog` throws, naming the option.
- Likely ADR: "console.log is observed, never answered" (the precompile-versus-observer decision, the declared capability, and the seam's one observation field, amending ADR 0006).

## Testing Decisions

- External behaviour through the public surface, like the existing Playwright browser specs: deploy a fixture contract that calls console.log in its constructor, in a transaction, in a view, inside a reverting subcall, and with each argument shape; assert the entries a subscriber receives (values, formatted message, source, tx hash).
- Gas and outcome identity: the same transactions with console logging on and off give identical receipts, gas, return data and state; and with it on, `eth_estimateGas` returns what it returns with it off.
- Decoder unit tests that compute every selector from the vendored, pinned console.sol / console2.sol files (plus their legacy `uint` / `int` aliases), and malformed input.
- Engine parity: an engine-parameterised test asserts the same recorded list on both engines (once revm supports it), including a DELEGATECALL into the console address.
- Worker: a subscriber on the main thread receives logs from a worker node enabled with `createConsoleLog`; `createWorkerNode({consoleLog})` is refused with the message; a bad `createConsoleLog` rejects the main thread instead of hanging it.
- Re-entrancy: an `onConsoleLog` callback that issues a node request, added to `test/helpers/concurrency.ts` (ADR 0012).
- Seam: an engine that does not declare the capability is refused at construction when console logging is on; an engine that declares it but omits the result field makes the request throw.
- revm: the construction-time refusal while the upstream capability is missing; later (follow-up task) the same battery on revm.
- Fixture bytecode is committed precompiled, as the existing fixtures are (no solc at test time).

## Out of Scope

- Exposing logs over RPC (Hardhat's `hardhat_setLoggingEnabled`, a `console_log` subscription over `serveOn`); a later follow-up if a remote consumer asks.
- General tracing (`debug_traceTransaction`, call traces). The seam opt-in records calls to one address only; it is not a tracer.
- Persisting logs, or reproducing them on `loadState` / reload.
- Hardhat's other network-level logging (printing every RPC method and transaction summary).
- Console logging on the revm engine, until a revm-wasm release carries outcome format 5: a named follow-up backlog task, not missing work.

## Sequencing notes

- The task that forwards `onConsoleLog` through `wrapDevNode` is blocked by `devnode-package-dev-accounts-funded-at-genesis` (the devnode package does not exist yet); if the core task lands first, the devnode package task must include the member, because `wrapDevNode` returns `Required<SlimNode>` and a missing member is a compile error.
- The revm follow-up is blocked on a published revm-wasm release with outcome format 5 (work in progress in the revm-wasm repo, see the revm bullet above).

## Further Notes

- Address: `0x000000000000000000636F6e736F6c652e6c6f67` is the ASCII of `console.log`, shared by Hardhat's console.sol and forge-std's console / console2.
- The upstream revm-wasm capability would also be the natural foundation for a later tracer, but that is not a reason to widen it now.
