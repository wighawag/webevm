/**
 * revm-state-history.ts: the state-history battery (./state-history.ts) with the
 * `webevm/revm` engine installed.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runStateHistoryChecks} from './state-history.js';
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmStateHistory() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runStateHistoryChecks({makeEngine: () => createRevmEngine({wasm})});
}
