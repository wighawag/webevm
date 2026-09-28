---
title: Mined block timestamps are not strictly increasing
date: 2026-09-28
status: open
---

Noticed while scoping `a-genesis-timestamp-option`. Without `blockEnv.timestamp`, a mined block is stamped with `Math.floor(Date.now() / 1000)` (`executeAndMine` in `packages/webevm/src/node.ts`), with no reference to its parent. So two blocks mined in the same second (routine with auto mining, one block per transaction) carry the SAME timestamp, and a clock that steps back (or a future `genesisTimestamp`) can make a block older than its parent. Post-merge Ethereum requires `timestamp > parent.timestamp`, and a contract measuring elapsed time through `block.timestamp` sees 0 between such blocks. With `blockEnv.timestamp` set, every mined block carries that one constant by design (it replays a single GeneralStateTest `env`), which is also not strictly increasing. Other dev nodes (anvil, hardhat) stamp `max(wall clock, parent + 1)` and offer `evm_setNextBlockTimestamp` / `evm_increaseTime`; this node has neither cheat. Worth deciding whether mined blocks should be `max(wall clock, parent + 1)` by default, and whether the time cheats belong here.
