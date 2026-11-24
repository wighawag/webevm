/**
 * console-log-worker.ts: A WORKER MODULE THAT ENABLES CONSOLE LOGGING, through
 * `exposeNode({createConsoleLog})` (ADR 0018, "In a Worker, console logging is
 * enabled in the worker module"), driven from the page by
 * `./worker-console-log.ts`.
 *
 * ONE module, SEVEN behaviours, chosen by the worker URL's `?consoleLog=` query
 * (read synchronously at module scope, so `exposeNode()` still runs before
 * anything could lose the main thread's first message), because a harness mount
 * serves ONE worker entry point:
 *
 *   - `default`: `createConsoleLog: () => consoleLog()`, the default sink.
 *   - `on-log`: a custom `onLog`, which must run HERE, on the worker.
 *   - `none`: no console logging at all (`exposeNode()`).
 *   - `factory-receives`: `createConsoleLog` AND a `createNode` factory, which
 *     reports whether the option it received is the one `createConsoleLog` built.
 *   - `factory-enables`: a `createNode` factory that enables console logging by
 *     itself, with no `createConsoleLog`.
 *   - `not-a-function`: the misuse, `createConsoleLog: consoleLog()` (the object).
 *   - `throws`: a `createConsoleLog` that throws.
 *
 * WHAT THIS THREAD DID IS REPORTED ON A `BroadcastChannel`, the one channel that
 * is not comlink's and that every engine under test delivers: the worker's
 * `console.log` is TEED (every call still reaches the real worker console, and a
 * copy of its arguments is posted), so the page can see what the default sink
 * printed in the worker's console; `onLog` and the factory post their own
 * reports. Nothing here touches the node the main thread drives.
 */
import {exposeNode} from '../../src/worker-host.js';
import {createNode} from '../../src/node.js';
import {consoleLog, type ConsoleLog} from '../../src/console-log.js';
import type {NodeOptions} from '../../src/types.js';
import {
	reportChannelName,
	THROWN,
	type WorkerReport,
} from './console-log-worker-report.js';

const mode = new URL(self.location.href).searchParams.get('consoleLog') ?? '';
const channel = new BroadcastChannel(reportChannelName(mode));
const post = (report: WorkerReport) => channel.postMessage(report);

/** `true` on a dedicated worker's global scope, which is where this must run. */
function onWorker(): boolean {
	const scope = (globalThis as {WorkerGlobalScope?: abstract new () => unknown})
		.WorkerGlobalScope;
	return scope !== undefined && self instanceof scope;
}

// THE TEE: the worker's own `console.log`, unchanged, plus a copy to the page.
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
	post({from: 'console.log', onWorker: onWorker(), args: args.map(String)});
	realLog(...args);
};

/** The option `createConsoleLog` built last, to compare against what the factory got. */
let built: ConsoleLog | undefined;
function buildDefault(): ConsoleLog {
	built = consoleLog();
	return built;
}

export const consoleLogApi =
	mode === 'default'
		? exposeNode({createConsoleLog: buildDefault})
		: mode === 'on-log'
			? exposeNode({
					createConsoleLog: () =>
						consoleLog({
							onLog: (entry) =>
								post({
									from: 'onLog',
									onWorker: onWorker(),
									source: entry.source,
									message: entry.message,
								}),
						}),
				})
			: mode === 'factory-receives'
				? exposeNode({
						createConsoleLog: buildDefault,
						createNode: async (options: NodeOptions) => {
							post({
								from: 'factory',
								hasConsoleLog: options.consoleLog !== undefined,
								isTheBuiltOne:
									options.consoleLog !== undefined &&
									options.consoleLog === built,
							});
							return createNode(options);
						},
					})
				: mode === 'factory-enables'
					? exposeNode({
							createNode: (options: NodeOptions) =>
								createNode({
									...options,
									consoleLog: consoleLog({onLog: () => {}}),
								}),
						})
					: mode === 'not-a-function'
						? // THE MISUSE, with the cast a JS consumer does not need.
							exposeNode({createConsoleLog: consoleLog() as never})
						: mode === 'throws'
							? exposeNode({
									createConsoleLog: () => {
										throw new Error(THROWN);
									},
								})
							: exposeNode();
