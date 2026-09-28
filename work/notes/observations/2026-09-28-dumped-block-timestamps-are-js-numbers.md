---
title: Dumped block timestamps are JS numbers, so a huge timestamp loses precision
date: 2026-09-28
status: open
---

Noticed while building `a-genesis-timestamp-option`. `SerializedBlock.timestamp` in `packages/webevm/src/types.ts` is a `number`, filled with `Number(block.header.timestamp)` in `src/node.ts` and read back with `BigInt(sh.timestamp)`. Both `blockEnv.timestamp` and the new `genesisTimestamp` are unbounded bigints, so a value above `Number.MAX_SAFE_INTEGER` is rounded on a `dumpState` / `loadState` round trip, and the reloaded block's hash then no longer matches the one its child names as parent. No real date is affected, and the `genesisTimestamp` JSDoc states the limit. Whether to refuse such values at construction, or to store the dumped timestamp as a string, is a separate decision.
