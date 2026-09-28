# What `stateHistory` costs, measured

Measured 2026-09-28 at commit `348f685` (the feature complete: undo log, historical `eth_call`, persistence) by [`measure-state-history-cost.mjs`](measure-state-history-cost.mjs) in this folder. Every number below is a line it printed; it exits non-zero if any of its own checks fails (every historical read is first checked to return block K's value, the node is checked to hold exactly N records, and the dump to carry them).

```sh
pnpm install   # also builds packages/webevm/dist, which the script reads
node --expose-gc --max-old-space-size=4096 docs/spikes/bounded-state-history-cost/measure-state-history-cost.mjs
```

Environment: Node v24.19.0, linux x64, AMD Ryzen 9 9955HX. This is V8 under Node, not a browser; the heap figures are V8's object sizes, which Chromium shares, and the timings are for reading as orders of magnitude and ratios between rows of the same run, not as a browser's milliseconds. Three runs agreed to within a few percent on every row the README quotes.

## The workload

One transaction per block, from one player, to a contract that writes M storage slots per block, 272 blocks (so a window of 256 is full and older records have been evicted). Two layouts:

- **`same`**: the SAME M slots get a new value every block (a board of M cells, every cell moving every block). Every recorded key holds an overwritten value.
- **`fresh`**: every block writes M slots nobody wrote before. Every recorded key holds "absent", and no key repeats across blocks.

Each block also records the 3 accounts the transaction touches (the node's own record of the block is counted, not assumed).

## 1. Memory, and what a dump carries

Each row is three fresh processes: history off, a window of 64, a window of 256. **Bytes per key per retained block** is the heap difference between the two windows divided by the 192 extra records' keys, so one-off allocations cancel. "History at N=256" is the N=256 node minus the node without history.

| M slots / block | keys / block (accounts + slots) | heap, off (MB) | heap, N=64 (MB) | heap, N=256 (MB) | history at N=256 (MB) | bytes / key / block in memory | bytes / key / block in dumpState |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 (same) | 3 + 1 | 9.46 | 9.64 | 10.00 | 0.54 | 467 | 201 |
| 10 (same) | 3 + 10 | 9.53 | 9.88 | 10.75 | 1.22 | 347 | 115 |
| 100 (same) | 3 + 100 | 9.57 | 11.55 | 17.49 | 7.92 | 300 | 81 |
| 1000 (same) | 3 + 1000 | 9.84 | 28.98 | 86.21 | 76.37 | 297 | 77 |
| 100 (fresh) | 3 + 100 | 17.86 | 18.25 | 19.22 | 1.36 | 49 | 79 |

Reading it:

- **About 300 bytes per changed key per retained block** when the key held a value before the block (the `same` rows converge on it from M = 100). Linear in keys: 10x the slots per block is 10x the memory.
- **About 50 bytes** when the key did not exist before the block (`fresh`): the record holds "absent", not a value.
- **A fixed part per retained block, well under 1 KB**, which is why the M = 1 row reads higher per key (467): (467 - 300) x 4 keys is about 0.7 KB per block.
- **In `dumpState` (what IndexedDB persistence stores), 77 to 200 bytes per key** as JSON hex; the per-block fixed part dominates at small M.

## 2. Per-block time

The node's time per block (send + mine, auto-mining), median over the last 256 blocks.

| M slots / block | ms / block, no history | ms / block, N=256 |
| --- | --- | --- |
| 1 (same) | 1.43 | 1.45 |
| 10 (same) | 1.58 | 1.55 |
| 100 (same) | 2.73 | 2.80 |
| 1000 (same) | 14.73 | 14.69 |
| 100 (fresh) | 2.60 | 2.66 |

No measurable per-block cost (the differences are within run-to-run noise): the record is taken at the write, where the key is already in hand (ADR 0013).

## 3. Historical reads

On a node with N = 256, median of 21, milliseconds, at K = head - d. "Keys recorded since K" is every record in blocks K+1..head; "distinct keys since K" is how many different keys those records name.

| M slots / block | d (blocks below head) | keys recorded since K | distinct keys since K | eth_call at K | eth_getStorageAt at K |
| --- | --- | --- | --- | --- | --- |
| 1 (same) | 0 | 0 | 0 | 0.043 | 0.006 |
| 1 (same) | 1 | 4 | 4 | 0.046 | 0.010 |
| 1 (same) | 16 | 64 | 4 | 0.043 | 0.007 |
| 1 (same) | 64 | 256 | 4 | 0.054 | 0.007 |
| 1 (same) | 256 | 1024 | 4 | 0.074 | 0.005 |
| 10 (same) | 0 | 0 | 0 | 0.025 | 0.005 |
| 10 (same) | 1 | 13 | 13 | 0.039 | 0.006 |
| 10 (same) | 16 | 208 | 13 | 0.043 | 0.006 |
| 10 (same) | 64 | 832 | 13 | 0.053 | 0.006 |
| 10 (same) | 256 | 3328 | 13 | 0.097 | 0.005 |
| 100 (same) | 0 | 0 | 0 | 0.025 | 0.004 |
| 100 (same) | 1 | 103 | 103 | 0.090 | 0.006 |
| 100 (same) | 16 | 1648 | 103 | 0.114 | 0.006 |
| 100 (same) | 64 | 6592 | 103 | 0.199 | 0.006 |
| 100 (same) | 256 | 26368 | 103 | 0.544 | 0.005 |
| 1000 (same) | 0 | 0 | 0 | 0.023 | 0.004 |
| 1000 (same) | 1 | 1003 | 1003 | 0.591 | 0.007 |
| 1000 (same) | 16 | 16048 | 1003 | 0.962 | 0.007 |
| 1000 (same) | 64 | 64192 | 1003 | 2.152 | 0.008 |
| 1000 (same) | 256 | 256768 | 1003 | 7.198 | 0.007 |
| 100 (fresh) | 0 | 0 | 0 | 0.023 | 0.004 |
| 100 (fresh) | 1 | 103 | 103 | 0.110 | 0.008 |
| 100 (fresh) | 16 | 1648 | 1603 | 1.306 | 0.010 |
| 100 (fresh) | 64 | 6592 | 6403 | 4.629 | 0.013 |
| 100 (fresh) | 256 | 26368 | 25603 | 20.038 | 0.149 |

The script's summary line: `historical eth_call: about 0.78 us per DISTINCT key changed since K (applied), about 0.03 us per further record of a key already applied (scanned)`.

Reading it:

- **A historical `eth_call` / `eth_estimateGas` costs in proportion to the keys changed since K**, in two terms: about **0.8 µs per distinct key** (each is applied as a state entry inside the call's checkpoint, then reverted), plus about **0.03 µs per further record** of a key already taken (the scan over blocks K+1..head). A game whose blocks rewrite the same cells pays mostly the second, small, term; one whose blocks write new keys pays the first. At the head (d = 0) it is an ordinary call.
- **A point read (`eth_getBalance`, `eth_getCode`, `eth_getStorageAt`, `eth_getTransactionCount`) looks its one key up** in the records from K+1 towards the head and stops at the first that names it, so it is microseconds when the key changes often and grows with d only for a key that has not changed since K (0.15 ms at d = 256 in the `fresh` row).
- `eth_estimateGas` at K applies K's state once for its whole search (decision 6 of `work/notes/observations/historical-eth-call-decisions.md`), so it pays the same entry cost once plus its probes.
