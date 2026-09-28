/**
 * revm-state-history-persistence.ts: the state-history-persistence battery
 * (./state-history-persistence.ts) with the `webevm/revm` engine installed.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runStateHistoryPersistenceChecks} from './state-history-persistence.js';
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmStateHistoryPersistence() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runStateHistoryPersistenceChecks({
		makeEngine: () => createRevmEngine({wasm}),
	});
}
