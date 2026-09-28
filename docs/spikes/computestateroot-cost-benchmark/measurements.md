# What `computeStateRoot: true` costs over a plain node

Task: `computestateroot-cost-benchmark` (spec `trie-mode-derives-its-root-from-the-flat-state`, story 7). Measured 2026-09-28 on `c438bb4` plus this change, AMD Ryzen 9 9955HX (16 cores, load average about 3 during the runs), Playwright 1.60.0 (Chromium and WebKit builds it pins), Node 24.19.0.

## How to reproduce

```sh
pnpm install && pnpm build
pnpm --filter webevm-benchmarks exec playwright test --project=chromium   # or --project=webkit
```

The figures are printed by the last test in `packages/benchmarks/test/evm.spec.ts`, `computeStateRoot cost (REPORTED, not asserted)`. They come from two sources:

1. **Two new scenario rows**, `webevm-computestateroot` and `webevm-revm-engine-computestateroot`: the `webevm` and `webevm-revm-engine` rows with `computeStateRoot: true` added and nothing else, on the same scenario (deploy a Counter, 20 signed `increment()` transactions, reads). Auto-mine puts one transaction in each block, so `callAvg` is per transaction AND per block, for a block that changes one storage slot (plus the sender, the contract and the coinbase accounts).
2. **A root-update measurement** (`packages/benchmarks/test/helpers/root-update.ts`), on each engine: two nodes identical but for `computeStateRoot` mine the same blocks, each block one transaction rewriting K slots of one contract with a new value, K in 1, 10, 100, 300, 1000. 3 warm-up blocks and 9 measured blocks per size, interleaved between the two nodes; medians. The delta is what the option added to the block. Independently, on the root-computing node, K `evm_setStorageAt` cheats (untimed) are followed by one timed `getStateRoot()`, which is the root update and nothing else (the same `currentStateRoot` a mined block runs). The send path is the fabricated-signature one (no secp256k1), so the baseline under the delta is as small as possible; the delta does not depend on it.

Timer resolution: Chromium here reports 0.1 ms steps (the page is not cross-origin isolated), WebKit clamps to 1 ms. Rows under a few ms are quantised, WebKit's especially; the `getStateRoot` mean column is the one to read there.

## 1. The scenario rows (ms, medians of 7 repeats)

Chromium:

| engine | coldStart | deploy | callAvg (per tx = per block) | read | frame (100 reads) |
|---|---|---|---|---|---|
| default, plain | 0.60 | 1.90 | 1.19 | 0.10 | 5.30 |
| default, `computeStateRoot` | 0.80 | 2.00 | 1.45 | 0.10 | 5.40 |
| revm, plain | 0.60 | 1.30 | 0.64 | 0.00 | 1.80 |
| revm, `computeStateRoot` | 0.80 | 1.60 | 0.90 | 0.10 | 1.70 |

WebKit (1 ms clamp):

| engine | coldStart | deploy | callAvg | read | frame |
|---|---|---|---|---|---|
| default, plain | 1.00 | 3.00 | 1.45 | 0.00 | 8.00 |
| default, `computeStateRoot` | 1.00 | 3.00 | 1.75 | 0.00 | 8.00 |
| revm, plain | 2.00 | 5.00 | 0.85 | 0.00 | 2.00 |
| revm, `computeStateRoot` | 2.00 | 2.00 | 1.05 | 0.00 | 2.00 |

Reading it: the per-transaction (per-block) cost of a one-slot block rises by **about 0.25 ms on both engines** (0.26 ms default, 0.26 ms revm on Chromium; 0.30 / 0.20 ms on WebKit). The read rows (`read`, `frame`) do not move: no opcode pays anything, because no engine reads the trie. MGas/s is unchanged on both engines (37-38 / 23 MGas/s default, 554 / 443-461 MGas/s revm). The gas gate holds: both new rows charge exactly the gas of every other backend.

## 2. The root update vs slots changed per block

Chromium:

| engine | slots | plain block | root block | delta | µs / slot | `getStateRoot()` median / mean |
|---|---|---|---|---|---|---|
| default | 1 | 0.30 | 0.60 | 0.30 | (quantised) | 0.10 / 0.10 |
| default | 10 | 0.40 | 1.30 | 0.90 | 90 | 0.70 / 0.68 |
| default | 100 | 1.50 | 10.70 | 9.20 | 92 | 9.00 / 9.07 |
| default | 300 | 3.70 | 34.10 | 30.40 | 101 | 30.40 / 30.54 |
| default | 1000 | 11.30 | 128.40 | 117.10 | 117 | 116.20 / 116.61 |
| revm | 1 | 0.30 | 0.50 | 0.20 | (quantised) | 0.10 / 0.10 |
| revm | 10 | 0.30 | 1.10 | 0.80 | 80 | 0.70 / 0.70 |
| revm | 100 | 0.30 | 10.00 | 9.70 | 97 | 9.20 / 9.21 |
| revm | 300 | 0.70 | 31.40 | 30.70 | 102 | 30.60 / 30.58 |
| revm | 1000 | 1.80 | 117.20 | 115.40 | 115 | 115.50 / 116.43 |

WebKit (1 ms clamp, so the 1- and 10-slot rows are noise):

| engine | slots | plain block | root block | delta | `getStateRoot()` median / mean |
|---|---|---|---|---|---|
| default | 100 | 2.00 | 11.00 | 9.00 | 8.00 / 8.44 |
| default | 300 | 4.00 | 29.00 | 25.00 | 25.00 / 26.56 |
| default | 1000 | 12.00 | 110.00 | 98.00 | 98.00 / 97.56 |
| revm | 100 | 0.00 | 10.00 | 10.00 | 9.00 / 9.33 |
| revm | 300 | 1.00 | 26.00 | 25.00 | 26.00 / 26.78 |
| revm | 1000 | 2.00 | 106.00 | 104.00 | 115.00 / 115.00 |

### Run 2 (inside the full `verify`, right after the webevm suite, so a warmer and busier machine)

| engine | slots | Chromium delta | Chromium `getStateRoot()` med / mean | WebKit delta | WebKit `getStateRoot()` med / mean |
|---|---|---|---|---|---|
| default | 100 | 9.50 | 9.20 / 9.22 | 9.00 | 8.00 / 8.67 |
| default | 300 | 30.90 | 30.50 / 30.60 | 26.00 | 26.00 / 27.00 |
| default | 1000 | 117.00 | 162.70 / 164.29 | 101.00 | 100.00 / 98.78 |
| revm | 100 | 9.90 | 9.70 / 9.70 | 9.00 | 9.00 / 9.56 |
| revm | 300 | 38.90 | 38.10 / 38.37 | 25.00 | 26.00 / 26.33 |
| revm | 1000 | 125.00 | 131.80 / 131.78 | 100.00 | 100.00 / 99.44 |

Scenario rows in run 2, `callAvg` plain -> with root: Chromium 1.21 -> 1.47 (default), 0.69 -> 0.90 (revm); WebKit 1.40 -> 1.70, 0.85 -> 1.10. Reads and frame unchanged again.

The run-2 outliers (Chromium's 1000-slot `getStateRoot()` at 163 ms on the default engine, the revm 300-slot row at 38-39 ms) are larger than the matching block delta or the other browser, so they read as GC or load on a busy machine rather than a different cost; they widen the quoted ranges, which is why the README quotes 80-130 µs per slot and 25-39 ms at 300 slots rather than run 1's tighter figures.

Reading it:

- **The cost is linear in slots changed, at about 0.1 ms (80-130 µs across both runs) per slot**, on both engines and both browsers, and it is the same number whether it is measured as the block delta or as `getStateRoot()` alone. So the block delta IS the root update: nothing else in the block got slower. That is story 7 as stated: a plain node's execution plus a per-block root update proportional to what the block changed, and nothing per opcode.
- **It is independent of the engine.** The root update runs after execution, in JS, on the same derived trie whichever engine executed. On revm it is a far larger share of the block: at 300 slots (run 1, Chromium) the revm block goes from 0.7 ms to 31 ms (about 45x), the default engine's from 3.7 ms to 34 ms (about 9x).
- **It dominates a realistic game block.** At a few hundred changed slots the root update is 25-39 ms, more than a 16.6 ms frame on its own. That crosses the task's threshold and is recorded, not optimised, in `work/notes/observations/2026-09-28-computestateroot-root-update-dominates-a-game-block.md`.

## Where the 0.1 ms per slot goes (a probe, not a fix)

A Node probe of `@ethereumjs/mpt` alone, the library `src/derived-trie.ts` uses: 1000 `put`s into a 1000-slot trie with `useKeyHashing` and `useNodePruning` (the derived trie's options) take 126-141 ms, about 130 µs per put; without `useNodePruning`, 66-73 ms. The library hashes and stores every node on the path at each `put`, so the per-slot cost is the library's per-`put` cost, and the derived trie calls it once per changed slot. keccak of 100 bytes is about 3.5 µs, so hashing alone is not it. This is recorded as a pointer for whoever picks the observation up, not as a diagnosis.

## Decisions

1. **The two rows are APPENDED to `BACKENDS` and sit under the gas gate.** Appending keeps every older row in place, so `ethereumjs-tuned` still pins each gas reference and the older rows compare exactly what they compared before. Holding the new rows to the same gas widens the gate by two rows and changes nothing it already asserted; a root that changed gas would mean the trie leaked into execution, which is worth failing on. Alternative considered: a separate row list outside the gate, rejected because it would measure a configuration the gate does not protect. Touches: `packages/benchmarks/test/evm.spec.ts` only (the `every backend contributed to the gate` test reads `BACKENDS`, so it covers them without edits; a new pairwise test states plain vs `computeStateRoot` gas equality).
2. **The scaling measurement is NOT a scenario phase or a backend** (`test/helpers/root-update.ts`, dispatched from `cut.ts` by `params.scenario === 'root-update'`). The scenario is the gas gate and changes one slot per block; teaching it a K-slot transaction would change every backend, several of which have no state root. Same reasoning as ADR 0010's amendment (decision 1 of `measure-what-transactions-on-revm-actually-cost`). Unlike that measurement it still runs in the suite, in real Chromium and WebKit, on every `pnpm test`.
3. **The root-update blocks use the fabricated-signature trusted send path**, so the baseline under the delta carries no secp256k1 (about 1.5 ms of identical noise on both sides otherwise). The delta does not depend on it; the absolute block times in section 2 are that path's, not a signed transaction's.
4. **The writer contract is 27 bytes of hand-assembled runtime** (documented opcode by opcode in `root-update.ts`), not a new Solidity source, because the package's only compiled artefact is the gate's Counter and adding a compile step for one loop is not worth it.
5. **A `patch` changeset for `webevm`** (`.changeset/computestateroot-cost-benchmark.md`): the change is docs only for the published package, but the root README ships in its tarball (`prepack`), so the new cost statement reaches consumers in a release.
