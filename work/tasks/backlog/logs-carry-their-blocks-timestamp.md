---
title: Every RPC log carries its block's timestamp (blockTimestamp)
slug: logs-carry-their-blocks-timestamp
blockedBy: []
covers: []
---

## What to build

Every log the node serves over RPC carries `blockTimestamp`: the timestamp of the block the log is in, as a hex quantity (the `numHex` encoding of every other quantity on a log), equal to that block's `timestamp` from `eth_getBlockByNumber` / `eth_getBlockByHash`. This applies to the logs `eth_getLogs` returns and to the logs inside `eth_getTransactionReceipt` (and the receipt `eth_sendRawTransactionSync` returns) alike.

Why: execution-apis#639 put `blockTimestamp` on the log object, and geth (>= 1.16), reth, besu, erigon, anvil and Hardhat's EDR (>= 0.20) all serve it. Consumers have started to rely on it: etherfold, the indexer stratagems runs over an in-tab webevm chain, refuses a log without it (`TimestamplessLogError`), so nothing gets indexed. Measured from stratagems on 2026-10-27: absent in the published 0.6.0, 0.7.0 and 0.8.0.

Where: every RPC log goes through one function, `logToRpc` in `src/node.ts`, which writes `blockNumber` and `blockHash` but not `blockTimestamp`. The node keeps every block it has mined or loaded (the block store), so the timestamp of a log's block is at hand.

Scope:

- `blockTimestamp` on every served log, from both RPC paths, for logs in several different blocks.
- It survives a persistence reload (IndexedDB, a real page reload) and a `dumpState` / `loadState` round trip. If the persisted `SerializedLog` shape changes, a dump written without the new field must still load and still answer with the timestamp.
- Where the conformance battery checks the log metadata the node owns (block hash, number, transaction index), it checks `blockTimestamp` too, so both engines are held to it.
- No change to how blocks are stamped.

## Acceptance criteria

- [ ] Every log from `eth_getLogs` and from a receipt has `blockTimestamp`, a hex quantity equal to its block's `timestamp` from `eth_getBlockByNumber` and `eth_getBlockByHash`, for logs spread over several blocks with DIFFERENT timestamps (so a wrong block's timestamp would be caught).
- [ ] The same holds after a `dumpState` / `loadState` round trip, and after a real page reload with IndexedDB persistence.
- [ ] A dump without any per-log timestamp loads and answers with `blockTimestamp`; the decision between storing it on `SerializedLog` and looking it up from the block is recorded with its reason.
- [ ] The conformance battery (both engines) asserts `blockTimestamp` on its node-owned log metadata step.
- [ ] A `minor` changeset.
- [ ] The full verify (`pnpm format:check && pnpm build && pnpm test`) is green on chromium and webkit.

## Blocked by

None: can start immediately.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): if logs already carry `blockTimestamp`, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record (a `## Decisions` block in the done record is fine). At least: a `SerializedLog` field versus a lookup at serve time, and what that means for dump compatibility.

You are working in webevm (`packages/webevm`), an in-browser EIP-1193 Ethereum node with two engines (the default `@ethereumjs/evm` and revm through `webevm/revm`). The log's block metadata is written by the node, not by the engine (see where a mined block's `SerializedLog`s are built and `logToRpc`). Test through the public surface with the harness pattern in `test/helpers/cut.ts` (a mode per battery, a spec per cut, shared assertions in a `*-expected.ts`); `test/genesis-timestamp.spec.ts` and `test/persistence-reload.spec.ts` are the patterns. Block timestamps are whole wall-clock seconds and can repeat across blocks (`work/notes/observations/2026-09-28-mined-block-timestamps-are-not-strictly-increasing.md`), so force distinct ones in the test.

Command cost rules: put `timeout` in front of any shell command whose cost you have not reasoned about and cap output with `head`; never run an unbounded regex over `dist`, `node_modules`, `.git`, wasm or minified files. No em dash characters in anything you write. Markdown prose is one line per paragraph. Done means: the acceptance criteria pass, the full playwright suite is green on chromium and webkit, and prettier is clean.
