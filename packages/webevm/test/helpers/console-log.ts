/**
 * console-log.ts: `webevm/console-log` in a real browser, with no node. The spec
 * (../console-log.spec.ts) parses the vendored console libraries, encodes the
 * calldata and computes every expectation on the Node side; this half only runs
 * the module under test where it ships (a browser, no `node:util`) and reports
 * what it did:
 *   - every vector through `consoleLog().decode`, its args serialised
 *     (`bigint` as `{bigint: '<decimal>'}`, which `page.evaluate` would not carry)
 *   - the table's signature list
 *   - the default sink against a spied `console.log`, and `onLog` replacing it
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {consoleLog, type ConsoleLogEntry} from '../../src/console-log.js';
import {consoleLogSignatures} from '../../src/console-log-decoder.js';
import {hexToBytes} from 'viem';

export type SerializedArg = string | boolean | {bigint: string};

export interface ConsoleLogParams {
	/** `[id, calldata hex]` */
	vectors: Array<[string, `0x${string}`]>;
}

export interface DecodeOutcome {
	threw?: string;
	decoded?: {args: SerializedArg[]; message: string} | null;
}

function serializeArg(arg: unknown): SerializedArg {
	if (typeof arg === 'bigint') return {bigint: arg.toString(10)};
	return arg as string | boolean;
}

export async function runConsoleLogChecks(params: ConsoleLogParams) {
	const log = consoleLog();
	const decoded: Record<string, DecodeOutcome> = {};
	for (const [id, hex] of params.vectors) {
		try {
			const r = log.decode(hexToBytes(hex));
			decoded[id] = {
				decoded:
					r === undefined
						? null
						: {args: r.args.map(serializeArg), message: r.message},
			};
		} catch (e) {
			decoded[id] = {threw: String((e as Error)?.message ?? e)};
		}
	}

	// ---- the sink ----
	const entry: ConsoleLogEntry = {
		args: ['balance %s', 42n],
		message: 'balance 42',
		source: 'eth_call',
	};
	const printed: unknown[][] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		printed.push(args);
	};
	let defaultPrinted: unknown[][];
	let onLogPrinted: unknown[][];
	const received: ConsoleLogEntry[] = [];
	try {
		consoleLog().sink(entry);
		defaultPrinted = printed.splice(0);
		consoleLog({onLog: (e) => received.push(e)}).sink(entry);
		onLogPrinted = printed.splice(0);
	} finally {
		console.log = original;
	}

	return {
		decoded,
		signatures: consoleLogSignatures(),
		sink: {
			defaultPrinted,
			onLogPrinted,
			onLogReceivedCount: received.length,
			onLogReceivedSameEntry: received[0] === entry,
		},
	};
}
