/**
 * revm-rpc-params.ts: the state-override battery (./rpc-params.ts) with the
 * `webevm/revm` engine installed. revm reads the node's state stacks directly
 * (ADR 0005) and opens no checkpoint of its own, so whether it SEES an override
 * level the node pushed, and whether that level is gone afterwards, is a question
 * for this engine separately from the default one.
 */
import {createRevmEngine} from '../../src/revm.js';
import {runStateOverrideChecks} from './rpc-params.js';
import bundlerResolvedWasm from 'revm-wasm/revm.wasm';

export async function runRevmRpcParams() {
	const wasm = await WebAssembly.compile(bundlerResolvedWasm);
	return runStateOverrideChecks({makeEngine: () => createRevmEngine({wasm})});
}
