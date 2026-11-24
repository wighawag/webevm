/**
 * console-log-worker-report.ts: what `./console-log-worker.ts` (the worker) and
 * `./worker-console-log.ts` (the page) share. Its own module because the worker
 * module has side effects at import (`exposeNode()`, the `console.log` tee) that
 * must never run on the page.
 */

/** The channel the worker reports on and the page listens on, per mode. */
export function reportChannelName(mode: string): string {
	return `console-log-worker:${mode}`;
}

/** What the worker posts on the report channel. */
export type WorkerReport =
	| {from: 'console.log'; onWorker: boolean; args: string[]}
	| {
			from: 'onLog';
			onWorker: boolean;
			source: string;
			message: string;
	  }
	| {from: 'factory'; hasConsoleLog: boolean; isTheBuiltOne: boolean};

/** The throwing supplier's message; the spec asserts this text. */
export const THROWN = 'console-log-worker: this createConsoleLog throws';
