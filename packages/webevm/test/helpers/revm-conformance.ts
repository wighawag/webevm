/**
 * revm-conformance.ts — the differential conformance battery (./conformance.ts)
 * driven with the `webevm/revm` engine installed.
 *
 * This is the strongest correctness bar in the repo pointed at the engine a
 * consumer actually ships: the same signed transactions, the same trie-backed
 * `@ethereumjs/vm` `runTx` reference, the same field-by-field diff — with revm
 * answering BOTH halves of the seam, `eth_call` and `eth_estimateGas` as well as
 * every transaction the battery mines. Which engine actually executed them is
 * COUNTED rather than assumed (`transactionsByEngine`), because a battery whose
 * transactions had quietly gone back to `@ethereumjs/vm` would diff the reference
 * against itself and pass every assertion in it.
 *
 * WHICH CONFIGURATIONS: both. revm used to REFUSE a root-computing node (then
 * `'trie'` mode, which ran on `MerkleStateManager`, which has no synchronous
 * view, ADR 0005); every node now runs on the flat state and a root-computing
 * node derives its trie from it between blocks (ADR 0014), so the whole battery
 * runs on revm without AND with `computeStateRoot`.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them. The battery builds two
 * nodes per mode, and an engine instance binds to
 * exactly one node (a second `createNode()` is refused). So a factory hands each
 * node a fresh engine, all sharing ONE compiled `WebAssembly.Module` — which is
 * precisely what `createRevmEngine`'s `wasm` option accepting a compiled module
 * is for.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runConformanceOnEngine} from './conformance.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-engine.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmConformance() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runConformanceOnEngine({
		makeEngine: () => createRevmEngine({wasm}),
	});
}
