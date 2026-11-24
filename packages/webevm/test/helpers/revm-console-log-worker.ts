/**
 * revm-console-log-worker.ts: A WORKER MODULE HOSTING A REVM-BACKED NODE WITH
 * CONSOLE LOGGING, the two worker-module options together:
 * `exposeNode({createEngine: () => createRevmEngine({wasm}), createConsoleLog:
 * () => consoleLog()})`. Driven from the page by `./worker-console-log.ts`
 * (`runRevmWorkerConsoleLogChecks`), which compares what a main-thread
 * subscriber receives with what a main-thread revm node delivers.
 *
 * As in `./console-log-worker.ts`, the worker's `console.log` is TEED onto the
 * report channel (every call still reaches the real worker console), so the
 * page can see that the default sink printed in the WORKER's console. It
 * reports on the `default` mode's channel, being that mode on another engine.
 */
import {exposeNode} from '../../src/worker-host.js';
import {createRevmEngine} from '../../src/revm.js';
import {consoleLog} from '../../src/console-log.js';
import revmWasm from 'revm-wasm/revm.wasm';
import {
	reportChannelName,
	type WorkerReport,
} from './console-log-worker-report.js';

const channel = new BroadcastChannel(reportChannelName('default'));
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

export const revmConsoleLogApi = exposeNode({
	createEngine: () => createRevmEngine({wasm: revmWasm}),
	createConsoleLog: () => consoleLog(),
});
