/**
 * cut.ts: the code-under-test the playwright-browser-harness loads into a real
 * browser page, on the DEFAULT engine (`@ethereumjs/evm`). The revm half is
 * ./cut-revm.ts, a separate bundle so this one carries no wasm.
 *
 * Modes:
 *   - 'dev-node': the first slice of `@webevm/devnode` (./dev-node-checks.ts):
 *                 dev accounts, funded at genesis, everything else forwarded,
 *                 and a served port
 */
import type {
	CodeUnderTest,
	RunResult,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {runDevNodeChecks} from './dev-node-checks.js';

const cut: CodeUnderTest = {
	name: '@webevm/devnode',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const results: Record<string, unknown> = {};
		if (ctx.params.mode === 'dev-node') {
			try {
				results.devNode = await runDevNodeChecks(undefined);
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
