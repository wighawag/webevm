/**
 * block-clock.ts: THE NODE'S CLOCK and the time cheats that move it, held to
 * the methods and wire shapes anvil, hardhat and ganache already share.
 *
 *   - `next`: `evm_setNextBlockTimestamp` (returns null) stamps the next block,
 *     which a transaction's own `TIMESTAMP` reads (the EXECUTED value, stored by
 *     the transaction, not only the header the RPC reports); the clock then
 *     carries on from it.
 *   - `interval`: `anvil_setBlockTimestampInterval` (returns null) makes every
 *     block its parent's timestamp plus the interval, for a transaction's block
 *     and an empty one alike, 0 repeating the parent's; a next timestamp still
 *     wins for its one block; `anvil_removeBlockTimestampInterval` reports
 *     whether one was set.
 *   - `sameChain`: with an interval, the same chain run in DIFFERENT seconds
 *     hashes identically (the gap is forced): its timestamps no longer depend on
 *     when it ran.
 *   - `increase`: `evm_increaseTime` returns the total offset as a JSON number
 *     and moves the next block by it.
 *   - `mine`: `evm_mine` returns "0x0" and mines one block, empty under auto
 *     mining; `[timestamp]` stamps it; `[{timestamp, blocks}]` mines `blocks`,
 *     the first at `timestamp`; under manual mining it mines what is pending.
 *   - `anvilMine`: `anvil_mine [blocks, interval]` (and its `hardhat_mine`
 *     alias) returns null; on a pinned clock its blocks are exactly `interval`
 *     apart, 0 repeats the parent's, `[0]` mines none.
 *   - `viem`: viem's own `createTestClient` test actions in anvil, hardhat and
 *     ganache modes drive the node, on a pinned clock so every timestamp is
 *     exact.
 *   - `refusedKeepsNext`: a transaction the node refuses does not spend the
 *     next timestamp; the block that does get mined carries it.
 *   - `loadClears`: `loadState` drops a pending next timestamp.
 *   - `pinned`: with `blockEnv.timestamp` and no cheat, every mined block keeps
 *     the pinned value (the default is unchanged); an interval counts from it.
 *   - `refusals`: what each cheat refuses, with which code.
 *
 * ENGINE-PARAMETERISED: test/block-clock.spec.ts runs it on the default engine
 * through ./cut.ts, test/revm-block-clock.spec.ts on revm through ./cut-revm.ts.
 */
import {createNode} from '../../src/node.js';
import type {NodeOptions, SlimNode} from '../../src/types.js';
import {createTestClient, custom} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {BASE_FEE, CHAIN_ID, PK, TIMESTAMP} from './post-state.js';

const account = privateKeyToAccount(PK);
const GENESIS_T = 1_600_000_000n;
/** Far beyond any wall clock this test runs at, so no default can produce it. */
const FAR = 4_000_000_000n;
/** `TIMESTAMP PUSH1 0 SSTORE STOP`: stores its block's timestamp in slot 0. */
const STAMPER = '0x0000000000000000000000000000000000005714';
const STAMPER_CODE = '0x4260005500';

const q = (n: bigint) => '0x' + n.toString(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nodeWith(
	makeEngine: EngineFactory | undefined,
	extra: NodeOptions = {},
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		genesisTimestamp: GENESIS_T,
		initialBalances: {[account.address]: 10n ** 24n},
		initialState: {[STAMPER]: {code: STAMPER_CODE}},
		engine: makeEngine ? await makeEngine() : undefined,
		...extra,
	});
}

const rq = (node: SlimNode, method: string, params: unknown[] = []) =>
	node.request({method, params});

async function head(node: SlimNode) {
	const b = (await rq(node, 'eth_getBlockByNumber', ['latest', false])) as {
		number: string;
		hash: string;
		timestamp: string;
	};
	return {number: BigInt(b.number), hash: b.hash, ts: BigInt(b.timestamp)};
}

/** Every block's timestamp after block `from`, as offsets from `base`. */
async function stampsSince(node: SlimNode, from: bigint, base: bigint) {
	const to = (await head(node)).number;
	const out: number[] = [];
	for (let n = from + 1n; n <= to; n++) {
		const b = (await rq(node, 'eth_getBlockByNumber', [q(n), false])) as {
			timestamp: string;
		};
		out.push(Number(BigInt(b.timestamp) - base));
	}
	return out;
}

/** The timestamp the last stamping transaction EXECUTED under. */
async function stamped(node: SlimNode): Promise<bigint> {
	return BigInt(
		(await rq(node, 'eth_getStorageAt', [STAMPER, '0x0', 'latest'])) as string,
	);
}

async function signStamp(nonce: number): Promise<string> {
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: 100_000n,
		maxFeePerGas: BASE_FEE,
		maxPriorityFeePerGas: 0n,
		to: STAMPER,
	} as any);
}

async function stamp(node: SlimNode, nonce: number): Promise<void> {
	await rq(node, 'eth_sendRawTransactionSync', [await signStamp(nonce)]);
}

async function outcome(p: Promise<unknown>) {
	try {
		return {accepted: await p};
	} catch (e) {
		return {code: (e as any)?.code, message: String((e as Error)?.message)};
	}
}

async function nextChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		const set = await rq(node, 'evm_setNextBlockTimestamp', [q(FAR)]);
		await stamp(node, 0);
		const block = (await head(node)).ts;
		const executed = await stamped(node);
		await rq(node, 'evm_mine');
		const carriesOn = (await head(node)).ts - FAR;
		return {
			engineId: node.engine.id,
			set,
			block: block.toString(),
			executed: executed.toString(),
			far: FAR.toString(),
			carriesOn: Number(carriesOn),
		};
	} finally {
		await node.dispose();
	}
}

async function intervalChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		const set = await rq(node, 'anvil_setBlockTimestampInterval', [7]);
		const h0 = (await head(node)).ts;
		await stamp(node, 0);
		const txBlock = (await head(node)).ts - h0;
		const txExecuted = (await stamped(node)) - h0;
		await rq(node, 'evm_mine');
		await rq(node, 'evm_mine');
		const afterTwoEmpty = (await head(node)).ts - h0;
		const t = (await head(node)).ts + 1000n;
		await rq(node, 'evm_setNextBlockTimestamp', [q(t)]);
		await rq(node, 'evm_mine');
		const nextWins = (await head(node)).ts - t;
		await rq(node, 'evm_mine');
		const resumesFromParent = (await head(node)).ts - t;
		await rq(node, 'anvil_setBlockTimestampInterval', ['0x0']);
		const before = (await head(node)).ts;
		await rq(node, 'evm_mine');
		const zeroRepeats = (await head(node)).ts - before;
		const removed = [
			await rq(node, 'anvil_removeBlockTimestampInterval'),
			await rq(node, 'anvil_removeBlockTimestampInterval'),
		];
		return {
			set,
			txBlock: Number(txBlock),
			txExecuted: Number(txExecuted),
			afterTwoEmpty: Number(afterTwoEmpty),
			nextWins: Number(nextWins),
			resumesFromParent: Number(resumesFromParent),
			zeroRepeats: Number(zeroRepeats),
			removed,
		};
	} finally {
		await node.dispose();
	}
}

async function intervalChain(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		const createdAtSecond = Math.floor(Date.now() / 1000);
		await rq(node, 'anvil_setBlockTimestampInterval', [1]);
		for (let i = 0; i < 3; i++) await stamp(node, i);
		await rq(node, 'evm_mine');
		const h = await head(node);
		return {createdAtSecond, hash: h.hash, number: Number(h.number)};
	} finally {
		await node.dispose();
	}
}

async function sameChainChecks(makeEngine: EngineFactory | undefined) {
	const a = await intervalChain(makeEngine);
	while (Math.floor(Date.now() / 1000) <= a.createdAtSecond) await sleep(50);
	const b = await intervalChain(makeEngine);
	return {
		differentSeconds: b.createdAtSecond > a.createdAtSecond,
		blocks: a.number,
		sameHeadHash: a.hash === b.hash,
	};
}

async function increaseChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		await rq(node, 'evm_mine');
		const before = (await head(node)).ts;
		const total = await rq(node, 'evm_increaseTime', [3600]);
		await rq(node, 'evm_mine');
		const delta = (await head(node)).ts - before;
		const total2 = await rq(node, 'evm_increaseTime', ['0x3c']);
		return {total, delta: Number(delta), total2};
	} finally {
		await node.dispose();
	}
}

async function mineChecks(makeEngine: EngineFactory | undefined) {
	const auto = await nodeWith(makeEngine);
	const manual = await nodeWith(makeEngine, {miningConfig: {type: 'manual'}});
	try {
		const n0 = (await head(auto)).number;
		const result = await rq(auto, 'evm_mine');
		const h1 = await head(auto);
		const emptyBlock = (await rq(auto, 'eth_getBlockByNumber', [
			'latest',
			false,
		])) as {transactions: unknown[]};
		await rq(auto, 'evm_mine', [q(FAR)]);
		const withTimestamp = (await head(auto)).ts;
		const n1 = (await head(auto)).number;
		const objectResult = await rq(auto, 'evm_mine', [
			{timestamp: q(FAR + 100n), blocks: '0x3'},
		]);
		const objectBlocks = Number((await head(auto)).number - n1);
		const objectFirst = BigInt(
			(
				(await rq(auto, 'eth_getBlockByNumber', [q(n1 + 1n), false])) as {
					timestamp: string;
				}
			).timestamp,
		);

		await rq(manual, 'evm_setNextBlockTimestamp', [q(FAR)]);
		const hash = (await rq(manual, 'eth_sendRawTransaction', [
			await signStamp(0),
		])) as string;
		const pendingBefore = await rq(manual, 'eth_getTransactionReceipt', [hash]);
		await rq(manual, 'evm_mine');
		const receipt = (await rq(manual, 'eth_getTransactionReceipt', [hash])) as {
			blockNumber: string;
			status: string;
		};
		return {
			result,
			minedOne: Number(h1.number - n0),
			emptyTxs: emptyBlock.transactions.length,
			withTimestamp: withTimestamp.toString(),
			far: FAR.toString(),
			object: {
				result: objectResult,
				blocks: objectBlocks,
				first: Number(objectFirst - FAR),
			},
			manual: {
				pendingBefore,
				minedIn: Number(BigInt(receipt.blockNumber)),
				status: receipt.status,
				executed: (await stamped(manual)).toString(),
			},
		};
	} finally {
		await auto.dispose();
		await manual.dispose();
	}
}

/** A clock pinned by `blockEnv.timestamp`: no wall clock, so every stamp is exact. */
const pinnedClock = (makeEngine: EngineFactory | undefined) =>
	nodeWith(makeEngine, {blockEnv: {timestamp: TIMESTAMP}});

async function anvilMineChecks(makeEngine: EngineFactory | undefined) {
	const node = await pinnedClock(makeEngine);
	try {
		await rq(node, 'evm_mine');
		const n0 = (await head(node)).number;
		const base = (await head(node)).ts;
		const one = await rq(node, 'anvil_mine');
		const none = await rq(node, 'anvil_mine', ['0x0']);
		const n1 = (await head(node)).number;
		await rq(node, 'anvil_mine', ['0x3', '0x3c']);
		await rq(node, 'hardhat_mine', ['0x2', '0x0']);
		return {
			one,
			none,
			minedByDefaultAndZero: Number(n1 - n0),
			stamps: await stampsSince(node, n1, base),
		};
	} finally {
		await node.dispose();
	}
}

async function viemChecks(makeEngine: EngineFactory | undefined) {
	const out: Record<string, unknown> = {};
	for (const mode of ['anvil', 'hardhat', 'ganache'] as const) {
		const node = await pinnedClock(makeEngine);
		try {
			const test = createTestClient({mode, transport: custom(node)});
			await test.mine({blocks: 1});
			const n0 = (await head(node)).number;
			await test.setNextBlockTimestamp({timestamp: FAR});
			await test.mine({blocks: 1});
			const total = await test.increaseTime({seconds: 3600});
			await test.mine({blocks: 1});
			const row: Record<string, unknown> = {total};
			if (mode !== 'ganache') {
				// ganache's mine takes no interval; anvil and hardhat take one.
				await test.mine({blocks: 2, interval: 60});
			}
			if (mode === 'anvil') {
				// Only anvil defines the interval methods viem's actions call.
				await test.setBlockTimestampInterval({interval: 5});
				await test.mine({blocks: 1});
				await test.removeBlockTimestampInterval();
				await test.mine({blocks: 1});
			}
			row.stamps = await stampsSince(node, n0, FAR);
			out[mode] = row;
		} finally {
			await node.dispose();
		}
	}
	return out;
}

async function refusedKeepsNextChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		await stamp(node, 0);
		await rq(node, 'evm_setNextBlockTimestamp', [q(FAR)]);
		const replay = await outcome(stamp(node, 0));
		await rq(node, 'evm_mine');
		return {
			replayRefused: !('accepted' in replay),
			minedAt: (await head(node)).ts.toString(),
			far: FAR.toString(),
		};
	} finally {
		await node.dispose();
	}
}

async function loadClearsChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		await rq(node, 'evm_setNextBlockTimestamp', [q(FAR)]);
		await node.loadState(await node.dumpState());
		await rq(node, 'evm_mine');
		return {minedAt: (await head(node)).ts.toString(), far: FAR.toString()};
	} finally {
		await node.dispose();
	}
}

async function pinnedChecks(makeEngine: EngineFactory | undefined) {
	const node = await pinnedClock(makeEngine);
	try {
		await stamp(node, 0);
		const txBlock = (await head(node)).ts;
		await rq(node, 'evm_mine');
		const emptyBlock = (await head(node)).ts;
		await rq(node, 'anvil_setBlockTimestampInterval', [5]);
		await rq(node, 'evm_mine');
		const withInterval = (await head(node)).ts;
		return {
			pinned: TIMESTAMP.toString(),
			txBlock: txBlock.toString(),
			emptyBlock: emptyBlock.toString(),
			withInterval: withInterval.toString(),
		};
	} finally {
		await node.dispose();
	}
}

async function refusalChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		await rq(node, 'evm_mine');
		const h = (await head(node)).ts;
		return {
			setNextAtHead: await outcome(
				rq(node, 'evm_setNextBlockTimestamp', [q(h)]),
			),
			setNextBelowHead: await outcome(
				rq(node, 'evm_setNextBlockTimestamp', [q(h - 1n)]),
			),
			mineAtHead: await outcome(rq(node, 'evm_mine', [q(h)])),
			mineObjectAtHead: await outcome(
				rq(node, 'evm_mine', [{timestamp: q(h), blocks: '0x2'}]),
			),
			setNextNotANumber: await outcome(
				rq(node, 'evm_setNextBlockTimestamp', ['soon']),
			),
			setNextTooBig: await outcome(
				rq(node, 'evm_setNextBlockTimestamp', [q(2n ** 64n)]),
			),
			increaseNegative: await outcome(rq(node, 'evm_increaseTime', [-1])),
			increaseFraction: await outcome(rq(node, 'evm_increaseTime', ['1.5'])),
			intervalNegative: await outcome(
				rq(node, 'anvil_setBlockTimestampInterval', [-5]),
			),
			anvilMineNotANumber: await outcome(rq(node, 'anvil_mine', ['many'])),
			headUnmoved: (await head(node)).ts === h,
		};
	} finally {
		await node.dispose();
	}
}

export async function runBlockClockChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const m = opts.makeEngine;
	return {
		next: await nextChecks(m),
		interval: await intervalChecks(m),
		sameChain: await sameChainChecks(m),
		increase: await increaseChecks(m),
		mine: await mineChecks(m),
		anvilMine: await anvilMineChecks(m),
		viem: await viemChecks(m),
		refusedKeepsNext: await refusedKeepsNextChecks(m),
		loadClears: await loadClearsChecks(m),
		pinned: await pinnedChecks(m),
		refusals: await refusalChecks(m),
	};
}
