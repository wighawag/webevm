/**
 * revm-genesis-cheats.ts — the custom-genesis and `evm_set*` cheat halves of
 * ./genesis-cheats-perf.ts, driven with the `webevm/revm` engine
 * installed.
 *
 * The checks are the SAME ones `genesis-cheats-perf.spec.ts` runs, parameterised by
 * engine rather than copied — the precedent set by ./revm-conformance.ts. What
 * changes is WHICH EVM reads the genesis state and executes the transaction that
 * calls the pre-deployed contract.
 *
 * WHICH STATE MODE, and why the perf half is absent. The cheats run in `'none'`
 * here and `'trie'` keeps its default-engine coverage in
 * `genesis-cheats-perf.spec.ts` (revm, which used to refuse `'trie'`, serves it
 * since ADR 0014, and that is covered by `revm-trie-derived.spec.ts`). The
 * trie-vs-none PERF comparison is not repeated per engine: engine performance
 * belongs to `packages/benchmarks`.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them: the checks build three nodes
 * (the runtime-code capture, the genesis node, the cheat node), and an engine
 * instance binds to exactly one node, so a factory hands each a fresh engine over
 * ONE compiled `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runGenesisCheatsOnEngine} from './genesis-cheats-perf.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmGenesisCheats() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runGenesisCheatsOnEngine({
		makeEngine: () => createRevmEngine({wasm}),
		computeStateRoot: false,
	});
}
