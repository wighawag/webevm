---
title: Show Hardhat and forge-std console.log calls made during execution
slug: solidity-console-log
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

> Tasked 2026-11-24. The decisions and their reasoning (observed never answered, the declared engine capability, the one observation field `recordedCalls` amending ADR 0006, the injected-object option and the worker host option, estimation, delivery timing and never-awaited callbacks) moved to `docs/adr/0018-console-log-is-observed-never-answered.md`; what to build moved to the tasks whose `spec:` is `solidity-console-log` in `work/tasks/`.

> Origin: the same request filed against tevm as evmts/tevm#2057 ("would be great if tevm had an option to show in the console the hardhat console.log calls"). tevm answered it in evmts/tevm#2096 with a zero-gas custom precompile at the console address; this spec deliberately does NOT copy that mechanism (see ADR 0018, "Observed, never answered").

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

## Out of Scope

- Exposing logs over RPC (Hardhat's `hardhat_setLoggingEnabled`, a `console_log` subscription over `serveOn`); a later follow-up if a remote consumer asks.
- General tracing (`debug_traceTransaction`, call traces). The seam opt-in records calls to one address only; it is not a tracer.
- Persisting logs, or reproducing them on `loadState` / reload.
- Hardhat's other network-level logging (printing every RPC method and transaction summary).
- Console logging on the revm engine, until a revm-wasm release carries outcome format 5: the follow-up task `console-log-on-the-revm-engine`, not missing work.
