/**
 * dev-worker.ts: THE WORKER MODULE for ./worker-hosting-checks.ts. ONE module,
 * several behaviours, chosen by the worker URL's `?host=` query (read
 * synchronously at module scope, so `exposeNode()` / `exposeDevNode()` still
 * runs before anything could lose the main thread's first message), because a
 * harness mount serves ONE worker entry point (as webevm's
 * `test/helpers/node-factory-worker.ts`):
 *
 *   - `plain`: webevm's own worker host, no dev layer at all. The KEYS-ON-THE-
 *     MAIN-THREAD recipe drives this one and wraps the proxy there.
 *   - `dev`: the KEYS-IN-THE-WORKER recipe, `exposeDevNode` with a mnemonic
 *     written HERE (and impersonation on), so the main thread never sees it.
 *   - `bad-mnemonic`, `bad-key`: a dev config that cannot derive accounts.
 *   - `bad-engine`: a `createEngine` that is not a factory (webevm's refusal,
 *     reached through `exposeDevNode`).
 *
 * The `dev` mode imports the package by relative `src/` path, as every other
 * helper here imports `../../src/index.js`; `webevm/worker-host` by package
 * name, as a consumer resolves it.
 */
import {exposeNode, type NodeWorkerApi} from 'webevm/worker-host';
import {exposeDevNode} from '../../src/worker-host.js';
import {WORKER_ACCOUNT_COUNT, WORKER_MNEMONIC} from './dev-worker-config.js';

const mode = new URL(self.location.href).searchParams.get('host');

export const api: NodeWorkerApi =
	mode === 'plain'
		? exposeNode()
		: mode === 'bad-mnemonic'
			? exposeDevNode({accounts: {mnemonic: 'not a real mnemonic at all'}})
			: mode === 'bad-key'
				? exposeDevNode({accounts: ['0x1234']})
				: mode === 'bad-engine'
					? // THE MISUSE, with the cast a JS consumer does not need.
						exposeDevNode({createEngine: {notA: 'factory'} as never})
					: exposeDevNode({
							accounts: {
								mnemonic: WORKER_MNEMONIC,
								count: WORKER_ACCOUNT_COUNT,
							},
							impersonation: true,
						});
