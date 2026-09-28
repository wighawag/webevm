# webevm-benchmarks

**Private, never-published** benchmark package. It compares
[`webevm`](../webevm) against raw `@ethereumjs/*` backends
and [`tevm`](https://github.com/evmts/tevm) on the SAME scenario (deploy a Counter,
N `increment()` state txs, a `number()` read, and ADD-loop / keccak256-loop
compute), in real Chromium via
[`playwright-browser-harness`](https://www.npmjs.com/package/playwright-browser-harness).

It exists as a separate package so that `tevm` (and the `viem` exact-pin it forces,
plus the rest of the benchmark toolchain) stay **out of the library's dependency
tree**. The library package only depends on `@ethereumjs/*` + `@noble/hashes`.

## Run

```sh
pnpm install          # at the monorepo root
pnpm --filter webevm-benchmarks test
```

## The `revm` row

`revm` (Rust, compiled to WebAssembly) is included as a backend. It needs
no extra step: the module comes from the [`revm-wasm`](https://www.npmjs.com/package/revm-wasm)
package (MIT, zero runtime dependencies, prebuilt `.wasm` in the tarball), so the
row runs on a fresh clone and in CI like any other. `pnpm install` is the whole
setup, and no Rust toolchain is involved.

That package ships the `all-precompiles` build at `opt-level=3`, which is the only
configuration worth measuring: omitting precompiles **changes gas** (an omitted
address stops being pre-warmed, costing +2500 per cold access), and `opt-level="z"`
costs **~5x on keccak**.

The dependency is an ordinary `^0.3.0` range rather than an exact pin: gas equality
is asserted here on every run, so a `revm-wasm` release that changed what revm
charges turns this suite red instead of passing quietly. That is the gate doing its
job, and pinning would only hide it until someone bumped the pin.

The `.wasm` is fetched at runtime by the backend, so `evm.spec.ts` copies it out of
the package into the served directory next to the bundle. That is also where the
bundle-size row weighs it — esbuild cannot weigh a module that is fetched rather
than imported.

revm drives **everything** — the deployment, the state-changing transactions and
the reads — with no `@ethereumjs/*` involved, so every row is comparable and the
write path is under the gas gate too. The three paths are one entry point each:
`create()` to deploy, `transact()` to send, `call()` to read. `call()` never
commits whatever the options say, so `eth_call` is structurally incapable of
mutating state.

One caveat when reading the write rows: revm's `transact()` takes the sender
directly and **never recovers a sender**, so `deploy` and `callAvg` involve no
secp256k1 at all. The honest comparison for them is the
`webevm-fabricated` row, which also skips both signing and recovery —
not the default row, which pays ~0.3ms to sign plus ~1.2ms to recover (Chromium,
read off the gaps between these three rows).

## The `webevm-revm-engine` row

The row above is revm's CEILING: raw revm, owning its own state, with no node in
the path. `webevm-revm-engine` is the configuration a consumer
actually ships when they opt in —

```ts
const node = await createNode({engine: await createRevmEngine({wasm})});
```

— the same node as the `webevm` row, differing by exactly one
`createNode` option, with the node's own dispatch, state adapter and RPC layer on
top of the interpreter. That delta between the two node rows **is** the engine
swap; the delta to the raw `revm` row is what the node itself costs.

BOTH HALVES MOVE, so every row here is engine-sensitive. The engine executes this
row's transactions as well as its reads (it served reads only until the revm write
half landed), so `deploy` and `callAvg` are meaningful engine comparisons rather
than noise: a difference there is the interpreter, not the harness, and it is the
row to look at when a transaction-heavy tick gets slower. Read them knowing what
else they contain — this row signs each transaction and recovers its sender, and
the CLIENT's signing is the part the engine cannot make cheaper. The RECOVERY it
can, and now does: since `sender-recovery-uses-the-engines-ecrecover` the node
recovers with this engine's own secp256k1 (`Engine.ecrecover`, the `0x01`
precompile's k256, zero additional bytes), which took `callAvg` on this row from
1.92 ms to ~1.08 ms in Chromium — below the default engine's `'trusted'` row
despite still authenticating every transaction
([measurements](../../docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md)).
Signing still dominates a 21000-gas transfer, so the interpreter delta remains
compressed here. The read rows (`read`, `compute`, `keccak`, `frame`, `floor`)
isolate the interpreter, which is why the library README's frame figure comes from
`frame`.

It is an ordinary backend under the gate: its execution gas is compared against
both the JS node and raw revm, and its keccak-chain result against every backend.
The `frame` figure it measures — the one the library README should cite, since
the published 12.4 / 15.0 ms and 3.8 / 5.0 ms figures were both measured on RAW
backends — is captured with its conditions in
[`docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md`](../../docs/spikes/revm-engine-under-conformance-and-gate/frame-measurements.md).

The engine's own correctness (identical results and gas against the default
engine, reading AND writing the node's authoritative state, a read's purity, the
refused `stateMode`) lives in the library package, as does the differential
conformance battery run with the engine installed, receipts and post-state
included. This package only measures it and gates its gas.

## The `computeStateRoot` rows

`webevm-computestateroot` and `webevm-revm-engine-computestateroot` are the `webevm` and `webevm-revm-engine` rows with `createNode({computeStateRoot: true})` added and nothing else, so the delta to each plain sibling is what computing a state root costs on this scenario. Auto-mine puts one transaction in each block, so their `deploy` and `callAvg` are per transaction AND per block (a block that changes one slot); the read rows execute no block and should not move. They are APPENDED to the backend list, so every older row keeps its place and `ethereumjs-tuned` still pins each gas reference; they are held to the same gas as every other backend, because a root is computed after execution and must not change what execution charges.

How the root update SCALES is a separate measurement, `test/helpers/root-update.ts`, run once per engine: two nodes identical but for the option mine the same blocks, each rewriting K slots (1, 10, 100, 300, 1000) of one contract, and the block delta is compared with a direct `getStateRoot()` after K pending cheat writes. It is deliberately NOT a scenario phase or a backend: the scenario is the gas gate, and teaching it a new transaction shape would mean changing every backend (the reason ADR 0010's amendment gives for measuring transaction shapes outside the suite). The last test in `evm.spec.ts` prints both tables; figures and conditions are in [`docs/spikes/computestateroot-cost-benchmark/measurements.md`](../../docs/spikes/computestateroot-cost-benchmark/measurements.md). In short: about 0.1 ms per changed slot, on both engines, and nothing per opcode.

## What it measures

- **Per-phase timings** (median of repeats): cold start, deploy, state-changing
  call, read (`eth_call`), ADD-loop compute, keccak256-loop compute.
- **Bundle size** (raw + gzip) of each backend's entry, built with esbuild.
- **Cross-backend keccak-chain equality** — all backends must produce the IDENTICAL
  `keccakLoop(2000)` result (catches keccak / `abi.encodePacked` drift).
- **Cross-backend GAS equality** — every backend implements the same spec, so the
  same call must cost the same **execution gas**. This is the gate for replacing
  the interpreter: engines that disagree on gas disagree on where execution runs
  OUT of gas, so a client replaying the chain would fork. Matching return values
  is **not** sufficient. It has already earned its keep twice, catching an
  EIP-2929 warmth leak in the raw-`runCall` backends here, and confirming that
  revm-wasm is gas-identical to `@ethereumjs/evm`.
- **MGas/s** — the only backend-independent speed unit, and directly comparable to
  published evmone/revm/geth figures unlike wall-clock ms.
- **Frame budget** — 100 small view reads back to back (the on-chain-game shape),
  against a 16.6 ms 60fps budget, plus the fixed per-call floor. Printed, never
  asserted: timing rows are load-sensitive, and WebKit clamps
  `performance.now()` to 1 ms.

The library's own correctness/conformance/honesty tests (differential conformance,
GeneralStateTests, viem-surface, persistence-reload, the `evm_set*` cheats, the
state-root modes) live in the `webevm` package, not here.

## Note on `viem`

`viem` is pinned to exactly `2.45.0` here because `@tevm/common` imports chain
names that were dropped from viem ≥ 2.51. This pin is benchmark-only; the library
package itself uses a normal `^2.45.0` range.
