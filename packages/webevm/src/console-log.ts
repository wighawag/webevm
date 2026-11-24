/**
 * console-log.ts: `webevm/console-log`, Solidity `console.log` for the node.
 *
 * ```ts
 * import {createNode} from 'webevm';
 * import {consoleLog} from 'webevm/console-log';
 *
 * const node = await createNode({consoleLog: consoleLog()});
 * // or route the entries yourself instead of printing them:
 * const node = await createNode({consoleLog: consoleLog({onLog: (e) => show(e.message)})});
 * ```
 *
 * OPT-IN, AND IN ITS OWN ENTRY POINT, like `webevm/revm` (./revm.ts). The
 * selector table, the ABI decoder and the formatter (./console-log-decoder.ts)
 * are reached only through this subpath; the core imports this module BY TYPE
 * ONLY ({@link ConsoleLogEntry}, {@link ConsoleLog}), so a consumer who does not
 * import it ships none of it (ADR 0018, and the bundle-size assertion in
 * `packages/benchmarks/test/evm.spec.ts`).
 *
 * WHAT {@link consoleLog} RETURNS is the injected object the node takes as its
 * `consoleLog` option. The node owns everything around it: it asks the engine to
 * record the calls into the console address
 * `0x000000000000000000636F6e736F6c652e6c6f67`, and after the engine returns it
 * passes each recorded input to {@link ConsoleLog.decode}, completes the
 * decoded call into a {@link ConsoleLogEntry} (its `source`, and for a mined
 * transaction its hash, block and index), and hands that to
 * {@link ConsoleLog.sink} and to its `onConsoleLog` subscribers. This object
 * never sees an address, a block or a transaction: it decodes bytes and prints
 * entries. The node calls the sink synchronously, never awaits it and catches
 * what it throws (ADR 0018); the sink itself adds no guard.
 *
 * See ./console-log-decoder.ts for what the table holds (and the decisions
 * behind it: both spellings of a signature, the all-at-once `uint` / `int`
 * alias, forge-std's `console.table` left out), how lax the decoder is, and how
 * closely the formatter follows Hardhat's printed line.
 */
import {
	decodeConsoleCall,
	type ConsoleLogArg,
	type DecodedConsoleCall,
} from './console-log-decoder.js';

export type {ConsoleLogArg, DecodedConsoleCall};

/** Where an entry came from. A mined transaction is `'transaction'` whichever
 * path mined it; the other three are reads. */
export type ConsoleLogSource =
	| 'transaction'
	| 'eth_call'
	| 'eth_estimateGas'
	| 'eth_fillTransaction';

/** An entry logged by a mined transaction. */
export interface ConsoleLogTransactionEntry extends DecodedConsoleCall {
	source: 'transaction';
	/** The hash of the transaction that logged it. */
	txHash: `0x${string}`;
	/** The number of the block the transaction was mined in. */
	blockNumber: number;
	/** The hash of that block. */
	blockHash: `0x${string}`;
	/** The transaction's index in that block. */
	txIndex: number;
}

/** An entry logged during a read, which is in no block. */
export interface ConsoleLogReadEntry extends DecodedConsoleCall {
	source: 'eth_call' | 'eth_estimateGas' | 'eth_fillTransaction';
}

/**
 * One `console.log` call as the node delivers it: the decoded `args` (integers
 * as `bigint`, addresses checksummed, bytes as `0x` hex, strings and booleans
 * as themselves), the formatted `message`, and its `source`.
 */
export type ConsoleLogEntry = ConsoleLogTransactionEntry | ConsoleLogReadEntry;

/** Options of {@link consoleLog}. */
export interface ConsoleLogOptions {
	/**
	 * Where every entry goes INSTEAD of the default, which prints
	 * `[webevm console.log] <message>` through the host's `console.log`.
	 */
	onLog?: (entry: ConsoleLogEntry) => void;
}

/**
 * The object the node's `consoleLog` option takes: the contract between this
 * subpath and the core.
 */
export interface ConsoleLog {
	/**
	 * Decode the input bytes of ONE call frame into the console address into its
	 * arguments and formatted message. `undefined` for malformed input (fewer
	 * than four bytes, an unknown selector, a truncated head, a dynamic offset or
	 * length past the end), which the node ignores. Never throws.
	 */
	decode(input: Uint8Array): DecodedConsoleCall | undefined;
	/**
	 * Deliver one entry: print it (the default) or hand it to `onLog`.
	 * Synchronous; the node never awaits it.
	 */
	sink(entry: ConsoleLogEntry): void;
}

/** The prefix the default sink prints before every message. */
const PREFIX = '[webevm console.log]';

/**
 * The default sink. The message is passed as the SECOND argument so the host's
 * `console.log` never reads it as a format string (only the first argument is
 * one, and the prefix holds no `%`).
 */
function printEntry(entry: ConsoleLogEntry): void {
	console.log(PREFIX, entry.message);
}

/**
 * Build the node's `consoleLog` option: Hardhat and forge-std `console.log`
 * calls decoded and printed through `console.log` with a
 * `[webevm console.log]` prefix, or handed to `onLog` instead.
 */
export function consoleLog(options: ConsoleLogOptions = {}): ConsoleLog {
	const {onLog} = options;
	return {
		decode: decodeConsoleCall,
		sink: onLog === undefined ? printEntry : (entry) => onLog(entry),
	};
}
