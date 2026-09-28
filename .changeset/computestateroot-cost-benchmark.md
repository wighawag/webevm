---
'webevm': patch
---

**Docs: the README now states what `computeStateRoot: true` costs, measured.** Execution, reads and gas are unchanged on both engines; each block gains a root update linear in the storage slots it changed, about 0.1 ms per slot (a one-slot block about 0.25 ms, 300 slots about 25-39 ms), the same on both engines. For a game rewriting a few hundred slots per block, the root update is the block's dominant cost, so leave the option off unless you need the root. Figures from the benchmark package's new `computeStateRoot` rows and root-update measurement (`docs/spikes/computestateroot-cost-benchmark/measurements.md`). No code change in the package.
