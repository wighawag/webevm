/**
 * snapshots.ts: `evm_snapshot` / `evm_revert` (and anvil's `anvil_snapshot` /
 * `anvil_revert`), held to Hardhat's and anvil's semantics, through the public
 * surface only. The sources each check is pinned against are cited at the
 * methods in src/node.ts.
 *
 *   - `ids`: one counter under both names, anvil's: the first id is "0x0", the
 *     next "0x1", and an id is never issued twice, even after the snapshot it
 *     named was consumed. `evm_revert` answers `true` for an id it holds and
 *     `false` for one it does not (never issued, or consumed); an id that is
 *     not a quantity is `-32602`.
 *   - `consumption`: reverting to a snapshot consumes it AND every snapshot
 *     taken after it; earlier ones stay usable.
 *   - `restore`: a revert restores everything a consumer can read (balances,
 *     nonces, code, storage, the block number and hashes, receipts,
 *     `eth_getTransactionByHash`, `eth_getLogs`, `getStateRoot()`, an
 *     `eth_call`, and pinned reads at every block in the `stateHistory`
 *     window), and an account created after the snapshot is gone. The chain
 *     then CONTINUES exactly as a control node that never ran the reverted
 *     work: the same next block hash, the same pinned reads, and a
 *     byte-identical `dumpState`.
 *   - `clock`: a pending next timestamp and the offset are restored, the
 *     interval is kept (anvil; see src/node.ts for Hardhat).
 *   - `pending`: under manual mining, the transactions waiting to be mined are
 *     restored too (both nodes restore their pool).
 *   - `persistence`: a successful revert saves the reverted chain, a refused one
 *     and a snapshot save nothing.
 *   - `viem`: viem's `createTestClient` `snapshot` / `revert` in all three
 *     modes.
 *
 * ENGINE-PARAMETERISED: test/snapshots.spec.ts runs it on the default engine
 * through ./cut.ts, test/revm-snapshots.spec.ts on revm through ./cut-revm.ts;
 * both are held to snapshots-expected.ts.
 */
import {createNode} from '../../src/node.js';
import type {NodeOptions, SerializedState, SlimNode} from '../../src/types.js';
import {createTestClient, custom} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {BASE_FEE, CHAIN_ID, PK, TIMESTAMP} from './post-state.js';

const account = privateKeyToAccount(PK);
/**
 * `SLOAD(0) + 1`, stored back in slot 0 and LOGged as the log's data:
 * `PUSH1 0 SLOAD PUSH1 1 ADD DUP1 PUSH1 0 SSTORE PUSH1 0 MSTORE PUSH1 32 PUSH1 0
 * LOG0 STOP`. Every call changes storage and emits one log.
 */
const COUNTER = '0x000000000000000000000000000000000000c0de';
const COUNTER_CODE = '0x6000546001018060005560005260206000a000';
/** An address nothing holds until a transfer after the snapshot creates it. */
const FRESH = '0x0000000000000000000000000000000000f2e5f1';
/** Its code is set by a cheat after the snapshot. */
const LATE = '0x000000000000000000000000000000000000147e';
const FUNDS = 10n ** 24n;

const q = (n: bigint) => '0x' + n.toString(16);
const rq = (node: SlimNode, method: string, params: unknown[] = []) =>
	node.request({method, params});

async function outcome(p: Promise<unknown>) {
	try {
		return {accepted: await p};
	} catch (e) {
		return {code: (e as any)?.code, message: String((e as Error)?.message)};
	}
}

async function nodeWith(
	makeEngine: EngineFactory | undefined,
	extra: NodeOptions = {},
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		genesisTimestamp: TIMESTAMP,
		blockEnv: {timestamp: TIMESTAMP},
		initialBalances: {[account.address]: FUNDS},
		initialState: {[COUNTER]: {code: COUNTER_CODE}},
		engine: makeEngine ? await makeEngine() : undefined,
		...extra,
	});
}

/** A signed transaction from `account`, at the node's next nonce. */
async function signed(node: SlimNode, to: string, value = 0n) {
	const nonce = Number(
		await rq(node, 'eth_getTransactionCount', [account.address, 'pending']),
	);
	return account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: 100_000n,
		maxFeePerGas: BASE_FEE,
		maxPriorityFeePerGas: 0n,
		to: to as `0x${string}`,
		value,
	});
}

async function send(node: SlimNode, to: string, value = 0n) {
	const r = (await rq(node, 'eth_sendRawTransactionSync', [
		await signed(node, to, value),
	])) as {transactionHash: string; status: string};
	return r.transactionHash;
}

/** Everything a consumer can read, at the head and at every block below it. */
async function readAll(node: SlimNode, txHashes: string[]) {
	const head = BigInt((await rq(node, 'eth_blockNumber')) as string);
	const blocks: unknown[] = [];
	const pinned: unknown[] = [];
	for (let n = 0n; n <= head; n++) {
		const b = (await rq(node, 'eth_getBlockByNumber', [q(n), false])) as {
			hash: string;
		};
		blocks.push(b);
		pinned.push({
			balance: await rq(node, 'eth_getBalance', [account.address, q(n)]),
			nonce: await rq(node, 'eth_getTransactionCount', [account.address, q(n)]),
			slot: await rq(node, 'eth_getStorageAt', [COUNTER, '0x0', q(n)]),
			fresh: await rq(node, 'eth_getBalance', [FRESH, q(n)]),
			lateCode: await rq(node, 'eth_getCode', [LATE, q(n)]),
		});
	}
	return {
		head: q(head),
		blocks,
		pinned,
		latest: {
			balance: await rq(node, 'eth_getBalance', [account.address, 'latest']),
			nonce: await rq(node, 'eth_getTransactionCount', [
				account.address,
				'latest',
			]),
			counterCode: await rq(node, 'eth_getCode', [COUNTER, 'latest']),
			slot: await rq(node, 'eth_getStorageAt', [COUNTER, '0x0', 'latest']),
			freshBalance: await rq(node, 'eth_getBalance', [FRESH, 'latest']),
			lateCode: await rq(node, 'eth_getCode', [LATE, 'latest']),
			call: await rq(node, 'eth_call', [
				{to: COUNTER, from: account.address},
				'latest',
			]),
		},
		receipts: await Promise.all(
			txHashes.map((h) => rq(node, 'eth_getTransactionReceipt', [h])),
		),
		transactions: await Promise.all(
			txHashes.map((h) => rq(node, 'eth_getTransactionByHash', [h])),
		),
		logs: await rq(node, 'eth_getLogs', [
			{fromBlock: '0x0', toBlock: 'latest'},
		]),
		root: await node.getStateRoot(),
	};
}

async function idChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	try {
		const first = await rq(node, 'evm_snapshot');
		const second = await rq(node, 'anvil_snapshot');
		const third = await rq(node, 'evm_snapshot', []);
		const revertSecond = await rq(node, 'anvil_revert', [second]);
		// The second consumed itself and the third.
		const revertThird = await rq(node, 'evm_revert', [third]);
		const revertSecondAgain = await rq(node, 'evm_revert', [second]);
		const afterConsumption = await rq(node, 'evm_snapshot');
		const neverIssued = await rq(node, 'evm_revert', ['0x99']);
		// anvil takes a quantity as a hex string or a JSON number.
		const asNumber = await rq(node, 'evm_revert', [0]);
		const refused = {
			notAQuantity: await outcome(rq(node, 'evm_revert', ['first'])),
			missing: await outcome(rq(node, 'evm_revert', [])),
			negative: await outcome(rq(node, 'anvil_revert', [-1])),
		};
		return {
			first,
			second,
			third,
			revertSecond,
			revertThird,
			revertSecondAgain,
			afterConsumption,
			neverIssued,
			asNumber,
			refused,
		};
	} finally {
		await node.dispose();
	}
}

async function consumptionChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine);
	const slot = async () =>
		BigInt(
			(await rq(node, 'eth_getStorageAt', [
				COUNTER,
				'0x0',
				'latest',
			])) as string,
		);
	try {
		const s0 = await rq(node, 'evm_snapshot');
		await send(node, COUNTER);
		const s1 = await rq(node, 'evm_snapshot');
		await send(node, COUNTER);
		const s2 = await rq(node, 'evm_snapshot');
		await send(node, COUNTER);
		const atThree = await slot();
		const toS1 = await rq(node, 'evm_revert', [s1]);
		const atS1 = await slot();
		const toS2 = await rq(node, 'evm_revert', [s2]);
		const toS0 = await rq(node, 'evm_revert', [s0]);
		const atS0 = await slot();
		const toS1Again = await rq(node, 'evm_revert', [s1]);
		return {
			atThree: Number(atThree),
			toS1,
			atS1: Number(atS1),
			toS2,
			toS0,
			atS0: Number(atS0),
			toS1Again,
		};
	} finally {
		await node.dispose();
	}
}

/**
 * The chain up to the snapshot, the same on the node that snapshots and on the
 * control that never runs the reverted work: two blocks of calls, and a cheat
 * issued AFTER the head was mined (an open change set, which the next block's
 * history record has to carry back to the head's values).
 */
async function beforeSnapshot(node: SlimNode) {
	const hashes = [await send(node, COUNTER), await send(node, COUNTER)];
	await rq(node, 'evm_setStorageAt', [COUNTER, '0x1', q(7n)]);
	return hashes;
}

/** The same continuation on both nodes, after the revert. */
async function continuation(node: SlimNode) {
	const hash = await send(node, COUNTER);
	const head = BigInt((await rq(node, 'eth_blockNumber')) as string);
	return {
		hash,
		block: await rq(node, 'eth_getBlockByNumber', ['latest', false]),
		// The cheat issued after the old head was mined belongs to the block
		// mined after it (README, State reads at past blocks): the new head reads
		// it, the old head does not. A revert that folded it into the old head
		// (as a dump and a load do) would answer 7 at both.
		slot1AtHead: await rq(node, 'eth_getStorageAt', [COUNTER, '0x1', q(head)]),
		slot1AtPrevious: await rq(node, 'eth_getStorageAt', [
			COUNTER,
			'0x1',
			q(head - 1n),
		]),
	};
}

async function restoreChecks(makeEngine: EngineFactory | undefined) {
	const opts: NodeOptions = {
		computeStateRoot: true,
		stateHistory: {blocks: 16},
	};
	const node = await nodeWith(makeEngine, opts);
	const control = await nodeWith(makeEngine, opts);
	try {
		const before = await beforeSnapshot(node);
		await beforeSnapshot(control);
		const id = await rq(node, 'evm_snapshot');
		const atSnapshot = await readAll(node, before);
		const dumpAtSnapshot = JSON.stringify(await node.dumpState());

		// The work a revert must undo: calls (storage, logs, receipts), a transfer
		// that creates an account, the four kinds of cheat, and an empty block.
		const after = [
			await send(node, COUNTER),
			await send(node, FRESH, 12345n),
			await send(node, COUNTER),
		];
		await rq(node, 'evm_setCode', [LATE, '0x6001']);
		await rq(node, 'evm_setBalance', [account.address, q(1n)]);
		await rq(node, 'evm_setStorageAt', [COUNTER, '0x0', q(99n)]);
		await rq(node, 'evm_mine');
		const moved = await readAll(node, before);
		const afterBlocks = await Promise.all(
			after.map(async (h) => {
				const r = (await rq(node, 'eth_getTransactionReceipt', [h])) as {
					blockHash: string;
				};
				return r.blockHash;
			}),
		);

		const reverted = await rq(node, 'evm_revert', [id]);
		const atRevert = await readAll(node, before);
		const gone = {
			receipts: await Promise.all(
				after.map((h) => rq(node, 'eth_getTransactionReceipt', [h])),
			),
			transactions: await Promise.all(
				after.map((h) => rq(node, 'eth_getTransactionByHash', [h])),
			),
			blocks: await Promise.all(
				afterBlocks.map((h) => rq(node, 'eth_getBlockByHash', [h, false])),
			),
		};
		const dumpAtRevert = JSON.stringify(await node.dumpState());

		const cont = await continuation(node);
		const contControl = await continuation(control);
		return {
			engineId: node.engine.id,
			reverted,
			movedHead: moved.head,
			snapshotHead: atSnapshot.head,
			movedDiffers: JSON.stringify(moved) !== JSON.stringify(atSnapshot),
			sameReads: JSON.stringify(atRevert) === JSON.stringify(atSnapshot),
			atSnapshot,
			atRevert,
			gone,
			sameDump: dumpAtRevert === dumpAtSnapshot,
			continuation: cont,
			continuationControl: contControl,
			sameContinuation: JSON.stringify(cont) === JSON.stringify(contControl),
			sameDumpAsControl:
				JSON.stringify(await node.dumpState()) ===
				JSON.stringify(await control.dumpState()),
			sameRootAsControl:
				(await node.getStateRoot()) === (await control.getStateRoot()),
		};
	} finally {
		await node.dispose();
		await control.dispose();
	}
}

async function headTimestamp(node: SlimNode) {
	const b = (await rq(node, 'eth_getBlockByNumber', ['latest', false])) as {
		timestamp: string;
	};
	return BigInt(b.timestamp);
}

async function clockChecks(makeEngine: EngineFactory | undefined) {
	const NEXT = TIMESTAMP + 5000n;
	// A pending next timestamp is restored: spent after the snapshot, it stamps
	// the first block after the revert again.
	const next = await nodeWith(makeEngine);
	// The offset is restored: what `evm_increaseTime` added after the snapshot is
	// undone, what it added before stays.
	const offset = await nodeWith(makeEngine);
	// The interval is kept: set after the snapshot, it still applies after the
	// revert, and one removed after the snapshot stays removed.
	const interval = await nodeWith(makeEngine);
	const removed = await nodeWith(makeEngine);
	try {
		await rq(next, 'evm_setNextBlockTimestamp', [q(NEXT)]);
		const nextId = await rq(next, 'evm_snapshot');
		await rq(next, 'evm_mine');
		const spent = await headTimestamp(next);
		await rq(next, 'evm_revert', [nextId]);
		await rq(next, 'evm_mine');
		const afterRevert = await headTimestamp(next);

		await rq(offset, 'evm_increaseTime', [1000]);
		const offsetId = await rq(offset, 'evm_snapshot');
		await rq(offset, 'evm_increaseTime', [500]);
		await rq(offset, 'evm_revert', [offsetId]);
		const totalAfterRevert = await rq(offset, 'evm_increaseTime', [0]);
		await rq(offset, 'evm_mine');
		const offsetBlock = (await headTimestamp(offset)) - TIMESTAMP;

		const intervalId = await rq(interval, 'evm_snapshot');
		await rq(interval, 'anvil_setBlockTimestampInterval', [7]);
		await rq(interval, 'evm_revert', [intervalId]);
		const parent = await headTimestamp(interval);
		await rq(interval, 'evm_mine');
		const intervalStep = (await headTimestamp(interval)) - parent;

		await rq(removed, 'anvil_setBlockTimestampInterval', [7]);
		const removedId = await rq(removed, 'evm_snapshot');
		const removedResult = await rq(
			removed,
			'anvil_removeBlockTimestampInterval',
		);
		await rq(removed, 'evm_revert', [removedId]);
		const stillRemoved = await rq(
			removed,
			'anvil_removeBlockTimestampInterval',
		);

		return {
			next: {
				spent: Number(spent - TIMESTAMP),
				afterRevert: Number(afterRevert - TIMESTAMP),
			},
			offset: {totalAfterRevert, block: Number(offsetBlock)},
			interval: {step: Number(intervalStep)},
			removed: {removedResult, stillRemoved},
		};
	} finally {
		for (const n of [next, offset, interval, removed]) await n.dispose();
	}
}

async function pendingChecks(makeEngine: EngineFactory | undefined) {
	const node = await nodeWith(makeEngine, {miningConfig: {type: 'manual'}});
	try {
		const a = (await rq(node, 'eth_sendRawTransaction', [
			await signed(node, COUNTER),
		])) as string;
		const id = await rq(node, 'evm_snapshot');
		const b = (await rq(node, 'eth_sendRawTransaction', [
			await signed(node, COUNTER),
		])) as string;
		const pendingBefore = await rq(node, 'eth_getTransactionCount', [
			account.address,
			'pending',
		]);
		await rq(node, 'evm_revert', [id]);
		const pendingAfter = await rq(node, 'eth_getTransactionCount', [
			account.address,
			'pending',
		]);
		await node.mine();
		const block = (await rq(node, 'eth_getBlockByNumber', [
			'latest',
			false,
		])) as {transactions: string[]};
		return {
			pendingBefore,
			pendingAfter,
			mined: block.transactions,
			a,
			b,
			bReceipt: await rq(node, 'eth_getTransactionReceipt', [b]),
		};
	} finally {
		await node.dispose();
	}
}

async function persistenceChecks(makeEngine: EngineFactory | undefined) {
	const saved: SerializedState[] = [];
	const node = await nodeWith(makeEngine, {
		stateHistory: {blocks: 4},
		persistence: {
			load: async () => null,
			save: async (s) => {
				saved.push(s);
			},
		},
	});
	try {
		await send(node, COUNTER);
		const start = saved.length;
		const id = await rq(node, 'evm_snapshot');
		const afterSnapshot = saved.length - start;
		const dumpAtSnapshot = JSON.stringify(await node.dumpState());
		await send(node, COUNTER);
		const afterTx = saved.length - start;
		const refused = await rq(node, 'evm_revert', ['0x42']);
		const afterRefused = saved.length - start;
		const reverted = await rq(node, 'evm_revert', [id]);
		const afterRevert = saved.length - start;
		const last = JSON.stringify(saved[saved.length - 1]);
		// A node restored from that save is the reverted chain.
		const reloaded = await nodeWith(makeEngine, {
			stateHistory: {blocks: 4},
			persistence: {
				load: async () => saved[saved.length - 1],
				save: async () => {},
			},
		});
		const reloadedSlot = await rq(reloaded, 'eth_getStorageAt', [
			COUNTER,
			'0x0',
			'latest',
		]);
		await reloaded.dispose();
		return {
			afterSnapshot,
			afterTx,
			refused,
			afterRefused,
			reverted,
			afterRevert,
			savedIsReverted: last === dumpAtSnapshot,
			reloadedSlot,
		};
	} finally {
		await node.dispose();
	}
}

async function viemChecks(makeEngine: EngineFactory | undefined) {
	const out: Record<string, unknown> = {};
	for (const mode of ['anvil', 'hardhat', 'ganache'] as const) {
		const node = await nodeWith(makeEngine);
		try {
			const test = createTestClient({mode, transport: custom(node)});
			const id = await test.snapshot();
			await send(node, COUNTER);
			// Not `test.setBalance`: in ganache mode viem sends ganache's own
			// `evm_setAccountBalance`, which this node does not answer.
			await rq(node, 'evm_setBalance', [FRESH, '0x5']);
			const slotMoved = await rq(node, 'eth_getStorageAt', [
				COUNTER,
				'0x0',
				'latest',
			]);
			const revertResult = await test.revert({id});
			out[mode] = {
				id,
				slotMoved,
				revertResult,
				slot: await rq(node, 'eth_getStorageAt', [COUNTER, '0x0', 'latest']),
				fresh: await rq(node, 'eth_getBalance', [FRESH, 'latest']),
				blockNumber: await rq(node, 'eth_blockNumber'),
			};
		} finally {
			await node.dispose();
		}
	}
	return out;
}

export async function runSnapshotChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const m = opts.makeEngine;
	return {
		ids: await idChecks(m),
		consumption: await consumptionChecks(m),
		restore: await restoreChecks(m),
		clock: await clockChecks(m),
		pending: await pendingChecks(m),
		persistence: await persistenceChecks(m),
		viem: await viemChecks(m),
	};
}
