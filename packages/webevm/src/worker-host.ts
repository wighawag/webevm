/**
 * worker-host.ts: THE WORKER SIDE OF THE NODE, minus the side effect: the ONE
 * `SlimNode` proxy that crosses a comlink boundary, and the two ways to put it on
 * a thread. `./worker-entry.ts` is this module plus an import-time `expose()`;
 * a consumer whose Worker must build something first (an ENGINE) calls
 * {@link exposeNode} from their own worker module instead.
 *
 * WHY IT IS A SEPARATE MODULE. `worker-entry` calls `expose()` at MODULE SCOPE,
 * which is what makes `new Worker(new URL('webevm/worker-entry', ...))`
 * a one-liner, and also what makes it unusable as a library: importing it to
 * reuse the proxy would expose the DEFAULT api on the importing thread, so
 * consumers hand-copied the proxy block instead. There were three copies of it
 * (this package's, this repo's example, and every consumer's), each able to drop a
 * field independently. That is not hypothetical: `senderMode` was missing from
 * one of them for a month, reading as `undefined` on a property typed
 * `'recover' | 'trusted'`. Now there is one copy, here.
 *
 * AND IT IS THE COMPILER THAT KEEPS IT COMPLETE. {@link nodeProxy}'s literal is
 * typed `Required<SlimNode>`, so a field ADDED to `SlimNode` later fails to build
 * here rather than reading as `undefined` on the far side of a thread boundary;
 * the client (`./worker-client.ts`) reads those fields off the remote with no
 * `as any` in the way, so the type is load-bearing on both ends. That covers a
 * future field structurally, which is the property enumerating today's fields
 * cannot have. `Required<>` is what extends it to an OPTIONAL member: a bare
 * `SlimNode` annotation does not DEMAND one, so an optional field added later
 * would compile while missing here. The runtime parity check that backs this up
 * (`test/helpers/worker-roundtrip.ts`) cannot be widened the same way and says so
 * itself: it enumerates the keys of a reference node INSTANCE, and an optional
 * field that instance does not carry is invisible to it.
 *
 * A MISUSE OF {@link WorkerHostOptions.createEngine} IS A VALUE, NEVER A THROW,
 * and that ordering is the whole of why: `expose()` registers comlink's message
 * listener, so a module that throws BEFORE reaching it answers the main thread
 * nothing at all and `createWorkerNode()` stays pending forever. The refusal is
 * therefore recorded here, reported on this thread immediately, and re-thrown
 * from `createNode()` where it crosses the boundary as a rejection the caller can
 * read. Both threads say something; neither is left guessing.
 * `docs/spikes/a-bad-createengine-hangs-the-main-thread-instead-of-rejecting/decisions.md`.
 *
 * WHAT THIS MODULE DOES NOT DO: name an engine. The core imports no engine and
 * resolves no engine name (`docs/adr/0006-the-engine-is-an-injected-object-not-a-named-string.md`),
 * so an engine reaches a node here exactly as it does on the main thread, as an
 * object the CONSUMER built, on the thread that will use it. This module never
 * mentions `webevm/revm`, and a JS-only consumer's bundle is unmoved by
 * its existence.
 */
import {expose, proxy} from 'comlink';
import {createNode} from './node.js';
import type {Engine, NodeOptions, SlimNode} from './types.js';
import {sendingRpcErrors} from './worker-rpc-error.js';

/**
 * Builds the {@link Engine} for ONE node, on the thread that will run it.
 *
 * A FUNCTION, not a built engine, for two reasons that are both structural.
 * Building an engine is ASYNC (`createRevmEngine()` compiles wasm), and this way
 * the await belongs to `createNode()`'s own await instead of to the consumer's
 * module top level. And one engine instance serves ONE node (`connect()` binds it
 * to that node's state manager, and handing a connected engine to a second
 * `createNode()` throws), so an engine VALUE here would work once and then fail
 * the second time this worker was asked for a node.
 */
export type EngineSupplier = () => Engine | Promise<Engine>;

/** What the WORKER thread decides. Everything else is the main thread's. */
export interface WorkerHostOptions {
	/**
	 * Build this node's engine on THIS thread. Omit it for the default
	 * `@ethereumjs/evm` engine (what `worker-entry` does).
	 *
	 * Called ONCE PER `createNode()`, so each node gets its own engine instance:
	 *
	 *   exposeNode({createEngine: () => createRevmEngine({wasm})});
	 *
	 * `createEngine`, not `engine`, deliberately: `NodeOptions.engine` is an
	 * `Engine` everywhere else in this package, and one name meaning "an engine"
	 * in one place and "a function that makes one" in another is how the wrong
	 * value gets passed. The main thread's options are untouched by this: they
	 * still travel through `createWorkerNode()` as they always did, and an engine
	 * still cannot come from there (see `./worker-client.ts`'s refusal).
	 */
	createEngine?: EngineSupplier;
}

/**
 * THE ONE `SlimNode` PROXY. Comlink cannot pass the node itself (its methods are
 * functions and its subscription hands back another one), so this is the node's
 * public surface rendered for the boundary.
 *
 * TYPED `Required<SlimNode>` ON PURPOSE, and that annotation is the mechanism
 * rather than documentation: every member of `SlimNode` must be here or this does
 * not compile, today and for every field added later, INCLUDING an optional one
 * (which a bare `SlimNode` annotation would let through, since it demands only
 * the required members). `SlimNode` has no optional members today, so this costs
 * nothing now and stops the one thing the guarantee otherwise missed. The plain
 * values (`computeStateRoot`, `senderMode`, `engine`) clone across as-is; the client
 * reads them off the remote as promises.
 *
 * EVERY ASYNC METHOD IS WRAPPED IN {@link sendingRpcErrors}, so an `RpcError` it
 * throws crosses with its `code` and `data` (comlink alone keeps only the
 * message; `./worker-rpc-error.ts` has why, and why this is not a comlink
 * transfer handler). All of them, not only `request`: `getStateRoot` raises
 * `-32004`, and a method that raises none today costs nothing to cover.
 * `onNewHead` is the exception because it is synchronous and throws nothing.
 */
function nodeProxy(node: SlimNode): SlimNode {
	const forwarded: Required<SlimNode> = {
		request: sendingRpcErrors((args) => node.request(args)),
		mine: sendingRpcErrors(() => node.mine()),
		dumpState: sendingRpcErrors(() => node.dumpState()),
		loadState: sendingRpcErrors((state) => node.loadState(state)),
		getStateRoot: sendingRpcErrors(() => node.getStateRoot()),
		computeStateRoot: node.computeStateRoot,
		senderMode: node.senderMode,
		engine: node.engine,
		// newHeads over comlink: the callback arrives as a comlink proxy, and the
		// unsubscribe going back must be marked as one too, or it clones as `{}`.
		onNewHead: (cb) => proxy(node.onNewHead(cb)),
		// The port arrives TRANSFERRED (the client marks it so), which makes it this
		// thread's: the node serves it right here, and a consumer holding the other
		// end talks to this worker directly. The handle going back carries a
		// function, so it crosses as a proxy, like the unsubscribe above.
		serveOn: sendingRpcErrors(async (port) => proxy(await node.serveOn(port))),
		dispose: sendingRpcErrors(() => node.dispose()),
	};
	return forwarded;
}

/**
 * The comlink API a Worker exposes: `createNode(options)` with the SAME options
 * `createNode()` takes on the main thread, returning the node as a proxy.
 *
 * Use {@link exposeNode} unless you are composing this into a larger exposed API
 * of your own; this is the same object `worker-entry` exposes.
 */
export function createNodeWorkerApi(hostOptions: WorkerHostOptions = {}) {
	const {createEngine} = hostOptions;
	// THE REFUSAL IS A VALUE. Passing the ENGINE (or the promise of one) where its
	// FACTORY belongs is the one plausible mistake at this seam, and it is refused
	// with a real message rather than left to become a `TypeError` from inside
	// `createNode`. What it must NOT do is throw from here: this function runs while
	// the worker module is still evaluating, so a throw means `expose()` never runs,
	// the worker registers no message listener, and an awaited `createWorkerNode()`
	// on the main thread never settles at all. Recorded here, said out loud here,
	// and thrown where a caller can catch it.
	const refusal = engineSupplierRefusal(createEngine);
	// THE EARLY SIGNAL, on the thread the mistake was written on and at the moment
	// it was made: a developer with the worker console open reads it before anybody
	// asks for a node. It is not the only one, precisely because a bundled app's
	// worker console is easy to miss.
	if (refusal !== undefined) console.error(refusal);
	return {
		async createNode(options: NodeOptions) {
			// THE LATE SIGNAL, and the one the CALLER gets: comlink carries a thrown
			// error back as a rejection, so the main thread's `await createWorkerNode()`
			// fails with this text instead of hanging.
			if (refusal !== undefined) throw new Error(refusal);
			// The main thread's options pass through UNCHANGED; the engine, and only
			// the engine, is this thread's.
			const node = await createNode(
				createEngine ? {...options, engine: await createEngine()} : options,
			);
			return proxy(nodeProxy(node));
		},
	};
}

/**
 * The message for a `createEngine` that is not a factory, or `undefined` when it
 * is one (`undefined` itself being the default engine, not a mistake).
 *
 * TWO MESSAGES, because there are two mistakes and only one of them is "you
 * passed the wrong kind of thing". A THENABLE means the consumer CALLED the
 * factory here (`createEngine: createRevmEngine({wasm})`, one arrow away from
 * right), and telling them that value "must be a function" describes a value they
 * can see is nearly correct. So the promise case names itself and shows both
 * forms; the other case is a consumer holding a built engine, who needs to know
 * this thread builds one PER NODE.
 */
function engineSupplierRefusal(createEngine: unknown): string | undefined {
	if (createEngine === undefined || typeof createEngine === 'function') {
		return undefined;
	}
	const why =
		'It is called ONCE PER createNode(), because one engine instance serves one node (connect() binds it to the state of the node it is given to).';
	if (typeof (createEngine as {then?: unknown} | null)?.then === 'function') {
		return (
			'webevm/worker-host: `createEngine` must be a FUNCTION that builds an engine on this thread, and it was given a PROMISE of one: the factory was CALLED here instead of being passed. ' +
			'Write `{createEngine: () => createRevmEngine({wasm})}`, not `{createEngine: createRevmEngine({wasm})}`. ' +
			"Do not reach for `{createEngine: await createRevmEngine({wasm})}` either: a top-level `await` in a worker module can lose the main thread's first message, which hangs it for a different reason this package cannot fix. " +
			why
		);
	}
	return (
		`webevm/worker-host: \`createEngine\` must be a FUNCTION that builds an engine on this thread, not an engine (received ${describe(createEngine)}). ` +
		'Pass `{createEngine: () => createRevmEngine({wasm})}`, i.e. a function that returns the engine, rather than an engine you built already. ' +
		why
	);
}

/** What was passed, in one word a reader can match against their own code. */
function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	const kind = typeof value;
	return `${kind === 'object' ? 'an' : 'a'} ${kind}`;
}

/** The api {@link exposeNode} exposes, i.e. what a client should `wrap<>()`. */
export type NodeWorkerApi = ReturnType<typeof createNodeWorkerApi>;

/**
 * Expose a node factory on THIS thread. This is the whole of a consumer's worker module:
 *
 *   // my-worker.ts
 *   import {exposeNode} from 'webevm/worker-host';
 *   import {createRevmEngine} from 'webevm/revm';
 *   import wasm from 'revm-wasm/revm.wasm';
 *
 *   exposeNode({createEngine: () => createRevmEngine({wasm})});
 *
 * The main thread then drives it with the ordinary client, unchanged:
 * `createWorkerNode({worker, chainId, ...})`. Call it ONCE per thread: comlink's
 * `expose()` adds a message listener, so two of them answer the same message
 * twice.
 *
 * DO NOT `await` ANYTHING AT THIS MODULE'S TOP LEVEL BEFORE CALLING IT. A worker
 * module that awaits something slower than a microtask (fetching wasm, opening a
 * database) before `exposeNode()` can LOSE the main thread's first message, and
 * then `createWorkerNode()` never settles. Measured on Chromium and WebKit
 * (`work/notes/observations/a-top-level-await-in-a-worker-module-loses-the-first-message.md`).
 * Nothing here can fix it: there is no listener to register until this call runs.
 * The recipe above is safe because `() => createRevmEngine({wasm})` is
 * SYNCHRONOUS at module scope: the factory defers the await into `createNode()`,
 * which is one of the reasons `createEngine` is a function. If you must await
 * something first, do it INSIDE `createEngine` (or inside a wrapper it calls),
 * not above this line.
 *
 * Returns the exposed api, so `export const myApi = exposeNode(...)` is one line.
 */
export function exposeNode(hostOptions: WorkerHostOptions = {}): NodeWorkerApi {
	const api = createNodeWorkerApi(hostOptions);
	expose(api);
	return api;
}
