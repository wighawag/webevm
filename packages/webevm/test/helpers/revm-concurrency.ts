/**
 * revm-concurrency.ts — the concurrency battery (./concurrency.ts) driven with the
 * `webevm/revm` engine installed.
 *
 * The suite is the SAME one `concurrency.spec.ts` runs, parameterised by engine
 * rather than copied — the precedent set by ./revm-conformance.ts. Running it here
 * is not symmetry for its own sake. The defect ADR 0012 records is a property of
 * the NODE's dispatcher and of the state manager both engines share, not of either
 * EVM: revm's `call` is structurally incapable of committing, so it opens no
 * checkpoint level and the read-versus-write scans cannot fail on it however the
 * node dispatches — but revm reads AND WRITES the node's state through the same
 * `SimpleStateManager` stacks (ADR 0005, ADR 0010), so two overlapping
 * TRANSACTIONS interleave exactly as they do on the default engine, and a
 * non-executing read is just as dirty mid-transaction. A fix that had lived inside
 * the default engine's `call` would have left this file failing, which is the
 * reason it exists.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them: the battery builds a fresh
 * node per tick offset and an engine instance binds to exactly one node, so the
 * factory hands each a new engine over ONE compiled `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runConcurrencyChecks} from './concurrency.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmConcurrency() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runConcurrencyChecks({makeEngine: () => createRevmEngine({wasm})});
}
