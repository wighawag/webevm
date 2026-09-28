/**
 * persistence-reload.ts — prove the slim node's IndexedDB persistence survives a
 * REAL page reload (not just a same-context dump/load), AND that eth_getLogs still
 * works after reload.
 *
 *   - phase 'write': create a node wired to createIndexedDBPersistence(), deploy a
 *     Counter, send a few increment() txs (each emits an Incremented event), and a
 *     value transfer. Persistence auto-saves to IndexedDB after each mined tx. We
 *     return the pre-reload facts (number, logs count, a balance) so the test can
 *     compare them to the post-reload read.
 *   - phase 'read' (after page.reload(), which WIPES all JS state): create a FRESH
 *     node with the SAME persistence adapter. It auto-loads from IndexedDB on
 *     creation. We then re-query everything THROUGH the freshly-loaded node:
 *     contract storage (number()), account balance, AND eth_getLogs — asserting
 *     the events (address/topics/data/logIndex/blockNumber) survived the reload.
 *
 * This is the canonical dapp scenario: persist a local chain to IndexedDB, reload
 * the tab, keep playing and keep querying event logs.
 *
 * THE BLOCK HEADER RIDES ALONG, and only the write phase is CONFIGURED. The write
 * node is created with a `blockEnv` carrying a distinctive coinbase and prevRandao;
 * the read node is created with NONE, so a `miner` / `mixHash` it can still report
 * after the reload came out of IndexedDB and not out of its own options. The bloom
 * of the block that carries a log is reported beside them for the same reason: it
 * is derived from the receipts at mine time, and a persistence layer that dropped
 * it would leave a consumer's bloom pre-filter finding nothing after a reload while
 * `eth_getLogs` (asserted above) still worked. Whether the bloom really admits that
 * log is `test/rpc-block.spec.ts`'s question; here the question is only whether the
 * value SURVIVED, which is why these are compared write-side against read-side
 * rather than against a literal.
 *
 * THE HISTORY RIDES ALONG TOO. Both nodes are created with `stateHistory`, and
 * each reports the same HISTORICAL reads (point reads and an `eth_call` pinned
 * to blocks below the head), which must agree across the reload: the undo log
 * is part of the dump IndexedDB holds, so a reloaded page serves the same
 * window it served before (task `state-history-persistence`).
 *
 * ENGINE-PARAMETERISED, like the conformance battery and the trusted-sender suite:
 * both phases take an optional engine factory, so the SAME flow runs on the default
 * `@ethereumjs/evm` engine (`persistence-reload.spec.ts`) and on
 * `webevm/revm` (`revm-persistence-reload.spec.ts`) rather than being
 * duplicated for it. Persistence is the node's, on either engine: state never left
 * it (ADR 0010), so what is dumped after a transaction is what the engine wrote
 * through the host callbacks and nothing else has to be collected first.
 */
import {
	createNode,
	createIndexedDBPersistence,
	type SlimNode,
} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {
	createWalletClient,
	createPublicClient,
	custom,
	parseAbiItem,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const DB_NAME = 'slim-reload-test';

/**
 * Per-engine options. The DATABASE NAME is one of them, and not for tidiness:
 * IndexedDB is per ORIGIN, so two runs of this flow sharing a database could have
 * the second one's `read` phase load what the FIRST one persisted and report
 * `loaded: true` without the engine under test having written anything. Each engine
 * gets its own database, so a run only ever reads its own writes.
 */
export interface PersistenceOptions {
	makeEngine?: EngineFactory;
	db?: string;
}
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;
const XFER_TO = '0x000000000000000000000000000000000000feed';
const INCREMENTED = parseAbiItem('event Incremented(uint256 newValue)');

/**
 * The write phase's block environment. The READ phase is deliberately given none:
 * these two values can only reach it through IndexedDB.
 */
const RELOAD_COINBASE = '0x00000000000000000000000000000000dbdbdbdb';
const RELOAD_PREV_RANDAO =
	'0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';

/** Both sides keep this many blocks readable below the head. */
const HISTORY = {blocks: 16};

/**
 * Reads pinned BELOW the head, on either side of the reload. `pinned` is the
 * block of the first increment (number() was 1 then), `beforeTransfer` the
 * block before the value transfer (XFER_TO held nothing), block 0 predates the
 * contract (no code).
 */
export interface HistoricalFacts {
	pinned: number;
	numberAtPinned: string;
	slot0AtPinned: string;
	feedBalanceBeforeTransfer: string;
	codeAtGenesis: string;
}

async function historicalFacts(
	node: SlimNode,
	address: `0x${string}`,
	pinned: number,
	beforeTransfer: number,
): Promise<HistoricalFacts> {
	const {pub} = clientsFor(node);
	const at = (n: number) => '0x' + n.toString(16);
	return {
		pinned,
		numberAtPinned: (
			await pub.readContract({
				address,
				abi: counterAbi,
				functionName: 'number',
				blockNumber: BigInt(pinned),
			})
		).toString(),
		slot0AtPinned: String(
			await node.request({
				method: 'eth_getStorageAt',
				params: [address, '0x0', at(pinned)],
			}),
		),
		feedBalanceBeforeTransfer: String(
			await node.request({
				method: 'eth_getBalance',
				params: [XFER_TO, at(beforeTransfer)],
			}),
		),
		codeAtGenesis: String(
			await node.request({method: 'eth_getCode', params: [address, '0x0']}),
		),
	};
}

/** What the RPC says about the header, on either side of the reload. */
export interface HeaderFacts {
	headMiner: string;
	headMixHash: string;
	/** The bloom of the block that carries the first Incremented log. */
	logBlockLogsBloom: string;
}

async function headerFacts(
	node: SlimNode,
	logBlockNumber: number,
): Promise<HeaderFacts> {
	const at = async (tag: string) =>
		(await node.request({
			method: 'eth_getBlockByNumber',
			params: [tag, false],
		})) as any;
	const head = await at('latest');
	const logBlock = await at(`0x${logBlockNumber.toString(16)}`);
	return {
		headMiner: String(head.miner),
		headMixHash: String(head.mixHash),
		logBlockLogsBloom: String(logBlock.logsBloom),
	};
}

function clientsFor(node: SlimNode) {
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	return {
		pub: createPublicClient({chain, transport}),
		wallet: createWalletClient({account, chain, transport}),
		node,
	};
}

export interface WriteResult extends HeaderFacts {
	historical: HistoricalFacts;
	/** Where the history facts are pinned, for the read phase to ask the same. */
	pinned: number;
	beforeTransfer: number;
	/** Which EVM the node came up on, so a run on the wrong engine is visible. */
	engineId: string;
	address: string;
	number: string;
	logCount: number;
	firstLogTopics: string[];
	blockNumber: number;
	feedBalance: string;
}

/** phase 'write': build state + persist to IndexedDB, then report pre-reload facts. */
export async function persistWrite(
	opts: PersistenceOptions = {},
): Promise<WriteResult> {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence: createIndexedDBPersistence({db: opts.db ?? DB_NAME}),
		initialBalances: {[account.address]: 10n ** 24n},
		blockEnv: {coinbase: RELOAD_COINBASE, prevRandao: RELOAD_PREV_RANDAO},
		stateHistory: HISTORY,
		engine: await opts.makeEngine?.(),
	});
	const {pub, wallet} = clientsFor(node);

	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const address = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress!;

	// 3 increments (each emits Incremented) + a value transfer.
	let pinned = 0;
	for (let i = 0; i < 3; i++) {
		const h = await wallet.writeContract({
			address,
			abi: counterAbi,
			functionName: 'increment',
		});
		const receipt = await pub.getTransactionReceipt({hash: h});
		if (i === 0) pinned = Number(receipt.blockNumber);
	}
	const xfer = await wallet.sendTransaction({to: XFER_TO, value: 7777n});
	const beforeTransfer =
		Number((await pub.getTransactionReceipt({hash: xfer})).blockNumber) - 1;

	const number = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	const logs = await pub.getLogs({
		address,
		event: INCREMENTED,
		fromBlock: 0n,
		toBlock: 'latest',
	});
	const feedBalance = (await pub.getBalance({address: XFER_TO})).toString();
	const blockNumber = Number(await pub.getBlockNumber());
	const engineId = node.engine.id;
	const header = await headerFacts(node, Number(logs[0]?.blockNumber ?? 0n));
	const historical = await historicalFacts(
		node,
		address,
		pinned,
		beforeTransfer,
	);

	await node.dispose();
	return {
		historical,
		pinned,
		beforeTransfer,
		engineId,
		address,
		number,
		logCount: logs.length,
		firstLogTopics: logs[0]?.topics ?? [],
		blockNumber,
		feedBalance,
		...header,
	};
}

export interface ReadResult extends HeaderFacts {
	/** The same historical reads, answered by the POST-RELOAD node. */
	historical: HistoricalFacts;
	/** Which EVM the POST-RELOAD node came up on. */
	engineId: string;
	loaded: boolean;
	number: string;
	blockNumber: number;
	feedBalance: string;
	// eth_getLogs AFTER reload:
	logCount: number;
	logIndexesOrdered: boolean;
	logBlockNumbersPresent: boolean;
	addressFilteredCount: number; // getLogs filtered by the contract address
	topicFilteredCount: number; // getLogs filtered by Incremented topic0
	lastEventValue: string; // decoded newValue of the last Incremented (== number)
}

/** phase 'read' (after reload): fresh node auto-loads IndexedDB; re-query all. */
export async function persistRead(
	address: string,
	opts: PersistenceOptions = {},
	pinnedAt: {pinned: number; beforeTransfer: number} = {
		pinned: 0,
		beforeTransfer: 0,
	},
): Promise<ReadResult> {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence: createIndexedDBPersistence({db: opts.db ?? DB_NAME}),
		// NOTE: no initialBalances and no blockEnv — state AND the block environment
		// the header reports must come ENTIRELY from IndexedDB. The same window as
		// the writer, so every block it served is one this node may serve.
		stateHistory: HISTORY,
		engine: await opts.makeEngine?.(),
	});
	const {pub} = clientsFor(node);

	const blockNumber = Number(await pub.getBlockNumber());
	const loaded = blockNumber > 0; // genesis-only would be 0

	const number = (
		await pub.readContract({
			address: address as `0x${string}`,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	const feedBalance = (await pub.getBalance({address: XFER_TO})).toString();

	// eth_getLogs through the freshly-loaded node, three ways:
	const all = await pub.getLogs({fromBlock: 0n, toBlock: 'latest'});
	const byAddr = await pub.getLogs({
		address: address as `0x${string}`,
		fromBlock: 0n,
		toBlock: 'latest',
	});
	const byTopic = await pub.getLogs({
		event: INCREMENTED,
		fromBlock: 0n,
		toBlock: 'latest',
	});

	// logIndex is WITHIN a block (correct EVM semantics); auto-mine puts each tx in
	// its own block, so the global order is by (blockNumber, logIndex). Assert that
	// tuple is strictly increasing across the returned logs.
	let ordered = true;
	for (let i = 1; i < byAddr.length; i++) {
		const prev =
			(BigInt(byAddr[i - 1].blockNumber ?? 0n) << 32n) +
			BigInt(byAddr[i - 1].logIndex ?? 0);
		const cur =
			(BigInt(byAddr[i].blockNumber ?? 0n) << 32n) +
			BigInt(byAddr[i].logIndex ?? 0);
		if (cur <= prev) ordered = false;
	}
	const blockNumbersPresent = byAddr.every(
		(l) => l.blockNumber != null && l.blockNumber > 0n,
	);
	const lastEventValue =
		byTopic.length > 0
			? BigInt(
					(byTopic[byTopic.length - 1] as any).args?.newValue ?? 0n,
				).toString()
			: '0';

	const engineId = node.engine.id;
	const header = await headerFacts(node, Number(byAddr[0]?.blockNumber ?? 0n));
	const historical = await historicalFacts(
		node,
		address as `0x${string}`,
		pinnedAt.pinned,
		pinnedAt.beforeTransfer,
	);
	await node.dispose();
	return {
		...header,
		historical,
		engineId,
		loaded,
		number,
		blockNumber,
		feedBalance,
		logCount: all.length,
		logIndexesOrdered: ordered,
		logBlockNumbersPresent: blockNumbersPresent,
		addressFilteredCount: byAddr.length,
		topicFilteredCount: byTopic.length,
		lastEventValue,
	};
}
