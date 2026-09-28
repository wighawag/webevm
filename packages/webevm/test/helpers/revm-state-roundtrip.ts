/**
 * revm-state-roundtrip.ts — the state round-trip suite (./state-roundtrip.ts)
 * driven with the `webevm/revm` engine installed.
 *
 * The suite is the SAME one `state-roundtrip.spec.ts` runs, parameterised by engine
 * rather than copied — the precedent set by ./revm-conformance.ts. What changes is
 * WHICH EVM executes the transactions, and that is precisely what the two round
 * trips are about here: revm reads and writes the node's state through host
 * callbacks and caches NOTHING across a transaction (ADR 0010), so a cheat applied
 * between two transactions is picked up on the next access and a dump taken after
 * one is complete. Both would fail silently if either were untrue.
 *
 * WHICH STATE MODE: the default `'none'`. (This engine used to refuse
 * `stateMode:'trie'`, ADR 0005; it serves it since ADR 0014, and a trie-mode
 * dump and reload on revm is covered by `revm-trie-derived.spec.ts`.)
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them: the suite builds an original
 * node and the node it reloads the dump into, and an engine instance binds to
 * exactly one node, so a factory hands each a fresh engine over ONE compiled
 * `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runStateRoundTrip} from './state-roundtrip.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmStateRoundTrip() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runStateRoundTrip({makeEngine: () => createRevmEngine({wasm})});
}
