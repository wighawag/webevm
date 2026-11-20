/**
 * state-cheat-aliases.ts: the four STATE CHEATS under Hardhat's and anvil's
 * names (`hardhat_setBalance` / `anvil_setBalance`, `..._setNonce`,
 * `..._setCode`, `..._setStorageAt`), held to the `evm_*` cheat each aliases.
 *
 *   - `sameEffect`: the same four cheats, issued under each of the three
 *     namespaces on three identical nodes (`computeStateRoot: true`,
 *     `stateHistory`, a pinned clock), leave the same `getStateRoot()`, the same
 *     next block (its hash, so its root), the same `stateHistory` change set
 *     (the block before still reads the old values, and the whole dump, undo log
 *     included, is byte-identical), and what the ENGINE executes agrees: a
 *     transaction from the account at the cheated nonce and balance is accepted,
 *     and an `eth_call` runs the cheated code over the cheated slot.
 *   - `results`: what each name returns. `evm_*` is `true` (unchanged);
 *     `hardhat_*` and `anvil_*` answer what anvil answers under both names:
 *     `null` for balance, nonce and code, `true` for storage.
 *   - `persistence`: a persistence adapter is saved exactly as often, and with
 *     exactly the same state, after an aliased cheat as after the `evm_*` one
 *     (not by the cheat itself; by the next mine, which carries it).
 *   - `viem`: viem's own `createTestClient` in `hardhat` and `anvil` modes drives
 *     `setBalance`, `setNonce`, `setCode` and `setStorageAt` unchanged, and the
 *     state it leaves has the `evm_*` root.
 *   - `refusals`: the aliases' parameter validation, per name (see the comment at
 *     the cheats in src/node.ts for the sources and the one difference from
 *     Hardhat). The `evm_*` names keep their own, more lenient, behaviour.
 *
 * ENGINE-PARAMETERISED: test/state-cheat-aliases.spec.ts runs it on the default
 * engine through ./cut.ts, test/revm-state-cheat-aliases.spec.ts on revm through
 * ./cut-revm.ts; both are held to state-cheat-aliases-expected.ts.
 */
import {createNode} from '../../src/node.js';
import type {NodeOptions, SerializedState, SlimNode} from '../../src/types.js';
import {createTestClient, custom} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {BASE_FEE, CHAIN_ID, PK, TIMESTAMP} from './post-state.js';

/** The cheated account; it holds nothing at genesis, so only a cheat funds it. */
const account = privateKeyToAccount(PK);
/** `PUSH1 0 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`: returns slot 0. */
const READER = '0x000000000000000000000000000000000000beef';
const READER_CODE = '0x60005460005260206000f3';
const BALANCE = 10n ** 21n;
const NONCE = 5n;
const WORD =
	'0x000000000000000000000000000000000000000000000000000000000000002a';

export const NAMESPACES = ['evm', 'hardhat', 'anvil'] as const;
type Namespace = (typeof NAMESPACES)[number];

const q = (n: bigint) => '0x' + n.toString(16);
const rq = (node: SlimNode, method: string, params: unknown[] = []) =>
	node.request({method, params});

async function nodeWith(
	makeEngine: EngineFactory | undefined,
	extra: NodeOptions = {},
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		genesisTimestamp: TIMESTAMP,
		blockEnv: {timestamp: TIMESTAMP},
		computeStateRoot: true,
		stateHistory: {blocks: 4},
		engine: makeEngine ? await makeEngine() : undefined,
		...extra,
	});
}

async function outcome(p: Promise<unknown>) {
	try {
		return {accepted: await p};
	} catch (e) {
		return {code: (e as any)?.code, message: String((e as Error)?.message)};
	}
}

/** The four cheats, under one namespace, in the order every check issues them. */
async function cheat(node: SlimNode, ns: Namespace) {
	return [
		await rq(node, `${ns}_setBalance`, [account.address, q(BALANCE)]),
		await rq(node, `${ns}_setNonce`, [account.address, q(NONCE)]),
		await rq(node, `${ns}_setCode`, [READER, READER_CODE]),
		await rq(node, `${ns}_setStorageAt`, [READER, '0x0', WORD]),
	];
}

async function headBlock(node: SlimNode) {
	return (await rq(node, 'eth_getBlockByNumber', ['latest', false])) as {
		number: string;
		hash: string;
		stateRoot: string;
	};
}

/** What the engine executes over the cheated state: a transaction and a call. */
async function executed(node: SlimNode) {
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce: Number(NONCE),
		gas: 100_000n,
		maxFeePerGas: BASE_FEE,
		maxPriorityFeePerGas: 0n,
		to: READER,
		value: 1n,
	} as any);
	const receipt = (await rq(node, 'eth_sendRawTransactionSync', [raw])) as {
		status: string;
	};
	const call = await rq(node, 'eth_call', [{to: READER}, 'latest']);
	return {txStatus: receipt.status, call};
}

async function sameEffectChecks(makeEngine: EngineFactory | undefined) {
	const out: Record<string, unknown> = {};
	let evmDump = '';
	for (const ns of NAMESPACES) {
		const node = await nodeWith(makeEngine);
		try {
			const rootBefore = await node.getStateRoot();
			const results = await cheat(node, ns);
			const rootAfterCheats = await node.getStateRoot();
			await rq(node, 'evm_mine');
			const mined = await headBlock(node);
			// The change set: the block BEFORE the cheats' block still reads the old
			// values, the cheats' block the new ones.
			const before = q(BigInt(mined.number) - 1n);
			const history = {
				balanceBefore: await rq(node, 'eth_getBalance', [
					account.address,
					before,
				]),
				balanceAt: await rq(node, 'eth_getBalance', [
					account.address,
					mined.number,
				]),
				nonceBefore: await rq(node, 'eth_getTransactionCount', [
					account.address,
					before,
				]),
				nonceAt: await rq(node, 'eth_getTransactionCount', [
					account.address,
					mined.number,
				]),
				codeBefore: await rq(node, 'eth_getCode', [READER, before]),
				codeAt: await rq(node, 'eth_getCode', [READER, mined.number]),
				slotBefore: await rq(node, 'eth_getStorageAt', [READER, '0x0', before]),
				slotAt: await rq(node, 'eth_getStorageAt', [
					READER,
					'0x0',
					mined.number,
				]),
			};
			const exec = await executed(node);
			const dump = JSON.stringify(await node.dumpState());
			if (ns === 'evm') evmDump = dump;
			out[ns] = {
				engineId: node.engine.id,
				results,
				rootMoved: rootAfterCheats !== rootBefore,
				rootAfterCheats,
				minedRoot: mined.stateRoot,
				minedHash: mined.hash,
				history,
				...exec,
				dumpHasHistory: dump.includes('"history"'),
				sameDumpAsEvm: dump === evmDump,
			};
		} finally {
			await node.dispose();
		}
	}
	return out;
}

async function persistenceChecks(makeEngine: EngineFactory | undefined) {
	const out: Record<string, unknown> = {};
	let evmSaved = '';
	for (const ns of NAMESPACES) {
		const saved: SerializedState[] = [];
		const node = await nodeWith(makeEngine, {
			persistence: {
				load: async () => null,
				save: async (s) => {
					saved.push(s);
				},
			},
		});
		try {
			const atStart = saved.length;
			await cheat(node, ns);
			const afterCheats = saved.length - atStart;
			await rq(node, 'evm_mine');
			const afterMine = saved.length - atStart;
			const last = JSON.stringify(saved[saved.length - 1]);
			if (ns === 'evm') evmSaved = last;
			out[ns] = {afterCheats, afterMine, sameSavedAsEvm: last === evmSaved};
		} finally {
			await node.dispose();
		}
	}
	return out;
}

async function viemChecks(
	makeEngine: EngineFactory | undefined,
	evmRoot: string,
) {
	const out: Record<string, unknown> = {};
	for (const mode of ['hardhat', 'anvil'] as const) {
		const node = await nodeWith(makeEngine);
		try {
			const test = createTestClient({mode, transport: custom(node)});
			const results = [
				await test.setBalance({address: account.address, value: BALANCE}),
				await test.setNonce({address: account.address, nonce: Number(NONCE)}),
				await test.setCode({address: READER, bytecode: READER_CODE}),
				// viem sends a numeric index as `numberToHex(0)`, i.e. "0x0".
				await test.setStorageAt({address: READER, index: 0, value: WORD}),
			];
			out[mode] = {
				results,
				balance: await rq(node, 'eth_getBalance', [account.address, 'latest']),
				nonce: await rq(node, 'eth_getTransactionCount', [
					account.address,
					'latest',
				]),
				code: await rq(node, 'eth_getCode', [READER, 'latest']),
				slot: await rq(node, 'eth_getStorageAt', [READER, '0x0', 'latest']),
				sameRootAsEvm: (await node.getStateRoot()) === evmRoot,
				...(await executed(node)),
			};
		} finally {
			await node.dispose();
		}
	}
	return out;
}

async function refusalChecks(makeEngine: EngineFactory | undefined) {
	const out: Record<string, unknown> = {};
	const A = account.address;
	for (const ns of ['hardhat', 'anvil'] as const) {
		const node = await nodeWith(makeEngine);
		try {
			const rootBefore = await node.getStateRoot();
			const refused = {
				balanceBadAddress: await outcome(
					rq(node, `${ns}_setBalance`, ['0x1234', '0x1']),
				),
				balanceNotANumber: await outcome(
					rq(node, `${ns}_setBalance`, [A, 'lots']),
				),
				balanceNegative: await outcome(rq(node, `${ns}_setBalance`, [A, -1])),
				balanceTooBig: await outcome(
					rq(node, `${ns}_setBalance`, [A, q(2n ** 256n)]),
				),
				nonceTooBig: await outcome(
					rq(node, `${ns}_setNonce`, [A, q(2n ** 64n)]),
				),
				codeNotHex: await outcome(rq(node, `${ns}_setCode`, [READER, 'xyz'])),
				codeOddLength: await outcome(
					rq(node, `${ns}_setCode`, [READER, '0x123']),
				),
				storageShortValue: await outcome(
					rq(node, `${ns}_setStorageAt`, [READER, '0x0', '0x2a']),
				),
				storageLongValue: await outcome(
					rq(node, `${ns}_setStorageAt`, [READER, '0x0', WORD + '00']),
				),
				storageSlotTooBig: await outcome(
					rq(node, `${ns}_setStorageAt`, [READER, q(2n ** 256n), WORD]),
				),
				storageSlotNotANumber: await outcome(
					rq(node, `${ns}_setStorageAt`, [READER, 'first', WORD]),
				),
			};
			const stateUnmoved = (await node.getStateRoot()) === rootBefore;

			// ACCEPTED shapes: the widest values, a slot written as a full 32-byte
			// word (leading zeros), a decimal string and a JSON number, an empty
			// code, and a nonce LOWERED below the current one (anvil allows it;
			// Hardhat refuses, see src/node.ts).
			const accepted = {
				balanceMax: await outcome(
					rq(node, `${ns}_setBalance`, [A, q(2n ** 256n - 1n)]),
				),
				balanceDecimal: await outcome(
					rq(node, `${ns}_setBalance`, [A, '1000']),
				),
				balanceNumber: await outcome(rq(node, `${ns}_setBalance`, [A, 1000])),
				nonceMax: await outcome(
					rq(node, `${ns}_setNonce`, [A, q(2n ** 64n - 1n)]),
				),
				nonceLowered: await outcome(rq(node, `${ns}_setNonce`, [A, '0x3'])),
				nonceAfterLowering: await rq(node, 'eth_getTransactionCount', [
					A,
					'latest',
				]),
				codeEmpty: await outcome(rq(node, `${ns}_setCode`, [READER, '0x'])),
				storageWordSlot: await outcome(
					rq(node, `${ns}_setStorageAt`, [READER, WORD, WORD]),
				),
				storageWordSlotRead: await rq(node, 'eth_getStorageAt', [
					READER,
					'0x2a',
					'latest',
				]),
			};
			out[ns] = {refused, stateUnmoved, accepted};
		} finally {
			await node.dispose();
		}
	}
	// The `evm_*` name keeps its own behaviour: a short value is left-padded.
	const node = await nodeWith(makeEngine);
	try {
		out.evmShortValue = {
			result: await outcome(
				rq(node, 'evm_setStorageAt', [READER, '0x0', '0x2a']),
			),
			read: await rq(node, 'eth_getStorageAt', [READER, '0x0', 'latest']),
		};
	} finally {
		await node.dispose();
	}
	return out;
}

export async function runStateCheatAliasChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const m = opts.makeEngine;
	const sameEffect = await sameEffectChecks(m);
	const evmRoot = (sameEffect.evm as {rootAfterCheats: string}).rootAfterCheats;
	return {
		sameEffect,
		persistence: await persistenceChecks(m),
		viem: await viemChecks(m, evmRoot),
		refusals: await refusalChecks(m),
	};
}
