/**
 * log-block-timestamp.ts: every log the node serves carries `blockTimestamp`
 * (execution-apis#639), a hex quantity equal to the `timestamp` of the block the
 * log is in.
 *
 *   - `live`: a chain whose log-carrying blocks have DIFFERENT timestamps (the
 *     test waits for the wall clock to tick between mines, since mined blocks
 *     are stamped in whole seconds and can repeat), with several logs per block
 *     and per transaction and an empty block between them. Every log, read
 *     through `eth_getLogs` and through `eth_getTransactionReceipt`, is checked
 *     against BOTH `eth_getBlockByNumber` and `eth_getBlockByHash` of its block.
 *     Distinct timestamps are what make the check discriminating: a node that
 *     stamped every log with the head's (or genesis's) timestamp fails it.
 *   - `reloaded`: the same checks after the chain's `dumpState` is loaded into a
 *     FRESH node configured with nothing of its own (no genesis timestamp), and
 *     the timestamps must equal those served before the dump.
 *   - `dumpShape`: the keys of every log in the dump. `blockTimestamp` is looked
 *     up from the block at serve time rather than stored on the log, so the
 *     dump's log shape is the one older dumps already have; pinning the keys
 *     here is what makes "an older dump still answers with the timestamp" the
 *     same statement as `reloaded`.
 *
 * The block metadata on a log is written by the node, never by the engine, so
 * this runs on the default engine only. The conformance battery (both engines)
 * and the persistence-reload flow (both engines) assert `blockTimestamp` too.
 */
import {privateKeyToAccount} from 'viem/accounts';
import {createNode} from '../../src/node.js';
import type {SlimNode} from '../../src/types.js';
import {PK} from './post-state.js';

const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
/** Distinct from every mined block's wall-clock timestamp. */
const GENESIS_T = 1_600_000_000n;
/**
 * Runtime code that emits TWO logs per call:
 * `PUSH1 0x2a PUSH1 0 MSTORE` then `PUSH1 t PUSH1 32 PUSH1 0 LOG1` for t = 0xaa,
 * 0xbb, then `STOP`.
 */
const EMITTER = '0x000000000000000000000000000000000000e417';
const EMITTER_CODE = '0x602a60005260aa60206000a160bb60206000a100';

/** The fields a persisted `SerializedLog` has always had. */
const LEGACY_LOG_KEYS = [
	'address',
	'blockHash',
	'blockNumber',
	'data',
	'logIndex',
	'topics',
	'transactionHash',
	'transactionIndex',
];

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the wall clock is in a later whole second than now. */
async function nextSecond(): Promise<void> {
	const s = Math.floor(Date.now() / 1000);
	while (Math.floor(Date.now() / 1000) <= s) await sleep(50);
}

async function queue(node: SlimNode, nonce: number): Promise<string> {
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: 100_000n,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 0n,
		to: EMITTER,
	});
	return (await node.request({
		method: 'eth_sendRawTransaction',
		params: [raw],
	})) as string;
}

interface Checked {
	/** Every mismatch found, empty when every log agrees with its block. */
	mismatches: string[];
	/** How many logs each path served. */
	fromGetLogs: number;
	fromReceipts: number;
	/** The distinct blocks (and their distinct timestamps) the logs are in. */
	logBlocks: number;
	distinctTimestamps: number;
	/** block number -> timestamp (hex), as `eth_getBlockByNumber` reports it. */
	timestamps: Record<string, string>;
	/** `eth_getLogs` and the receipts serve the same log objects. */
	getLogsEqualsReceipts: boolean;
}

/** Check every served log of `node` against its block, both RPC paths. */
async function checkLogs(node: SlimNode, txHashes: string[]): Promise<Checked> {
	const mismatches: string[] = [];
	const blockCache = new Map<string, {byNumber: any; byHash: any}>();
	async function blockOf(log: any) {
		const key = `${log.blockNumber}/${log.blockHash}`;
		let b = blockCache.get(key);
		if (!b) {
			b = {
				byNumber: await node.request({
					method: 'eth_getBlockByNumber',
					params: [log.blockNumber, false],
				}),
				byHash: await node.request({
					method: 'eth_getBlockByHash',
					params: [log.blockHash, false],
				}),
			};
			blockCache.set(key, b);
		}
		return b;
	}
	async function check(where: string, log: any) {
		const at = `${where} block ${log.blockNumber} logIndex ${log.logIndex}`;
		if (!('blockTimestamp' in log)) {
			mismatches.push(`${at}: no blockTimestamp`);
			return;
		}
		if (typeof log.blockTimestamp !== 'string') {
			mismatches.push(
				`${at}: blockTimestamp is a ${typeof log.blockTimestamp}`,
			);
			return;
		}
		if (!HEX_QUANTITY.test(log.blockTimestamp)) {
			mismatches.push(`${at}: ${log.blockTimestamp} is not a hex quantity`);
		}
		const b = await blockOf(log);
		if (log.blockTimestamp !== b.byNumber?.timestamp) {
			mismatches.push(
				`${at}: ${log.blockTimestamp} != eth_getBlockByNumber ${b.byNumber?.timestamp}`,
			);
		}
		if (log.blockTimestamp !== b.byHash?.timestamp) {
			mismatches.push(
				`${at}: ${log.blockTimestamp} != eth_getBlockByHash ${b.byHash?.timestamp}`,
			);
		}
	}

	const fromGetLogs = (await node.request({
		method: 'eth_getLogs',
		params: [{fromBlock: '0x0', toBlock: 'latest'}],
	})) as any[];
	for (const log of fromGetLogs) await check('eth_getLogs', log);

	const fromReceipts: any[] = [];
	for (const h of txHashes) {
		const rcpt = (await node.request({
			method: 'eth_getTransactionReceipt',
			params: [h],
		})) as any;
		for (const log of rcpt.logs) {
			await check('receipt', log);
			fromReceipts.push(log);
		}
	}

	const timestamps: Record<string, string> = {};
	for (const {byNumber} of blockCache.values()) {
		timestamps[String(BigInt(byNumber.number))] = byNumber.timestamp;
	}
	return {
		mismatches,
		fromGetLogs: fromGetLogs.length,
		fromReceipts: fromReceipts.length,
		logBlocks: blockCache.size,
		distinctTimestamps: new Set(Object.values(timestamps)).size,
		timestamps,
		getLogsEqualsReceipts:
			JSON.stringify(fromGetLogs) === JSON.stringify(fromReceipts),
	};
}

export async function runLogBlockTimestampChecks() {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'manual'},
		genesisTimestamp: GENESIS_T,
		initialBalances: {[account.address]: 10n ** 24n},
		initialState: {[EMITTER]: {code: EMITTER_CODE}},
	});
	const txHashes: string[] = [];
	let nonce = 0;
	let reloadedNode: SlimNode | undefined;
	try {
		// Block 1: two log-emitting transactions (four logs).
		await nextSecond();
		txHashes.push(await queue(node, nonce++), await queue(node, nonce++));
		await node.mine();
		// Block 2: one (two logs).
		await nextSecond();
		txHashes.push(await queue(node, nonce++));
		await node.mine();
		// Block 3: empty, so the log blocks are not simply 1..N.
		await nextSecond();
		await node.mine();
		// Block 4: one (two logs), now the head.
		await nextSecond();
		txHashes.push(await queue(node, nonce++));
		await node.mine();

		const live = await checkLogs(node, txHashes);

		const dump = await node.dumpState();
		const dumpShape = Object.values(dump.receipts)
			.flatMap((r) => r.logs)
			.map((l) => Object.keys(l).sort().join(','));
		reloadedNode = await createNode({chainId: CHAIN_ID});
		await reloadedNode.loadState(dump);
		const reloaded = await checkLogs(reloadedNode, txHashes);

		return {
			genesisTimestamp: '0x' + GENESIS_T.toString(16),
			live,
			reloaded,
			dumpShape: {
				logs: dumpShape.length,
				distinctKeySets: [...new Set(dumpShape)],
				legacyKeys: LEGACY_LOG_KEYS.join(','),
			},
		};
	} finally {
		await node.dispose();
		await reloadedNode?.dispose();
	}
}
