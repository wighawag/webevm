/**
 * revm-historical-call.ts: the historical-call battery (./historical-call.ts)
 * with the `webevm/revm` engine installed.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runHistoricalCallChecks} from './historical-call.js';
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmHistoricalCall() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runHistoricalCallChecks({makeEngine: () => createRevmEngine({wasm})});
}
