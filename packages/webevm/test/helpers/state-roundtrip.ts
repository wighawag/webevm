/**
 * state-roundtrip.ts — the node's STATE-OWNING features across a transaction
 * boundary, on whichever engine is installed: the `evm_set*` cheats and the
 * `dumpState` / `loadState` round trip.
 *
 * WHY IT IS ABOUT A BOUNDARY AND NOT ABOUT A FEATURE. State stays the node's on
 * every engine, read AND written through host callbacks with nothing copied in or
 * out (ADR 0010), and the consequence recorded there is that these features cost
 * nothing to keep. That consequence is only true while NOTHING CACHES STATE
 * ACROSS A TRANSACTION: an engine holding on to what it read, or writing back a
 * remembered account rather than the one it touched, keeps every single-transaction
 * assertion in this repo green and breaks exactly two things — a mutation the node
 * makes BETWEEN two transactions, and a dump taken AFTER one. So those are the two
 * round trips here:
 *
 *   1. **A CHEAT BETWEEN TWO TRANSACTIONS IS SEEN BY THE SECOND.** All four
 *      `evm_set*` cheats are applied after a transaction has executed and before
 *      the next one does, and the next one is built so that EXECUTION has to
 *      observe each of them: it runs on the cheated NONCE, pays out of the cheated
 *      BALANCE, reads the cheated STORAGE (`number` jumps 1 -> 41 -> 42, where a
 *      cached slot would give 2), and a third transaction CALLS the cheated CODE
 *      (a cached "no code here" would leave its slot at zero, with a success
 *      receipt). Every one of them is a value the engine can only have obtained by
 *      reading the node's live state at execution time.
 *   2. **A DUMP TAKEN AFTER A TRANSACTION RELOADS AND KEEPS BEHAVING.** The dump
 *      goes into a FRESH node with its own engine instance, the two are compared
 *      structurally, and then the SAME signed transaction is sent to both — the
 *      receipt and the post-state must be the same on the reloaded node as on the
 *      original. This is the round trip a persisted browser session performs on
 *      every reload, and a dump missing what the last transaction wrote passes a
 *      state-reading check while failing here.
 *
 * ENGINE-PARAMETERISED, like the conformance battery, the trusted-sender suite and
 * the post-state differential: {@link runStateRoundTrip} takes an optional engine
 * factory and builds every node it needs with it, so ONE implementation runs on the
 * default `@ethereumjs/evm` engine (`state-roundtrip.spec.ts`) and on
 * `webevm/revm` (`revm-state-roundtrip.spec.ts`). The absolute
 * expectations are shared too (../state-roundtrip-expected.ts): the two engines are
 * held to the SAME literals, which is what makes "adopting revm costs a consumer
 * nothing they already had" a measurement rather than a claim.
 *
 * WHICH EVM ACTUALLY RAN IT is counted at the seam (`transactionsByEngine`, the
 * wrapper from ./conformance.ts) rather than taken from `node.engine.id`, because
 * a suite whose transactions had quietly gone back to the default engine would pass
 * every assertion below while measuring nothing.
 *
 * WHY THE DUMP/LOAD ROUND TRIP LIVES HERE rather than in ./slim-node-checks.ts,
 * which has had one since long before there were engines. That file is a
 * multi-mode HONESTY suite: it builds `computeStateRoot: true` nodes and several stub
 * engines whose whole purpose is to be refused, so parameterising it by engine
 * would mean either dropping its trie half (relaxing an assertion) or running that
 * half on the default engine while claiming the injected one was under test. Its
 * round trip also stops at "the state came back", and what a cached-state bug
 * breaks is what happens NEXT — hence the follow-on transaction below. So its check
 * keeps its default-engine coverage untouched and this suite is the engine-
 * parameterised one, run on both.
 *
 * NOT HERE, ON PURPOSE: whether the two engines produce the SAME dump for the same
 * transactions. That is ./post-state.ts, which diffs a revm-backed node against a
 * default-engine one over seven state-shaped transactions and compares `dumpState`
 * structurally (one of them creates two accounts, which is what makes a byte
 * comparison of two correct dumps fail). Restating it here would be a second, weaker
 * copy of that bar.
 */
import {createNode, type SlimNode} from '../../src/index.js';
import {countingEngines, type EngineFactory} from './conformance.js';
import {structuralDump} from './post-state.js';
import {encodeFunctionData} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;

/** The genesis-funded sender: deploys the Counter and sends the follow-on txs. */
const account = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

/**
 * THE CHEATED SENDER: genesis-poor (it is absent from `initialBalances`) and at
 * nonce 0, until the cheats give it a balance and a nonce of 5. It then sends a
 * transaction that is valid ONLY against the cheated readings — a node or engine
 * still holding the pre-cheat account rejects it as a nonce error or as
 * unaffordable, which is the loud failure this account exists to produce.
 */
const cheatSender = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

/** Where `evm_setCode` puts code between two transactions. Nothing deploys here. */
const CHEATED_CODE_ADDRESS = '0x000000000000000000000000000000000000c0de';
/**
 * The cheated code: `PUSH1 63, PUSH1 07, SSTORE, STOP, STOP` — it writes 0x63 to
 * slot 7 when CALLED. Code, not storage, is what has to arrive: a transaction sent
 * to an address the engine believes is codeless succeeds, writes nothing, and
 * returns a receipt that looks exactly like this one.
 */
const CHEATED_CODE = '0x60636007550000';

const CHEAT_SENDER_BALANCE = 10n ** 18n;
const CHEAT_SENDER_NONCE = 5n;
/** The value the storage cheat writes into the Counter's `number` (slot 0). */
const CHEATED_NUMBER = 41n;

const MAX_FEE = 2_000_000_000n;
const MAX_PRIORITY_FEE = 1_000_000_000n;

const INCREMENT = encodeFunctionData({
	abi: counterAbi,
	functionName: 'increment',
});

/** Receipt fields that must be IDENTICAL between the original and reloaded node. */
const RECEIPT_FIELDS = [
	'transactionHash',
	'transactionIndex',
	'blockNumber',
	'from',
	'to',
	'contractAddress',
	'cumulativeGasUsed',
	'gasUsed',
	'effectiveGasPrice',
	'status',
	'type',
	'logsBloom',
] as const;

export interface StateRoundTripReport {
	/** The engine the node was BUILT with, as the node reports it. */
	engineId: string;
	/**
	 * WHICH EVM EXECUTED THE TRANSACTIONS, counted at the seam across every node
	 * this suite builds. `null` when nothing was injected: the node then builds its
	 * own default engine inside `createNode()` and there is nothing out here to
	 * wrap — nor anything to prove, since the default IS `@ethereumjs/evm`.
	 */
	transactionsByEngine: Record<string, number> | null;
	/** (1) the four cheats, applied between two transactions. */
	cheats: {
		numberAfterFirstTx: string;
		/** The cheated slot, read back BEFORE the second transaction runs. */
		counterSlot0AfterCheat: string;
		/** THE ASSERTION: 41 + 1, never 1 + 1. */
		numberAfterSecondTx: string;
		secondTxStatus: string;
		/** The cheated nonce the second transaction was accepted at. */
		secondTxNonce: string;
		cheatSenderNonceAfter: string;
		/** The cheated balance paid the transaction, to the wei. */
		cheatSenderChargedExactly: boolean;
		cheatSenderBalanceBefore: string;
		cheatedCodeSlot7Before: string;
		/** THE ASSERTION: the cheated CODE really executed. */
		cheatedCodeSlot7After: string;
		thirdTxStatus: string;
	};
	/** (2) dump -> fresh node -> the same transaction again. */
	reload: {
		reloadedEngineId: string;
		blockNumberOrigin: number;
		blockNumberReloaded: number;
		/** The reloaded node's own dump equals the one it was loaded from. */
		dumpStructurallyEqualAfterLoad: boolean;
		/** ...and still does after both nodes execute the same follow-on tx. */
		dumpStructurallyEqualAfterFollowOn: boolean;
		/** Every account reading agreed, before the follow-on tx. */
		readingsEqualAfterLoad: boolean;
		followOnReceiptsEqual: boolean;
		numberAfterFollowOnOrigin: string;
		numberAfterFollowOnReloaded: string;
	};
	/** Everything that disagreed. Empty = the round trips held. */
	mismatches: string[];
}

async function buildNode(
	makeEngine: EngineFactory | undefined,
	opts: {fund: boolean},
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		...(opts.fund
			? {initialBalances: {[account.address]: GENESIS_BALANCE}}
			: {}),
		engine: await makeEngine?.(),
	});
}

/** Sign an EIP-1559 transaction and mine it, returning the receipt. */
async function send(
	node: SlimNode,
	signer: typeof account,
	tx: {
		nonce: number;
		to?: `0x${string}`;
		data?: `0x${string}`;
		gas: bigint;
	},
): Promise<any> {
	const raw = await signRaw(signer, tx);
	return node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
}

async function signRaw(
	signer: typeof account,
	tx: {nonce: number; to?: `0x${string}`; data?: `0x${string}`; gas: bigint},
): Promise<string> {
	return signer.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce: tx.nonce,
		gas: tx.gas,
		maxFeePerGas: MAX_FEE,
		maxPriorityFeePerGas: MAX_PRIORITY_FEE,
		...(tx.to !== undefined ? {to: tx.to} : {}),
		...(tx.data !== undefined ? {data: tx.data} : {}),
	} as any);
}

async function balanceOf(node: SlimNode, address: string): Promise<bigint> {
	return BigInt(
		String(await node.request({method: 'eth_getBalance', params: [address]})),
	);
}

async function nonceOf(node: SlimNode, address: string): Promise<bigint> {
	return BigInt(
		String(
			await node.request({
				method: 'eth_getTransactionCount',
				params: [address],
			}),
		),
	);
}

async function slotOf(
	node: SlimNode,
	address: string,
	slot: string,
): Promise<string> {
	return String(
		await node.request({
			method: 'eth_getStorageAt',
			params: [address, slot, 'latest'],
		}),
	);
}

/** Everything one node says about one address, through the public surface only. */
async function readAccount(
	node: SlimNode,
	address: string,
	slots: string[] = [],
): Promise<Record<string, string>> {
	const out: Record<string, string> = {
		balance: String(await balanceOf(node, address)),
		nonce: String(await nonceOf(node, address)),
		code: String(
			await node.request({method: 'eth_getCode', params: [address, 'latest']}),
		),
	};
	for (const slot of slots)
		out[`slot${slot}`] = await slotOf(node, address, slot);
	return out;
}

/** `number()` read through `eth_call`, i.e. through the engine's read half. */
async function readNumber(node: SlimNode, counter: string): Promise<string> {
	const data = encodeFunctionData({abi: counterAbi, functionName: 'number'});
	const ret = String(
		await node.request({
			method: 'eth_call',
			params: [{to: counter, data}, 'latest'],
		}),
	);
	return BigInt(ret).toString();
}

export async function runStateRoundTrip(
	opts: {makeEngine?: EngineFactory} = {},
): Promise<StateRoundTripReport> {
	const mismatches: string[] = [];
	// ONE counter across every node this suite builds, so "the engine executed the
	// transactions" covers the reloaded node too.
	const transactionsByEngine: Record<string, number> | null = opts.makeEngine
		? {}
		: null;
	const makeEngine =
		opts.makeEngine && transactionsByEngine
			? countingEngines(opts.makeEngine, transactionsByEngine)
			: undefined;

	const node = await buildNode(makeEngine, {fund: true});

	// ---- transaction 0: deploy the Counter --------------------------------
	const deploy = await send(node, account, {
		nonce: 0,
		data: counterBytecode as `0x${string}`,
		gas: 500_000n,
	});
	const counter = String(deploy.contractAddress);

	// ---- transaction 1: increment, so `number` is 1 ------------------------
	await send(node, account, {
		nonce: 1,
		to: counter as `0x${string}`,
		data: INCREMENT,
		gas: 200_000n,
	});
	const numberAfterFirstTx = await readNumber(node, counter);

	// ---- THE CHEATS, between transaction 1 and transaction 2 ---------------
	// All four, applied with no transaction to notice them. What makes this the
	// interesting moment is that a transaction has already executed on the engine:
	// anything the engine remembered from it is now stale.
	await node.request({
		method: 'evm_setStorageAt',
		params: [counter, '0x00', `0x${CHEATED_NUMBER.toString(16)}`],
	});
	await node.request({
		method: 'evm_setCode',
		params: [CHEATED_CODE_ADDRESS, CHEATED_CODE],
	});
	await node.request({
		method: 'evm_setBalance',
		params: [cheatSender.address, `0x${CHEAT_SENDER_BALANCE.toString(16)}`],
	});
	await node.request({
		method: 'evm_setNonce',
		params: [cheatSender.address, `0x${CHEAT_SENDER_NONCE.toString(16)}`],
	});

	const counterSlot0AfterCheat = BigInt(
		await slotOf(node, counter, '0x0'),
	).toString();
	const cheatedCodeSlot7Before = await slotOf(
		node,
		CHEATED_CODE_ADDRESS,
		'0x7',
	);
	const cheatSenderBalanceBefore = await balanceOf(node, cheatSender.address);

	// ---- transaction 2: valid ONLY against the cheated state ---------------
	// Sent by the cheated account, at the cheated NONCE, paid out of the cheated
	// BALANCE, and it increments the cheated STORAGE. Three of the four cheats have
	// to have landed for this transaction to exist at all, and the fourth (code) is
	// transaction 3.
	const second = await send(node, cheatSender, {
		nonce: Number(CHEAT_SENDER_NONCE),
		to: counter as `0x${string}`,
		data: INCREMENT,
		gas: 200_000n,
	});
	const numberAfterSecondTx = await readNumber(node, counter);
	const cheatSenderBalanceAfter = await balanceOf(node, cheatSender.address);
	const cheatSenderChargedExactly =
		cheatSenderBalanceBefore - cheatSenderBalanceAfter ===
		BigInt(second.gasUsed) * BigInt(second.effectiveGasPrice);

	// ---- transaction 3: CALL the cheated code ------------------------------
	const third = await send(node, account, {
		nonce: 2,
		to: CHEATED_CODE_ADDRESS,
		data: '0x',
		gas: 200_000n,
	});
	const cheatedCodeSlot7After = await slotOf(node, CHEATED_CODE_ADDRESS, '0x7');

	// ---- (2) THE DUMP, taken after a transaction ---------------------------
	const dump = await node.dumpState();
	// A FRESH node with its OWN engine instance and NO genesis funding: everything
	// it knows has to arrive through `loadState`.
	const reloaded = await buildNode(makeEngine, {fund: false});
	await reloaded.loadState(dump);

	const reloadedDump = await reloaded.dumpState();
	const dumpStructurallyEqualAfterLoad =
		JSON.stringify(structuralDump(dump)) ===
		JSON.stringify(structuralDump(reloadedDump));
	if (!dumpStructurallyEqualAfterLoad)
		mismatches.push(
			`dumpState after loadState differs in CONTENT.\n  origin=${JSON.stringify(
				structuralDump(dump),
			)}\n  reloaded=${JSON.stringify(structuralDump(reloadedDump))}`,
		);

	const watched: [string, string[]][] = [
		[account.address, []],
		[cheatSender.address, []],
		[counter, ['0x0']],
		[CHEATED_CODE_ADDRESS, ['0x7']],
	];
	const diffReadings = async (when: string): Promise<boolean> => {
		let equal = true;
		for (const [address, slots] of watched) {
			const a = await readAccount(node, address, slots);
			const b = await readAccount(reloaded, address, slots);
			for (const field of Object.keys(a)) {
				if (a[field] !== b[field]) {
					equal = false;
					mismatches.push(
						`${when}: ${address}.${field} origin=${a[field]} reloaded=${b[field]}`,
					);
				}
			}
		}
		return equal;
	};
	const readingsEqualAfterLoad = await diffReadings('afterLoad');

	const blockNumberOrigin = Number(
		BigInt(String(await node.request({method: 'eth_blockNumber', params: []}))),
	);
	const blockNumberReloaded = Number(
		BigInt(
			String(await reloaded.request({method: 'eth_blockNumber', params: []})),
		),
	);
	if (blockNumberOrigin !== blockNumberReloaded)
		mismatches.push(
			`afterLoad: blockNumber origin=${blockNumberOrigin} reloaded=${blockNumberReloaded}`,
		);

	// ---- ...and the reloaded node KEEPS BEHAVING ---------------------------
	// The SAME BYTES to both nodes, so nothing but the node can differ.
	const followOn = await signRaw(account, {
		nonce: 3,
		to: counter as `0x${string}`,
		data: INCREMENT,
		gas: 200_000n,
	});
	const originReceipt: any = await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [followOn],
	});
	const reloadedReceipt: any = await reloaded.request({
		method: 'eth_sendRawTransactionSync',
		params: [followOn],
	});
	let followOnReceiptsEqual = true;
	for (const field of RECEIPT_FIELDS) {
		if (String(originReceipt?.[field]) !== String(reloadedReceipt?.[field])) {
			followOnReceiptsEqual = false;
			mismatches.push(
				`followOn: receipt.${field} origin=${String(
					originReceipt?.[field],
				)} reloaded=${String(reloadedReceipt?.[field])}`,
			);
		}
	}
	const originLogs = (originReceipt?.logs ?? []) as any[];
	const reloadedLogs = (reloadedReceipt?.logs ?? []) as any[];
	if (originLogs.length !== reloadedLogs.length) {
		followOnReceiptsEqual = false;
		mismatches.push(
			`followOn: log count origin=${originLogs.length} reloaded=${reloadedLogs.length}`,
		);
	} else {
		for (let i = 0; i < originLogs.length; i++) {
			for (const field of ['address', 'data', 'logIndex', 'topics']) {
				const a = JSON.stringify(originLogs[i][field]);
				const b = JSON.stringify(reloadedLogs[i][field]);
				if (a !== b) {
					followOnReceiptsEqual = false;
					mismatches.push(
						`followOn: logs[${i}].${field} origin=${a} reloaded=${b}`,
					);
				}
			}
		}
	}

	await diffReadings('afterFollowOn');
	const numberAfterFollowOnOrigin = await readNumber(node, counter);
	const numberAfterFollowOnReloaded = await readNumber(reloaded, counter);
	const dumpStructurallyEqualAfterFollowOn =
		JSON.stringify(structuralDump(await node.dumpState())) ===
		JSON.stringify(structuralDump(await reloaded.dumpState()));
	if (!dumpStructurallyEqualAfterFollowOn)
		mismatches.push('followOn: the two dumps differ in CONTENT');

	const report: StateRoundTripReport = {
		engineId: node.engine.id,
		transactionsByEngine,
		cheats: {
			numberAfterFirstTx,
			counterSlot0AfterCheat,
			numberAfterSecondTx,
			secondTxStatus: String(second.status),
			secondTxNonce: String(CHEAT_SENDER_NONCE),
			cheatSenderNonceAfter: String(await nonceOf(node, cheatSender.address)),
			cheatSenderChargedExactly,
			cheatSenderBalanceBefore: String(cheatSenderBalanceBefore),
			cheatedCodeSlot7Before: BigInt(cheatedCodeSlot7Before).toString(),
			cheatedCodeSlot7After: BigInt(cheatedCodeSlot7After).toString(),
			thirdTxStatus: String(third.status),
		},
		reload: {
			reloadedEngineId: reloaded.engine.id,
			blockNumberOrigin,
			blockNumberReloaded,
			dumpStructurallyEqualAfterLoad,
			dumpStructurallyEqualAfterFollowOn,
			readingsEqualAfterLoad,
			followOnReceiptsEqual,
			numberAfterFollowOnOrigin,
			numberAfterFollowOnReloaded,
		},
		mismatches,
	};

	await node.dispose();
	await reloaded.dispose();
	return report;
}
