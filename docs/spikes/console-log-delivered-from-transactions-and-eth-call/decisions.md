# Decisions: console-log-delivered-from-transactions-and-eth-call

In-scope choices made while wiring `createNode({consoleLog})` (ADR 0018), recorded here because the task left them open. Each names what it touches. Dated 2026-11-24.

## 1. A `consoleLog` option that is not the object `consoleLog()` returns is refused at construction

Chosen: `createNode` checks that `consoleLog`, when present, is an object with `decode` and `sink` functions, and throws otherwise, naming the subpath and the call (`validateConsoleLog` in `packages/webevm/src/node.ts`). Passing the function itself gets "call it: consoleLog()". Why: without it, `consoleLog: true` (the flag ADR 0018 rejected) or a forgotten call brings up a node that requires call recording and then fails inside the delivery that is never allowed to fail anything, so it would log nothing. Alternative: no check (the type already forbids it). Touches: a NEW construction-time refusal; nothing else reads the option.

## 2. `dispose()` drops subscribers, not the sink

Chosen: `dispose()` clears `onConsoleLog` subscribers exactly as it clears `onNewHead`'s, and the sink keeps printing for any request still served afterwards (dispose does not stop requests; see the comment above the node's public surface). Alternative: also silence the sink, which would make `dispose` mean something new for this one feature. Touches: only `dispose`.

## 3. The worker client's `onConsoleLog` refuses without calling the worker; the host still forwards

Chosen as the task specified; the message names the option and says to use `createNode` for now. The host's proxy forwards `onConsoleLog` like `onNewHead` (`Required<SlimNode>` demands it). Replaced by `console-log-in-a-worker`.

## 4. The re-entrancy case runs on the default engine only, for now

`test/helpers/concurrency.ts` is engine-parameterised and `revm-concurrency.spec.ts` runs it on `webevm/revm`, which a console-logging node refuses until `console-log-on-the-revm-engine`. So `onConsoleLog-calls-back` reports a fixed "not on this engine" string there, asserted in `test/concurrency-expected.ts` by engine id; that task flips the revm expectation.

## 5. `@webevm/devnode` gains the delegating member with a minor changeset, and its peer range is unchanged

`wrapDevNode` must have the member to compile (`Required<SlimNode>`). Its peer range stays `webevm >=0.10.0`: on a 0.10 webevm the delegating `onConsoleLog` throws a TypeError when called, which is no worse than the throw it gets on any node without console logging, and raising the range would bump devnode through the peer rule in CONTEXT.md's conventions for a member nobody on 0.10 can use. Its tests are `devnode-forwards-on-console-log`'s.

## 6. A decoder that throws is treated as malformed input

The decoder never throws by contract; the node still wraps `decode` and skips an entry whose decode throws, rather than failing the request, since a debugging aid must never fail a transaction (ADR 0018).
