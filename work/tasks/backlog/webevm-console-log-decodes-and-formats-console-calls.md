---
title: webevm/console-log decodes and formats every Hardhat and forge-std console call
slug: webevm-console-log-decodes-and-formats-console-calls
spec: solidity-console-log
blockedBy: []
covers: [2, 3, 4, 5, 6]
---

## What to build

The new subpath `webevm/console-log`, exporting `consoleLog(options?)`: the injected object that `createNode({consoleLog: consoleLog()})` will take (wired by `console-log-delivered-from-transactions-and-eth-call`). This task builds everything that object owns, none of which is in the core graph:

- **The selector table**: the union of the function signatures in PINNED versions of Hardhat's `hardhat/console.sol` and forge-std's `src/console.sol` and `src/console2.sol`, plus, for every signature containing `uint256` or `int256`, its legacy alias spelled `uint` / `int` (old Hardhat versions compiled against those non-canonical selectors: `log(uint)`, `log(uint,string)`, `logUint(uint)`). Selectors are computed lazily on first use, not at import.
- **A small hand-written ABI decoder** for exactly the types those signatures use: `uint256`, `int256`, `bool`, `address`, `bytes1` to `bytes32` (static words), `string` and `bytes` (dynamic). No ABI library: the package has none and gains none for this (ADR 0018).
- **A browser-safe formatter** in the style of Node's `util.format` (no `node:util`): when the first argument is a `string` it is a format string honouring `%s`, `%d`, `%i`, `%o`, `%O` and `%%`, as Hardhat prints it; remaining arguments are appended space-separated. Addresses render checksummed, integers in full decimal (never through a lossy JS number), bytes as `0x` hex, booleans as `true` / `false`.
- **Decoding one recorded call** (the input bytes of one frame into the console address) into `{args, message}`: `args` the decoded values in order (integers as `bigint`, addresses as checksummed hex strings, bytes as `0x` hex strings, strings and booleans as themselves), `message` the formatted text; for malformed input (an unknown selector, a short or corrupt payload, an out-of-range offset or length) it returns nothing and never throws.
- **The sink**: by default an entry is printed through the host's `console.log`, prefixed `[webevm console.log]`; `consoleLog({onLog})` replaces that with the consumer's function.

The node-facing members of the returned object (the decode and the sink, at least) are typed and exported from the subpath as the contract the next task consumes; their exact shape is this task's to choose, documented in the module's JSDoc. Define the FULL entry type here too (`{args, message, source}` plus the `'transaction'` fields `txHash`, `blockNumber`, `blockHash`, `txIndex`, with `source` one of `'transaction' | 'eth_call' | 'eth_estimateGas' | 'eth_fillTransaction'`); the core imports it by type only. Do NOT edit `src/types.ts` in this task: `the-engine-seam-records-calls-to-an-address` edits it in parallel. `./console-log` is added to the package's `exports` map; the default entry does not import it.

## Acceptance criteria

- [ ] The three source files are vendored as test fixtures at pinned versions (licences kept), with their source URL, tag or commit and retrieval date recorded in the fixtures README, as `GeneralStateTests/` is.
- [ ] A test parses every function signature out of the vendored files, computes its selector and its legacy `uint` / `int` alias where one exists, and asserts the table decodes each; the table contains nothing that is neither.
- [ ] Each argument type decodes correctly, including multi-argument overloads up to four arguments mixing `uint256` / `string` / `bool` / `address`, `int256` negatives, empty and long `string` / `bytes`, and `bytes1` to `bytes32`; typed `logUint` / `logInt` / `logString` / `logBool` / `logAddress` / `logBytes` / `logBytesN` too.
- [ ] Format strings follow Hardhat's output for each specifier and for surplus and missing arguments; integers beyond 2^53 print exactly; addresses are checksummed.
- [ ] Malformed input (unknown selector, truncated head, dynamic offset or length past the end, fewer than four bytes) yields nothing and throws nothing.
- [ ] The default sink prints the prefixed message through `console.log`; `onLog` replaces it.
- [ ] `import {consoleLog} from 'webevm/console-log'` resolves from the built package; the default-entry size assertion in `packages/benchmarks/test/evm.spec.ts` is unchanged by this task (the subpath is not in the core graph).
- [ ] A changeset (minor: a new subpath).

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm (`packages/webevm`), adding a new subpath module beside `src/revm.ts`, which is the model of a subpath kept out of the default entry (its header explains how, and `packages/benchmarks/test/evm.spec.ts` asserts it). Read `docs/adr/0018-console-log-is-observed-never-answered.md` (why the decoder lives in an injected object from a subpath, the entry shape `{args, message, source}`, why malformed calldata is ignored). The console address is `0x000000000000000000636F6e736F6c652e6c6f67`; this module decodes the calldata of calls to it and never sees an address.

Fetch the three Solidity files from their upstream repositories (Hardhat's `hardhat/console.sol` from the `NomicFoundation/hardhat` repository, forge-std's `src/console.sol` and `src/console2.sol` from `foundry-rs/forge-std`) at their latest release tags, vendor them under `test/fixtures/` and record the pins. Keccak and checksumming are available through dependencies the package already has (`@ethereumjs/util`, `@noble/hashes`); ask before adding any other dependency. Tests follow the repo's Playwright browser-spec style (`test/*.spec.ts` with helpers in `test/helpers/`); a pure decoding test needs no node.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
