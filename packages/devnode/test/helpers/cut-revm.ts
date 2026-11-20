/**
 * cut-revm.ts: the same battery as ./cut.ts with the `webevm/revm` engine
 * installed. A separate bundle, as in packages/webevm, because it carries the
 * revm `.wasm` (about 1.2 MB) and the default-engine page should not.
 *
 * Modes:
 *   - 'dev-node': ./dev-node-checks.ts, every node created on revm
 */
import type {
	CodeUnderTest,
	RunResult,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {createRevmEngine} from 'webevm/revm';
import wasm from 'revm-wasm/revm.wasm';
import {runDevNodeChecks} from './dev-node-checks.js';

const cut: CodeUnderTest = {
	name: '@webevm/devnode (revm)',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const results: Record<string, unknown> = {};
		if (ctx.params.mode === 'dev-node') {
			try {
				// Compiled once, instantiated per node: one engine serves one node.
				const module = await WebAssembly.compile(wasm);
				results.devNode = await runDevNodeChecks(() =>
					createRevmEngine({wasm: module}),
				);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		return {
			results: {},
			timings: [],
			errors: [`unknown mode: ${String(ctx.params.mode)}`],
			env: captureEnv(),
		};
	},
};

export default cut;
