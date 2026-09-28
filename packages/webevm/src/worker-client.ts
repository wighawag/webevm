/**
 * worker-client.ts — the OPTIONAL main-thread side. Wraps a Worker (running
 * ./worker-entry.ts) over comlink and returns the SAME `{ request, mine,
 * dumpState, loadState, ... }` shape as `createNode()`. So `createNode()` (main
 * thread) and `createWorkerNode()` (Worker) are interchangeable one-liners and
 * the consumer never hand-rolls the comlink plumbing.
 */
import {wrap, proxy, transfer, releaseProxy, type Remote} from 'comlink';
// The api TYPE, from the module that defines it rather than from the one that
// exposes it: this client drives ANY worker exposing it, including a consumer's
// own `exposeNode({createEngine})` module. Type-only, so nothing is imported at
// runtime and no `expose()` side effect is dragged onto the main thread.
import type {NodeWorkerApi} from './worker-host.js';
import type {
	NodeOptions,
	SlimNode,
	RequestArguments,
	SerializedState,
	ServedPort,
} from './types.js';

export interface WorkerNodeOptions extends NodeOptions {
	/**
	 * A Worker already pointing at this package's worker-entry, or at a module of
	 * your own that called `exposeNode()` (`webevm/worker-host`), which is the
	 * shape for a Worker that builds its own engine. Consumers create it themselves
	 * so the bundler controls chunking:
	 *   new Worker(new URL('webevm/worker-entry', import.meta.url),
	 *              {type: 'module'})
	 */
	worker: Worker;
	/**
	 * NOT AVAILABLE ON THIS PATH, and typed `never` so it is a compile error
	 * rather than a runtime surprise (it is also refused at runtime, for JS
	 * consumers). See the refusal in {@link createWorkerNode} for why, and for the
	 * supported way to run a non-default engine inside a Worker.
	 */
	engine?: never;
}

export async function createWorkerNode(
	opts: WorkerNodeOptions,
): Promise<SlimNode> {
	const {worker, ...nodeOptions} = opts;
	// AN ENGINE CANNOT CROSS THIS BOUNDARY, and says so. `WorkerNodeOptions`
	// extends `NodeOptions`, so `engine` is structurally in scope here, but these
	// options are STRUCTURED-CLONED into the Worker and an `Engine` is a
	// function-bearing object: comlink would throw an opaque `DataCloneError` from
	// deep inside its own postMessage, which is exactly the plausible-looking
	// failure this package's honest-edge convention exists to prevent. Cloning
	// could not work in principle either — an engine holds live state (a wasm
	// instance, a binding to the node's state manager) that belongs to the thread
	// that built it.
	//
	// The supported shape is to build the engine INSIDE the worker, in your own
	// worker module, and expose the node from there:
	//
	//   // my-worker.ts
	//   import {exposeNode} from 'webevm/worker-host';
	//   import {createRevmEngine} from 'webevm/revm';
	//   import wasm from 'revm-wasm/revm.wasm';
	//   exposeNode({createEngine: () => createRevmEngine({wasm})});
	//
	// `exposeNode` supplies the node and the proxy; the ENGINE is yours, built on
	// the thread that will use it. This package deliberately does not build it for
	// you, because that would mean the core naming engines by string and importing them,
	// which is precisely what ADR 0006 refuses (a JS-only consumer would pay for
	// revm).
	if ((nodeOptions as NodeOptions).engine !== undefined) {
		throw new Error(
			"webevm/worker-client: `engine` is not supported by createWorkerNode(). The node's options are structured-cloned into the Worker and an Engine is a function-bearing object, so it cannot be cloned across the thread boundary (comlink would report only a DataCloneError). " +
				'Build the engine INSIDE the Worker instead: write your own worker module that calls exposeNode({createEngine: () => createRevmEngine({wasm})}) from webevm/worker-host, which exposes the node for you, then drive it with the same client code. ' +
				'Or run the engine on the main thread with createNode().',
		);
	}
	const api = wrap<NodeWorkerApi>(worker);
	const remote = await api.createNode(nodeOptions);
	// computeStateRoot/senderMode/engine are plain values on the node; over comlink
	// they read as promises.
	//
	// NO `as any` HERE, and that is load-bearing. The remote is a `SlimNode` (the
	// one proxy in ./worker-host.ts is typed as one), so these three reads are
	// CHECKED: `senderMode` was silently absent from that proxy for a month, and
	// what hid it from the compiler was the cast that used to be on this line.
	const computeStateRoot = await remote.computeStateRoot;
	const senderMode = await remote.senderMode;
	const engineInfo = await remote.engine;

	return {
		request: (args: RequestArguments) => remote.request(args),
		mine: () => remote.mine(),
		dumpState: () => remote.dumpState(),
		loadState: (s: SerializedState) => remote.loadState(s),
		computeStateRoot,
		senderMode,
		engine: engineInfo,
		getStateRoot: () => remote.getStateRoot(),
		onNewHead(cb) {
			// The callback must cross the thread boundary as a comlink proxy.
			let unsub: (() => void) | undefined;
			void remote.onNewHead(proxy(cb)).then((u) => {
				unsub = u;
			});
			return () => {
				void unsub?.();
			};
		},
		async serveOn(port: MessagePort) {
			// TRANSFERRED, never cloned: a MessagePort cannot be cloned at all, and the
			// point is that the port now belongs to the node's worker, so a consumer
			// holding the other end reaches that worker without this thread in between.
			//
			// The cast restores what comlink's types cannot see: the worker-host proxy
			// hands the `ServedPort` back wrapped in `proxy()`, so what arrives is a
			// Remote (with a proxy to release), not a clone.
			const served = (await remote.serveOn(
				transfer(port, [port]),
			)) as unknown as Remote<ServedPort>;
			return {
				async close() {
					await served.close();
					served[releaseProxy]();
				},
			};
		},
		// Terminating the worker also ends every port it was serving: a consumer's
		// requests then get no answer, as they would from a stopped port.
		async dispose() {
			await remote.dispose();
			worker.terminate();
		},
	};
}
