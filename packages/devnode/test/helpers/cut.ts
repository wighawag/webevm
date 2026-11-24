/**
 * cut.ts: the code-under-test the playwright-browser-harness loads into a real
 * browser page, on the DEFAULT engine (`@ethereumjs/evm`). The revm half is
 * ./cut-revm.ts, a separate bundle so this one carries no wasm.
 *
 * Modes:
 *   - 'dev-node': the first slice of `@webevm/devnode` (./dev-node-checks.ts):
 *                 dev accounts, funded at genesis, everything else forwarded,
 *                 and a served port
 *   - 'send':     `eth_sendTransaction` from dev accounts (./send-checks.ts),
 *                 in both sender modes
 *   - 'sign':     the signing methods and the EIP-712 encoder
 *                 (./sign-checks.ts), the same battery sign.spec.ts also
 *                 runs in Node
 *   - 'alloc':    `toAllocs`, the alloc export for forge (./alloc-checks.ts),
 *                 the same battery alloc.spec.ts also runs in Node
 *   - 'impersonation': `hardhat_` / `anvil_impersonateAccount` and the sends
 *                 they enable (./impersonation-checks.ts)
 *   - 'cheats':   the core's cheats and snapshots, forwarded
 *                 (./cheat-checks.ts), the same battery cheat.spec.ts also
 *                 runs in Node
 *   - 'console-log': `onConsoleLog` and the `consoleLog` option pass through
 *                 the dev node (./console-log-checks.ts)
 *   - 'worker-hosting': the dev node over a worker proxy and inside a worker
 *                 (./worker-hosting-checks.ts, driving ./dev-worker.ts at
 *                 `params.workerUrl`)
 */
import type {
	CodeUnderTest,
	RunResult,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {runDevNodeChecks} from './dev-node-checks.js';
import {runSendChecks} from './send-checks.js';
import {runAllocChecks} from './alloc-checks.js';
import {runSignChecks} from './sign-checks.js';
import {runImpersonationChecks} from './impersonation-checks.js';
import {runWorkerHostingChecks} from './worker-hosting-checks.js';
import {runCheatChecks} from './cheat-checks.js';
import {runConsoleLogChecks} from './console-log-checks.js';

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
		if (ctx.params.mode === 'send') {
			try {
				results.send = await runSendChecks(undefined);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'sign') {
			try {
				results.sign = await runSignChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'impersonation') {
			try {
				results.impersonation = await runImpersonationChecks(undefined);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'worker-hosting') {
			try {
				results.workerHosting = await runWorkerHostingChecks(
					String(ctx.params.workerUrl),
				);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'cheats') {
			try {
				results.cheats = await runCheatChecks(undefined);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'console-log') {
			try {
				results.consoleLog = await runConsoleLogChecks();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings: [], errors, env: captureEnv()};
		}
		if (ctx.params.mode === 'alloc') {
			try {
				results.alloc = await runAllocChecks();
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
