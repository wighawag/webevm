# What `evm_snapshot` and `evm_revert` cost

Measured 2026-11-20 by `packages/webevm/test/snapshot-cost.spec.ts` (battery: `packages/webevm/test/helpers/snapshot-cost.ts`), through the public surface, default engine. Each row is a genesis of N accounts, each with a balance and one storage slot, plus four mined transfers; each of five rounds takes `evm_snapshot` and immediately `evm_revert`s to it, and the median is reported. Neither method executes anything, so the engine does not enter into it.

A snapshot is the node's `dumpState()` (plus the unfolded undo log, the pending transactions and the clock); a revert empties the state and `loadState()`s the dump, which with `computeStateRoot` also rebuilds the derived trie from the restored flat state. Both are therefore O(state), whatever changed since the snapshot.

## Chromium (Playwright, Desktop Chrome)

| accounts | computeStateRoot | dump (JSON bytes) | snapshot (ms) | revert (ms) |
|---:|:---:|---:|---:|---:|
| 100 | no | 50,352 | 0.3 | 1.3 |
| 1,000 | no | 391,088 | 3.3 | 5.1 |
| 10,000 | no | 3,802,088 | 27.9 | 44.6 |
| 50,000 | no | 18,962,088 | 145.3 | 258 |
| 100 | yes | 50,352 | 0.2 | 10.1 |
| 1,000 | yes | 391,088 | 2.3 | 122.1 |
| 10,000 | yes | 3,802,088 | 26.8 | 1460.5 |

## WebKit (Playwright, Desktop Safari; `performance.now()` is clamped to whole milliseconds there)

| accounts | computeStateRoot | snapshot (ms) | revert (ms) |
|---:|:---:|---:|---:|
| 100 | no | 1 | 1 |
| 1,000 | no | 3 | 4 |
| 10,000 | no | 28 | 30 |
| 50,000 | no | 149 | 163 |
| 100 | yes | 0 | 9 |
| 1,000 | yes | 3 | 105 |
| 10,000 | yes | 31 | 1263 |

## Reading it

- Both are linear in the state, about 3 ms (snapshot) and 4 to 5 ms (revert) per thousand accounts with one slot each, which is fine at the dev-chain sizes tests use (a deployment of a few contracts is well under a thousand entries).
- With `computeStateRoot` the revert is dominated by rebuilding the derived trie, about 120 to 150 ms per thousand accounts. That is the first thing a cheaper mechanism would remove: reverting over the `stateHistory` undo log (ADR 0013) would touch only the keys changed since the snapshot, and could update the derived trie from the same change sets.
- Memory: every snapshot held keeps its dump until a revert consumes it (the dump sizes above are the JSON serialisation, a fair proxy for the objects held).
