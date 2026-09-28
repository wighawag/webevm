/**
 * rpc-params.ts: PARAMETERS THAT USED TO BE IGNORED ARE NOW HONOURED OR REFUSED.
 *
 * Three silent wrong answers, each a request parameter the node dropped on the
 * floor and answered without:
 *
 *   * `eth_call` / `eth_estimateGas` STATE OVERRIDES (third parameter). Ignored,
 *     so the call ran against the real state and answered a question the caller
 *     had not asked. Now applied inside a checkpoint the request opens and
 *     reverts itself. {@link runStateOverrideChecks} is ENGINE-PARAMETERISED and
 *     also run in `'trie'` mode, because the two things that could go wrong are
 *     per engine and per state manager: an engine that does not SEE the override
 *     level, and a revert that does not REMOVE it (a leak into real state).
 *   * `eth_getLogs` `blockHash` (EIP-234). Ignored, so the logs of EVERY block
 *     came back.
 *   * `eth_feeHistory` `newestBlock`. Ignored, so the window always ended at the
 *     head.
 *
 * The last two are the node's own bookkeeping on every engine, so
 * {@link runLogsAndFeeHistoryChecks} runs once, on the default engine.
 */
import {createNode, type SlimNode} from '../../src/index.js';
import type {Engine} from '../../src/types.js';
import {
	createWalletClient,
	createPublicClient,
	custom,
	encodeFunctionData,
	type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/**
 * A hand-assembled probe: returns `[SLOAD(0), SLOAD(1), SELFBALANCE]` as three
 * words, so one call reads back a storage override, a stateDiff and a balance
 * override at once.
 *
 *   PUSH1 0 SLOAD PUSH1 0x00 MSTORE
 *   PUSH1 1 SLOAD PUSH1 0x20 MSTORE
 *   SELFBALANCE   PUSH1 0x40 MSTORE
 *   PUSH1 0x60 PUSH1 0 RETURN
 */
const PROBE_CODE = '0x6000546000526001546020524760405260606000f3';
/** `REVERT(0, 0)`: an overridden call that FAILS must unwind its overrides too. */
const REVERT_CODE = '0x60006000fd';
const PROBE_ADDR = '0x000000000000000000000000000000000000b0b0';
const FRESH_ADDR = '0x000000000000000000000000000000000000f00d';

export type Outcome = {ok: any} | {code: number; message: string};

async function outcome(
	node: SlimNode,
	method: string,
	params: unknown[],
): Promise<Outcome> {
	try {
		return {ok: await node.request({method, params})};
	} catch (e: any) {
		return {code: e?.code, message: String(e?.message ?? e)};
	}
}

/** The three words the probe returns, as decimal strings. */
function words(ret: unknown): string[] | unknown {
	if (typeof ret !== 'string' || ret.length !== 2 + 3 * 64) return ret;
	return [0, 1, 2].map((i) =>
		BigInt('0x' + ret.slice(2 + i * 64, 2 + (i + 1) * 64)).toString(),
	);
}

async function deployCounter(node: SlimNode) {
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});
	const hash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const counter = (await pub.getTransactionReceipt({hash}))
		.contractAddress as Hex;
	return {pub, wallet, counter};
}

const word = (n: number) => '0x' + n.toString(16).padStart(64, '0');

export async function runStateOverrideChecks(
	opts: {makeEngine?: () => Promise<Engine>; computeStateRoot?: boolean} = {},
) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		...(opts.computeStateRoot ? {computeStateRoot: true} : {}),
		...(opts.makeEngine ? {engine: await opts.makeEngine()} : {}),
	});
	const {wallet, counter} = await deployCounter(node);
	await wallet.writeContract({
		address: counter,
		abi: counterAbi,
		functionName: 'increment',
	});
	const numberData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'number',
	});
	const readNumber = async () =>
		BigInt(
			String(
				await node.request({
					method: 'eth_call',
					params: [{to: counter, data: numberData}, 'latest'],
				}),
			),
		).toString();

	// REAL state for the probe: code, two slots and a balance, so an override
	// that REPLACES storage (`state`) and one that PATCHES it (`stateDiff`) give
	// different, checkable answers.
	await node.request({method: 'evm_setCode', params: [PROBE_ADDR, PROBE_CODE]});
	await node.request({
		method: 'evm_setStorageAt',
		params: [PROBE_ADDR, '0x0', word(9)],
	});
	await node.request({
		method: 'evm_setStorageAt',
		params: [PROBE_ADDR, '0x1', word(8)],
	});
	await node.request({method: 'evm_setBalance', params: [PROBE_ADDR, '0x64']});
	const probeCall = {to: PROBE_ADDR, data: '0x'};
	const probe = async (overrides?: unknown) => {
		const o = await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			...(overrides === undefined ? [] : [overrides]),
		]);
		return 'ok' in o ? words(o.ok) : o;
	};

	const probeBefore = await probe();
	const probeStateDiff = await probe({
		[PROBE_ADDR]: {stateDiff: {'0x1': word(3)}},
	});
	const probeState = await probe({[PROBE_ADDR]: {state: {'0x1': word(3)}}});
	const probeBalance = await probe({[PROBE_ADDR]: {balance: '0x3e8'}});
	const probeAfter = await probe();

	// CODE + BALANCE + STORAGE on an address that holds NOTHING, then proof that
	// none of it is left behind.
	const fresh = await outcome(node, 'eth_call', [
		{to: FRESH_ADDR, data: '0x'},
		'latest',
		{
			[FRESH_ADDR]: {
				code: PROBE_CODE,
				balance: '0x3e8',
				nonce: '0x5',
				stateDiff: {'0x0': word(5), '0x1': word(7)},
			},
		},
	]);
	const freshAfter = {
		code: await node.request({
			method: 'eth_getCode',
			params: [FRESH_ADDR, 'latest'],
		}),
		balance: await node.request({
			method: 'eth_getBalance',
			params: [FRESH_ADDR, 'latest'],
		}),
		nonce: await node.request({
			method: 'eth_getTransactionCount',
			params: [FRESH_ADDR, 'latest'],
		}),
		slot0: await node.request({
			method: 'eth_getStorageAt',
			params: [FRESH_ADDR, '0x0', 'latest'],
		}),
	};

	// A REAL contract's storage, overridden and then read plainly again.
	const counterOverridden = await outcome(node, 'eth_call', [
		{to: counter, data: numberData},
		'latest',
		{[counter]: {stateDiff: {'0x0': word(42)}}},
	]);
	const counterAfter = await readNumber();

	// An overridden call that REVERTS must unwind its overrides like any other.
	const reverted = await outcome(node, 'eth_call', [
		{to: counter, data: numberData},
		'latest',
		{[counter]: {code: REVERT_CODE}},
	]);
	const afterRevert = {
		number: await readNumber(),
		codeUnchanged:
			(await node.request({
				method: 'eth_getCode',
				params: [counter, 'latest'],
			})) !== REVERT_CODE,
	};

	// eth_estimateGas SEES the override: an empty address is a 21000 transfer,
	// the same address with the probe's code costs more.
	const estimatePlain = await outcome(node, 'eth_estimateGas', [
		{from: account.address, to: FRESH_ADDR, data: '0x'},
		'latest',
	]);
	const estimateOverridden = await outcome(node, 'eth_estimateGas', [
		{from: account.address, to: FRESH_ADDR, data: '0x'},
		'latest',
		{[FRESH_ADDR]: {code: PROBE_CODE}},
	]);

	// REFUSED, and refused BEFORE anything is applied.
	const unsupportedField = await outcome(node, 'eth_call', [
		probeCall,
		'latest',
		{[PROBE_ADDR]: {balance: '0x1', movePrecompileToAddress: FRESH_ADDR}},
	]);
	const bothStateAndDiff = await outcome(node, 'eth_call', [
		probeCall,
		'latest',
		{[PROBE_ADDR]: {state: {}, stateDiff: {}}},
	]);
	const blockOverrides = await outcome(node, 'eth_call', [
		probeCall,
		'latest',
		null,
		{number: '0x99'},
	]);
	// MALFORMED VALUES are -32602 too, parsed before anything is applied, never a
	// raw `SyntaxError` and never silently truncated to 32 bytes.
	const malformed = {
		balance: await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			{[PROBE_ADDR]: {balance: 'abc'}},
		]),
		oddLengthCode: await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			{[PROBE_ADDR]: {code: '0x123'}},
		]),
		oversizedValue: await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			{[PROBE_ADDR]: {stateDiff: {'0x1': '0x01' + '00'.repeat(32)}}},
		]),
		oversizedSlot: await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			{[PROBE_ADDR]: {stateDiff: {['0x01' + '00'.repeat(32)]: word(1)}}},
		]),
		// A valid override FIRST, then a malformed one: nothing may be applied.
		validThenInvalid: await outcome(node, 'eth_call', [
			probeCall,
			'latest',
			{
				[PROBE_ADDR]: {balance: '0x1'},
				[FRESH_ADDR]: {nonce: 'nope'},
			},
		]),
	};
	const probeAfterRefusals = await probe();

	// The chain still mines normally afterwards: an override level left on the
	// stack would swallow this transaction's write into a level that is later
	// reverted, or leave the next `eth_call` reading through it.
	await wallet.writeContract({
		address: counter,
		abi: counterAbi,
		functionName: 'increment',
	});
	const counterAfterMining = await readNumber();

	return {
		probeBefore,
		probeStateDiff,
		probeState,
		probeBalance,
		probeAfter,
		fresh: 'ok' in fresh ? words(fresh.ok) : fresh,
		freshAfter,
		counterOverridden:
			'ok' in counterOverridden
				? BigInt(counterOverridden.ok).toString()
				: counterOverridden,
		counterAfter,
		reverted,
		afterRevert,
		estimatePlain,
		estimateOverridden,
		unsupportedField,
		bothStateAndDiff,
		blockOverrides,
		malformed,
		probeAfterRefusals,
		counterAfterMining,
	};
}

export async function runLogsAndFeeHistoryChecks() {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		// MINED blocks carry a different base fee from genesis, so a per-block
		// `baseFeePerGas` is distinguishable from the constant it used to be.
		blockEnv: {baseFeePerGas: 1_500_000_000n},
	});
	const {wallet, pub, counter} = await deployCounter(node);
	const incrementBlocks: {number: number; hash: string}[] = [];
	for (let i = 0; i < 2; i++) {
		const h = await wallet.writeContract({
			address: counter,
			abi: counterAbi,
			functionName: 'increment',
		});
		const r = await pub.getTransactionReceipt({hash: h});
		incrementBlocks.push({number: Number(r.blockNumber), hash: r.blockHash});
	}
	const head = Number(
		BigInt(String(await node.request({method: 'eth_blockNumber'}))),
	);

	// ---- eth_getLogs blockHash ----
	const all = (await node.request({
		method: 'eth_getLogs',
		params: [{address: counter}],
	})) as any[];
	const byHash = await outcome(node, 'eth_getLogs', [
		{address: counter, blockHash: incrementBlocks[0].hash},
	]);
	const byUnknownHash = await outcome(node, 'eth_getLogs', [
		{blockHash: '0x' + '11'.repeat(32)},
	]);
	const hashAndRange = await outcome(node, 'eth_getLogs', [
		{blockHash: incrementBlocks[0].hash, fromBlock: '0x0'},
	]);
	const garbageRange = await outcome(node, 'eth_getLogs', [
		{fromBlock: 'yesterday'},
	]);

	// ---- eth_feeHistory newestBlock ----
	const blockAt = async (n: number) =>
		(await node.request({
			method: 'eth_getBlockByNumber',
			params: ['0x' + n.toString(16), false],
		})) as any;
	const pinned = await outcome(node, 'eth_feeHistory', [
		'0x2',
		'0x' + incrementBlocks[0].number.toString(16),
		[50],
	]);
	const atHead = await outcome(node, 'eth_feeHistory', ['0x2', 'latest', []]);
	const beyondHead = await outcome(node, 'eth_feeHistory', [
		'0x1',
		'0x' + (head + 1).toString(16),
		[],
	]);
	const moreThanExists = await outcome(node, 'eth_feeHistory', [
		'0x64',
		'0x1',
		[],
	]);
	const hashAsNewest = await outcome(node, 'eth_feeHistory', [
		'0x1',
		incrementBlocks[0].hash,
		[],
	]);
	const garbageCount = await outcome(node, 'eth_feeHistory', [
		'abc',
		'latest',
		[],
	]);
	const zeroCount = await outcome(node, 'eth_feeHistory', [
		'0x0',
		'latest',
		[],
	]);
	const genesis = await blockAt(0);
	const incBlock = await blockAt(incrementBlocks[0].number);

	return {
		head,
		incrementBlocks,
		allLogBlocks: all.map((l) => Number(BigInt(l.blockNumber))),
		byHash:
			'ok' in byHash
				? (byHash.ok as any[]).map((l) => ({
						blockNumber: Number(BigInt(l.blockNumber)),
						blockHash: l.blockHash,
					}))
				: byHash,
		byUnknownHash,
		hashAndRange,
		garbageRange,
		pinned,
		atHead,
		beyondHead,
		moreThanExists,
		hashAsNewest,
		garbageCount,
		zeroCount,
		genesisBaseFee: genesis.baseFeePerGas,
		incBlockBaseFee: incBlock.baseFeePerGas,
	};
}

/**
 * `eth_getTransactionCount(addr, 'pending')` COUNTS QUEUED TRANSACTIONS under
 * manual mining, and so does `eth_fillTransaction`'s nonce: two sends before a
 * mine used to be given the SAME nonce, and the second was refused at mine time
 * as a replay.
 */
export async function runPendingNonceChecks() {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'manual'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const wallet = createWalletClient({account, chain, transport});
	const count = async (tag: string) =>
		node.request({
			method: 'eth_getTransactionCount',
			params: [account.address, tag],
		});
	const hashes: Hex[] = [];
	for (let i = 0; i < 2; i++)
		hashes.push(await wallet.sendTransaction({to: FRESH_ADDR, value: 1n}));
	const beforeMine = {
		pending: await count('pending'),
		latest: await count('latest'),
	};
	await node.mine();
	const statuses = [];
	for (const h of hashes) {
		const r = (await node.request({
			method: 'eth_getTransactionReceipt',
			params: [h],
		})) as any;
		statuses.push(r?.status ?? null);
	}
	return {
		beforeMine,
		statuses,
		afterMine: {pending: await count('pending'), latest: await count('latest')},
	};
}
