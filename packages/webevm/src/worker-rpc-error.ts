/**
 * worker-rpc-error.ts: HOW AN `RpcError` CROSSES THE WORKER BOUNDARY WHOLE.
 * Shared by the two ends of it: `./worker-host.ts` (the node's thread) turns a
 * thrown `RpcError` into a plain {@link WireRpcError}, and `./worker-client.ts`
 * (the caller's thread) turns that back into a real `RpcError`.
 *
 * WHY IT IS NEEDED. comlink carries a thrown `Error` across as
 * `{message, name, stack}` and nothing else (its built-in `throw` transfer
 * handler), so every `RpcError` a worker-hosted node raised used to reach the
 * caller with `code === undefined` and no `data`: a `-32000` refusal, a `-32601`
 * method not found, and above all a `3 execution reverted` whose `data` is the
 * revert payload a viem client decodes into a custom error. A node served over a
 * port (`node.serveOn`, through `@eip-1193/over-port`) never had the gap, so the
 * two worker transports disagreed, and a worker node was not interchangeable
 * with a main-thread one for anything that branches on `code`.
 *
 * THE CHOICE: THROW A PLAIN OBJECT, NOT AN `Error`, AND TOUCH NO COMLINK STATE.
 * comlink's `throw` handler passes a thrown NON-Error value through structured
 * clone unchanged and rethrows it as-is on the other side. So the host throws
 * `{name: 'RpcError', code, message, data, stack}` in place of the `RpcError`,
 * which crosses with every field, and the client rebuilds the `RpcError` from it.
 * Rejected alternatives, and why:
 *
 *   - A custom comlink transfer handler (or replacing the built-in `throw` one).
 *     comlink's `transferHandlers` is a MODULE-GLOBAL map, so registering one
 *     changes error handling for every other comlink use in the consumer's app,
 *     which this package does not own (and a consumer's own `throw` handler, set
 *     before or after ours, would silently win or lose).
 *   - An envelope (`{ok: value}` / `{error: {...}}`) returned by every proxied
 *     method. Also global-state-free, but it rewraps EVERY SUCCESSFUL answer and
 *     changes every method's return type on the wire, which breaks the
 *     `Required<SlimNode>` typing of the host proxy the client relies on. The
 *     thrown object only changes the failure path, and only for `RpcError`.
 *
 * WHAT A DIRECT COMLINK CONSUMER SEES. Someone who `wrap()`s the worker-host api
 * themselves instead of using `createWorkerNode` now gets the plain object as the
 * rejection rather than an `Error` with only a message: it carries `code`,
 * `message` and `data` at the top level, so code reading `e.code` / `e.message`
 * works, and `e instanceof Error` does not. Every other error (a plain `Error`, a
 * `RangeError` from malformed input, the misused-`createEngine` refusal) is
 * left to comlink's own handling, exactly as before.
 *
 * `data` MUST BE STRUCTURED-CLONEABLE, as any value crossing a thread is. Every
 * `data` this package raises is (a hex string, or absent); a non-cloneable one
 * makes comlink report its own "Unserializable return value" instead.
 */
import {RpcError} from './types.js';

/** An `RpcError` rendered as a plain, structured-cloneable value. */
export interface WireRpcError {
	/** The marker the client recognises it by (with a numeric `code`). */
	webevmRpcError: true;
	name: 'RpcError';
	code: number;
	message: string;
	data: unknown;
	stack?: string;
}

/**
 * An `RpcError`, by class or by shape: a consumer's engine may throw one built
 * from ANOTHER copy of this package, which fails `instanceof` but is the same
 * error. The name AND a numeric code are required, since a numeric `code` alone
 * is also what a `DOMException` has.
 */
function isRpcError(e: unknown): e is RpcError {
	return (
		e instanceof RpcError ||
		(e instanceof Error &&
			e.name === 'RpcError' &&
			typeof (e as {code?: unknown}).code === 'number')
	);
}

function isWireRpcError(e: unknown): e is WireRpcError {
	return (
		typeof e === 'object' &&
		e !== null &&
		(e as {webevmRpcError?: unknown}).webevmRpcError === true &&
		typeof (e as {code?: unknown}).code === 'number' &&
		typeof (e as {message?: unknown}).message === 'string'
	);
}

/** HOST SIDE: an `RpcError` becomes a {@link WireRpcError}; anything else is unchanged. */
function toWire(e: unknown): unknown {
	if (!isRpcError(e)) return e;
	const wire: WireRpcError = {
		webevmRpcError: true,
		name: 'RpcError',
		code: e.code,
		message: e.message,
		data: e.data,
	};
	if (typeof e.stack === 'string') wire.stack = e.stack;
	return wire;
}

/** CLIENT SIDE: a {@link WireRpcError} becomes a real `RpcError`; anything else is unchanged. */
function fromWire(e: unknown): unknown {
	if (!isWireRpcError(e)) return e;
	const error = new RpcError(e.code, e.message, e.data);
	// The worker's stack, as comlink keeps it for a plain Error: it is where the
	// error was raised, which is what a reader of the stack wants.
	if (typeof e.stack === 'string') error.stack = e.stack;
	return error;
}

/**
 * HOST SIDE: `fn`, rejecting with a {@link WireRpcError} wherever it would have
 * rejected with an `RpcError`. Every other rejection passes through untouched.
 */
export function sendingRpcErrors<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => {
		try {
			return await fn(...args);
		} catch (e) {
			throw toWire(e);
		}
	};
}

/**
 * CLIENT SIDE: `fn`, rejecting with a real `RpcError` wherever the worker sent a
 * {@link WireRpcError}. Every other rejection passes through untouched.
 */
export function receivingRpcErrors<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
	return async (...args) => {
		try {
			return await fn(...args);
		} catch (e) {
			throw fromWire(e);
		}
	};
}
