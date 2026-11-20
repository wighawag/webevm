/**
 * worker-host.ts: `@webevm/devnode/worker-host`, the dev node INSIDE a worker.
 * The whole of a consumer's worker module:
 *
 *   // dev-worker.ts
 *   import {exposeDevNode} from '@webevm/devnode/worker-host';
 *   exposeDevNode({accounts: {mnemonic}, impersonation: true});
 *
 * and the main thread drives it with webevm's own client, unchanged:
 * `createWorkerNode({worker, chainId, ...})` from `webevm/worker-client`.
 *
 * NOT A SECOND WORKER HOST. This module ships no proxy and no client: it hands
 * webevm's `exposeNode` a NODE FACTORY (`options => createDevNode({...options,
 * ...devConfig})`), so the node crosses the thread boundary through the ONE
 * `Required<SlimNode>` proxy in `webevm/worker-host` (CONTEXT.md, *worker host*),
 * and an `RpcError` the layer raises crosses with its `code` and `data` exactly
 * as the core's do. A factory rather than a wrap afterwards because the dev
 * accounts are funded AT GENESIS, before the node exists
 * (`docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`).
 *
 * THE KEYS STAY HERE. The accounts are written in the worker module and derived
 * in the worker; nothing this module sends to the main thread carries a key or
 * a mnemonic (the refusal messages below name the option, never its value).
 *
 * A BAD CONFIG IS A VALUE, NEVER A THROW, for the reason webevm's worker host
 * gives for a bad `createEngine`: this runs while the worker module is still
 * evaluating, so a throw here means comlink's `expose()` never runs and the main
 * thread's `createWorkerNode()` never settles. So the config is validated at
 * once, the refusal is logged on this thread at once, and the factory rejects
 * with the same text, which reaches the main thread as `createWorkerNode()`'s
 * rejection (CONTEXT.md, *both signals*).
 */
import {
	createNodeWorkerApi,
	exposeNode,
	type EngineSupplier,
	type NodeWorkerApi,
	type WorkerHostOptions,
} from 'webevm/worker-host';
import {deriveDevAccounts, devAccountBalances} from './accounts.js';
import type {DevFundingOptions} from './accounts.js';
import {createDevNode, type ImpersonationOptions} from './dev-node.js';

/**
 * What the WORKER decides: the engine, the dev accounts, their funding and the
 * impersonation switch. Everything else (`chainId`, `miningConfig`,
 * `senderMode`, `initialBalances`, ...) is the main thread's, passed to
 * `createWorkerNode()` as for any worker node.
 *
 * DECISION: `initialBalances` is NOT a worker option. It is webevm's own
 * `createNode` option, which the main thread already passes through
 * `createWorkerNode()`; accepting it here too would make the worker's value
 * silently REPLACE the main thread's (the factory spreads the worker's config
 * over the main thread's options). The worker funds extra addresses with
 * `fundAccounts`, and the main thread's `initialBalances` still win over both,
 * the precedence `createDevNode` documents. Alternative considered: accepting it
 * and merging the two maps, which would be a second precedence rule to learn.
 */
export interface DevNodeWorkerHostOptions
	extends Omit<DevFundingOptions, 'initialBalances'>, ImpersonationOptions {
	/**
	 * Build this node's engine on THIS thread, as `webevm/worker-host`'s option
	 * of the same name (called once per node). Omit it for the default engine.
	 */
	createEngine?: EngineSupplier;
}

/**
 * Why the dev config cannot create a node, or `undefined` when it can. The same
 * checks `createDevNode` makes, run once up front so the mistake is reported
 * when it is made rather than when a node is first asked for.
 */
function devConfigRefusal(
	devConfig: Omit<DevNodeWorkerHostOptions, 'createEngine'>,
): string | undefined {
	try {
		deriveDevAccounts(devConfig.accounts);
		// The balances' own checks, without deriving the accounts a second time
		// (a mnemonic's seed is the slow part): an empty key list funds nobody.
		devAccountBalances({...devConfig, accounts: []});
		return undefined;
	} catch (e) {
		// The message already names the package and the option, never its value.
		return String((e as Error)?.message ?? e);
	}
}

/**
 * webevm's worker-host options for a dev node: the consumer's engine, and the
 * dev node as the NODE FACTORY. Never throws: a bad config is logged here at
 * once and rejects every `createNode()`.
 */
function devNodeHostOptions(
	hostOptions: DevNodeWorkerHostOptions | undefined,
): WorkerHostOptions {
	const {createEngine, ...devConfig} = hostOptions ?? {};
	const refusal = devConfigRefusal(devConfig);
	// THE EARLY SIGNAL, on the thread the config was written on.
	if (refusal !== undefined) console.error(refusal);
	return {
		createEngine,
		async createNode(options) {
			// THE LATE SIGNAL: the main thread's `createWorkerNode()` rejects with it.
			if (refusal !== undefined) throw new Error(refusal);
			// The worker's dev config over the main thread's options (the engine
			// already merged in by webevm's host); a refusal from `createDevNode`
			// (impersonation on a `senderMode: 'recover'` node, say) rejects the
			// main thread the same way.
			return createDevNode({...options, ...devConfig});
		},
	};
}

/**
 * The comlink api a dev-node worker exposes: webevm's `createNodeWorkerApi`
 * with the dev node as its factory, so it is exactly what `createWorkerNode()`
 * drives. Use {@link exposeDevNode} unless you are composing this into a larger
 * exposed api of your own (the counterpart of webevm's `createNodeWorkerApi`).
 *
 * DECISION: exported (not only {@link exposeDevNode}) for the same reason
 * webevm exports its counterpart, and so the worker-side signal can be checked
 * without calling comlink's `expose()` on the checking thread. Alternative: the
 * one export, with the early signal observable only in a worker's console.
 *
 * Never throws: a bad config is logged here and rejects every `createNode()`.
 */
export function createDevNodeWorkerApi(
	hostOptions: DevNodeWorkerHostOptions = {},
): NodeWorkerApi {
	return createNodeWorkerApi(devNodeHostOptions(hostOptions));
}

/**
 * Expose a DEV node on THIS thread: the whole of a consumer's worker module.
 *
 *   exposeDevNode({createEngine: () => createRevmEngine({wasm}), accounts: 5});
 *
 * The main thread uses webevm's own `createWorkerNode()` unchanged, and gets a
 * node whose `eth_accounts`, sends and signatures are answered in here, its
 * genesis funded here, and its keys never leaving this thread. Call it ONCE per
 * thread, and await nothing at the module's top level before it (webevm's
 * `exposeNode` has why: a slow top-level await can lose the main thread's first
 * message). Needs `comlink`, as `webevm/worker-host` does.
 *
 * Returns the exposed api.
 */
export function exposeDevNode(
	hostOptions: DevNodeWorkerHostOptions = {},
): NodeWorkerApi {
	return exposeNode(devNodeHostOptions(hostOptions));
}
