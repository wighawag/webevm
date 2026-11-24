/**
 * node-factory-worker.ts: A WORKER MODULE THAT CREATES ITS OWN NODE, through
 * `exposeNode({createNode})`. It stands in for the layer the option exists for
 * (`@webevm/devnode` funding its dev accounts at genesis, ADR 0017): a factory
 * that takes the main thread's options, creates webevm's node from them and hands
 * back a DECORATOR over it.
 *
 * ONE module, FOUR behaviours, chosen by the worker URL's `?factory=` query
 * (read synchronously at module scope, so `exposeNode()` still runs before
 * anything could lose the main thread's first message). One module rather than
 * four because a harness mount serves ONE worker entry point:
 *
 *   - `decorate`: the factory decorates webevm's node. What the main thread
 *     drives must be THIS decorator, member for member.
 *   - `sees-engine`: as `decorate`, with a `createEngine` too, so the factory can
 *     report whether the engine it received is the one `createEngine` built.
 *   - `not-a-function`: the misuse, a factory that is not one (refused as a value).
 *   - `rejects`: a factory that rejects (its message must reach the main thread).
 *
 * THE DECORATOR IS OBSERVABLE FROM THE MAIN THREAD, which is the point: its
 * `engine` reads `factory:<inner id>` (a value only the factory's node carries),
 * it records which members were called, and its `request` answers one extra
 * method, `test_factoryProbe`, with that record and with what the factory was
 * given. Everything else delegates to the inner node.
 */
import {exposeNode} from '../../src/worker-host.js';
import {createNode} from '../../src/node.js';
import type {Engine, NodeOptions, SlimNode} from '../../src/types.js';

/** What the factory saw, reported back through `test_factoryProbe`. */
export interface FactoryProbe {
	/** Every `SlimNode` member the main thread reached on the decorator. */
	called: string[];
	/** What the factory was handed. */
	received: {
		chainId: number | null;
		initialBalances: string[];
		hasEngine: boolean;
		engineId: string | null;
		/** `true` when the engine is the very object `createEngine` built. */
		engineIsTheBuiltOne: boolean;
	};
}

/** The rejection's message; `node-factory.ts` on the page asserts this text. */
const FACTORY_REJECTION = 'node-factory-worker: this factory rejects';

function decorate(inner: SlimNode, received: FactoryProbe['received']) {
	const called = new Set<string>();
	const note = (member: string) => called.add(member);
	const decorated: Required<SlimNode> = {
		async request(args) {
			if (args.method === 'test_factoryProbe') {
				const probe: FactoryProbe = {called: [...called].sort(), received};
				return probe;
			}
			note('request');
			return inner.request(args);
		},
		mine: () => (note('mine'), inner.mine()),
		dumpState: () => (note('dumpState'), inner.dumpState()),
		loadState: (state) => (note('loadState'), inner.loadState(state)),
		getStateRoot: () => (note('getStateRoot'), inner.getStateRoot()),
		onNewHead: (cb) => (note('onNewHead'), inner.onNewHead(cb)),
		// Delegated, never noted: the client refuses `onConsoleLog` without calling
		// the worker until `console-log-in-a-worker`.
		onConsoleLog: (cb) => inner.onConsoleLog(cb),
		serveOn: (port) => (note('serveOn'), inner.serveOn(port)),
		dispose: () => (note('dispose'), inner.dispose()),
		computeStateRoot: inner.computeStateRoot,
		senderMode: inner.senderMode,
		engine: {...inner.engine, id: `factory:${inner.engine.id}`},
	};
	return decorated;
}

/** The engine `createEngine` built last, to compare against what the factory got. */
let builtEngine: Engine | undefined;
/**
 * A sentinel engine: never run. The factory reports that it received it, then
 * creates the inner node WITHOUT it (it cannot execute anything).
 */
function sentinelEngine(): Engine {
	builtEngine = {
		id: 'sentinel-engine',
		call: async () => {
			throw new Error('sentinel engine: never run');
		},
		transact: async () => {
			throw new Error('sentinel engine: never run');
		},
	};
	return builtEngine;
}

async function decoratingFactory(options: NodeOptions): Promise<SlimNode> {
	const {engine, ...rest} = options;
	const received: FactoryProbe['received'] = {
		chainId: options.chainId ?? null,
		initialBalances: Object.keys(options.initialBalances ?? {}),
		hasEngine: engine !== undefined,
		engineId: engine?.id ?? null,
		engineIsTheBuiltOne: engine !== undefined && engine === builtEngine,
	};
	// The sentinel cannot execute, so it stops here; any other engine (none in
	// this module) would be passed on, as a real factory does.
	const inner = await createNode(engine === builtEngine ? rest : options);
	return decorate(inner, received);
}

const mode = new URL(self.location.href).searchParams.get('factory');

export const factoryApi =
	mode === 'sees-engine'
		? exposeNode({createEngine: sentinelEngine, createNode: decoratingFactory})
		: mode === 'not-a-function'
			? // THE MISUSE, with the cast a JS consumer does not need.
				exposeNode({createNode: {notA: 'function'} as never})
			: mode === 'rejects'
				? exposeNode({
						createNode: async () => {
							throw new Error(FACTORY_REJECTION);
						},
					})
				: exposeNode({createNode: decoratingFactory});
