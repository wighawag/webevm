/**
 * revm-change-set.ts: the change-set battery (./change-set.ts) with the
 * `webevm/revm` engine installed. revm commits through the state manager's
 * synchronous by-key writers rather than its async interface, so whether every
 * one of its writes reaches the record is a question for this engine separately.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runChangeSetChecks} from './change-set.js';
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmChangeSet() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runChangeSetChecks({makeEngine: () => createRevmEngine({wasm})});
}
