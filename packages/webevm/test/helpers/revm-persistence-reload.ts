/**
 * revm-persistence-reload.ts — the IndexedDB persistence flow (./persistence-reload.ts)
 * driven with the `webevm/revm` engine installed.
 *
 * The flow is the SAME one `persistence-reload.spec.ts` runs, parameterised by
 * engine rather than copied — the precedent set by ./revm-conformance.ts. What
 * changes is WHICH EVM executed the transactions whose state was persisted, and
 * which one answers the reads afterwards.
 *
 * WHY IT IS WORTH RUNNING TWICE. Persistence dumps the node's state, and on this
 * engine the node's state is written by revm through host callbacks with nothing
 * copied out (ADR 0010). So a dump taken after a revm transaction is complete only
 * if the write half really landed in the node's own representation — and a page
 * reload is the harshest reader of it, because the JS side is gone entirely and the
 * post-reload node has nothing but the database.
 *
 * ITS OWN DATABASE (see `PersistenceOptions`): the two engines' runs must not be
 * able to read each other's writes, or a `read` phase could report `loaded: true`
 * for state this engine never persisted.
 *
 * ONE ENGINE PER NODE, one COMPILATION for all of them: each phase builds a node, so
 * a factory hands each a fresh engine over ONE compiled `WebAssembly.Module`.
 */
import {createRevmEngine} from '../../src/revm.js';
import {persistWrite, persistRead} from './persistence-reload.js';
// The BUNDLER-RESOLVED delivery shape, as in ./revm-conformance.ts: the build puts
// the `.wasm` bytes IN the bundle, so the page fetches nothing.
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

/** The revm run's own IndexedDB database. */
const DB = 'slim-reload-test-revm';

async function options() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return {db: DB, makeEngine: () => createRevmEngine({wasm})};
}

export async function runRevmPersistWrite() {
	return persistWrite(await options());
}

export async function runRevmPersistRead(
	address: string,
	pinnedAt: {pinned: number; beforeTransfer: number},
) {
	return persistRead(address, await options(), pinnedAt);
}
