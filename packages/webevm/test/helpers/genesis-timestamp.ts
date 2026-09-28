/**
 * genesis-timestamp.ts: `genesisTimestamp` pins block 0's timestamp, and ONLY
 * block 0's.
 *
 *   - `pinned`: with `genesisTimestamp: T`, `eth_getBlockByNumber('0x0')`
 *     reports T, and a contract reading `TIMESTAMP` sees T in an `eth_call` at
 *     the head while block 0 is the head, and in one pinned to block 0 after a
 *     block is mined (the node has `stateHistory`). The mined block itself keeps
 *     `blockEnv.timestamp`, which is set to a DIFFERENT value, so neither option
 *     is read for the other.
 *   - `sameChain`: two nodes with the same options, `genesisTimestamp` included,
 *     created in DIFFERENT seconds (the gap is forced), run the same chain (the
 *     change-set chain of ./change-set.ts, whose mined blocks are pinned by
 *     `blockEnv.timestamp`) and end in byte-identical `dumpState`s, block hashes
 *     included. The CONTROL is the same pair without the option, whose genesis
 *     hashes must differ, so the gap is proven to be one the option closes.
 *   - `wallClock`: without the option, block 0 carries the wall clock, inside
 *     the window of this test's own clock around construction.
 *   - `roundTrip`: a dump of a node with T, loaded into a node without the option
 *     and into one with a different `genesisTimestamp`, keeps block 0 at T with
 *     the same hash (the dump's genesis wins; the option shapes a NEW genesis).
 *
 * ENGINE-PARAMETERISED: test/genesis-timestamp.spec.ts runs it on the default
 * engine through ./cut.ts, test/revm-genesis-timestamp.spec.ts on revm through
 * ./cut-revm.ts. The construction refusals and the worker pass-through involve
 * no engine and run on the default one only.
 */
import {createNode} from '../../src/node.js';
import {createWorkerNode} from '../../src/worker-client.js';
import type {NodeOptions, SlimNode} from '../../src/types.js';
import type {EngineFactory} from './conformance.js';
import {
	chainNodeOptions,
	runChangeSetChain,
	send,
	SENDER,
} from './change-set.js';
import {TIMESTAMP} from './post-state.js';

/** Block 0's pinned timestamp: distinct from the mined blocks' `TIMESTAMP`. */
export const GENESIS_T = 1_600_000_000n;
/** A second pinned genesis, for the round trip into a differently-pinned node. */
const OTHER_T = 1_234_567_890n;

/** `TIMESTAMP PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`: returns the block's timestamp. */
const TIMESTAMP_READER = '0x000000000000000000000000000000000000713e';
const TIMESTAMP_READER_CODE = '0x4260005260206000f3';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function block0(node: SlimNode) {
	return (await node.request({
		method: 'eth_getBlockByNumber',
		params: ['0x0', false],
	})) as {timestamp: string; hash: string};
}

async function readTimestamp(node: SlimNode, block: unknown): Promise<string> {
	const out = (await node.request({
		method: 'eth_call',
		params: [{to: TIMESTAMP_READER, data: '0x'}, block],
	})) as string;
	return BigInt(out).toString();
}

async function pinnedChecks(makeEngine: EngineFactory | undefined) {
	const node = await createNode(
		await chainNodeOptions(makeEngine, {
			genesisTimestamp: GENESIS_T,
			stateHistory: {blocks: 4},
			initialState: {
				[TIMESTAMP_READER]: {code: TIMESTAMP_READER_CODE},
			},
		}),
	);
	try {
		const engineId = node.engine.id;
		const genesisBlockTimestamp = BigInt((await block0(node)).timestamp);
		const callAtHeadWhileGenesis = await readTimestamp(node, 'latest');
		const callAtZeroWhileGenesis = await readTimestamp(node, '0x0');
		await send(node, 0, {to: SENDER, value: 1n, gas: 21000n});
		const head = BigInt(
			String(await node.request({method: 'eth_blockNumber'})),
		);
		const callAtZeroAfterMining = await readTimestamp(node, '0x0');
		const callAtHeadAfterMining = await readTimestamp(node, 'latest');
		const minedBlockTimestamp = BigInt(
			(
				(await node.request({
					method: 'eth_getBlockByNumber',
					params: ['latest', false],
				})) as {timestamp: string}
			).timestamp,
		);
		return {
			engineId,
			genesisBlockTimestamp: genesisBlockTimestamp.toString(),
			callAtHeadWhileGenesis,
			callAtZeroWhileGenesis,
			head: head.toString(),
			callAtZeroAfterMining,
			callAtHeadAfterMining,
			minedBlockTimestamp: minedBlockTimestamp.toString(),
		};
	} finally {
		await node.dispose();
	}
}

/**
 * Wait until the wall clock is in a later whole second than `since`, so two
 * nodes are really created in different seconds: the property is stated
 * directly rather than implied by a fixed sleep.
 */
async function nextSecond(since: number): Promise<void> {
	const s = Math.floor(since / 1000);
	while (Math.floor(Date.now() / 1000) <= s) await sleep(50);
}

async function runChainAt(
	makeEngine: EngineFactory | undefined,
	extra: NodeOptions,
) {
	const createdAt = Date.now();
	const node = await createNode(await chainNodeOptions(makeEngine, extra));
	try {
		const genesisHash = (await block0(node)).hash;
		await runChangeSetChain(node, async () => {});
		return {
			createdAtSecond: Math.floor(createdAt / 1000),
			genesisHash,
			dump: JSON.stringify(await node.dumpState()),
		};
	} finally {
		await node.dispose();
	}
}

async function sameChainChecks(makeEngine: EngineFactory | undefined) {
	const withOption = {genesisTimestamp: GENESIS_T};
	const a = await runChainAt(makeEngine, withOption);
	await nextSecond(a.createdAtSecond * 1000);
	const b = await runChainAt(makeEngine, withOption);
	const blocks = (JSON.parse(a.dump).blocks as unknown[]).length;

	// The control: the same gap without the option.
	const controlACreatedAt = Date.now();
	const controlA = await createNode(await chainNodeOptions(makeEngine));
	const controlAHash = (await block0(controlA)).hash;
	await controlA.dispose();
	await nextSecond(controlACreatedAt);
	const controlB = await createNode(await chainNodeOptions(makeEngine));
	const controlBHash = (await block0(controlB)).hash;
	await controlB.dispose();

	return {
		differentSeconds: a.createdAtSecond !== b.createdAtSecond,
		blocks,
		sameGenesisHash: a.genesisHash === b.genesisHash,
		identicalDumps: a.dump === b.dump,
		controlGenesisHashesDiffer: controlAHash !== controlBHash,
	};
}

async function wallClockChecks(makeEngine: EngineFactory | undefined) {
	const before = Math.floor(Date.now() / 1000);
	const node = await createNode(makeEngine ? {engine: await makeEngine()} : {});
	const after = Math.floor(Date.now() / 1000);
	try {
		const ts = Number(BigInt((await block0(node)).timestamp));
		return {before, after, ts};
	} finally {
		await node.dispose();
	}
}

async function roundTripChecks(makeEngine: EngineFactory | undefined) {
	const source = await createNode(
		await chainNodeOptions(makeEngine, {genesisTimestamp: GENESIS_T}),
	);
	await send(source, 0, {to: SENDER, value: 1n, gas: 21000n});
	const sourceBlock0 = await block0(source);
	const dump = await source.dumpState();
	await source.dispose();

	const loadInto = async (extra: NodeOptions) => {
		const node = await createNode(
			makeEngine ? {engine: await makeEngine(), ...extra} : extra,
		);
		try {
			await node.loadState(dump);
			const b = await block0(node);
			return {
				timestamp: BigInt(b.timestamp).toString(),
				sameHash: b.hash === sourceBlock0.hash,
			};
		} finally {
			await node.dispose();
		}
	};
	return {
		dumpedGenesisTimestamp: String(dump.blocks[0]?.timestamp),
		withoutOption: await loadInto({}),
		withOtherGenesisTimestamp: await loadInto({genesisTimestamp: OTHER_T}),
	};
}

export async function runGenesisTimestampChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const {makeEngine} = opts;
	return {
		genesisT: GENESIS_T.toString(),
		minedT: TIMESTAMP.toString(),
		pinned: await pinnedChecks(makeEngine),
		sameChain: await sameChainChecks(makeEngine),
		wallClock: await wallClockChecks(makeEngine),
		roundTrip: await roundTripChecks(makeEngine),
	};
}

/** Construction: absent and valid values accepted, everything else refused. */
export async function runGenesisTimestampConstructionChecks() {
	const attempt = async (value: unknown) => {
		try {
			const node = await createNode({
				genesisTimestamp: value,
			} as unknown as NodeOptions);
			await node.dispose();
			return 'accepted';
		} catch (e) {
			return String((e as Error).message);
		}
	};
	const invalid: Record<string, unknown> = {
		number: 1_600_000_000,
		negative: -1n,
		string: '1600000000',
		null: null,
		float: 1.5,
	};
	const refusals: Record<string, string> = {};
	for (const [name, value] of Object.entries(invalid))
		refusals[name] = await attempt(value);
	return {
		refusals,
		absent: await attempt(undefined),
		zero: await attempt(0n),
		pinned: await attempt(GENESIS_T),
	};
}

/** The option crosses `createWorkerNode` (and so `exposeNode`) to the node. */
export async function runGenesisTimestampWorkerChecks(workerUrl: string) {
	const worker = new Worker(workerUrl, {type: 'module'});
	const node = await createWorkerNode({worker, genesisTimestamp: GENESIS_T});
	try {
		return {
			genesisBlockTimestamp: BigInt((await block0(node)).timestamp).toString(),
		};
	} finally {
		await node.dispose();
		worker.terminate();
	}
}
