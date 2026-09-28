/**
 * historical-call.ts: with `stateHistory: {blocks: N}`, `eth_call` and
 * `eth_estimateGas` pinned to a block K in the window EXECUTE against K's state
 * and K's block environment, and leave the head exactly as it was.
 *
 * Five parts, each asserted in `test/historical-call-expected.ts`:
 *
 *  - CONSUMER: the shape bomber-world uses, through viem. Read the block number,
 *    mine twice (each block changes storage and emits a log), then `eth_getLogs`
 *    up to the pinned block and a `readContract` at the pinned block must
 *    describe the same moment.
 *  - BLOCK ENVIRONMENT: the `BlockEnvProbe` contract called at K reports K's
 *    `NUMBER` / `TIMESTAMP` / `COINBASE` / `PREVRANDAO` / `BASEFEE` / `GASLIMIT`,
 *    a storage view reports K's value, and `BLOCKHASH(K)` is zero while
 *    `BLOCKHASH(K-1)` is the real hash. So that every field can DIFFER between K
 *    and the head, K is the head of a node built with one `blockEnv` whose dump is
 *    loaded into a node built with another, which then mines on.
 *  - RECONSTRUCTION: accounts created, self-destructed and storage-cleared after
 *    K read as they were at K (absent, present with all slots), `EXTCODESIZE` of
 *    a contract created after K is 0 at K, `eth_estimateGas` at K reflects K's
 *    state, state overrides compose on top of K, and none of it (a call, an
 *    estimate, a call that reverts, an estimate that throws) moves the head.
 *  - DIFFERENTIAL: the change-set chain (./change-set.ts, the same write routes
 *    the point reads are proven against), with every account and every slot read
 *    by EXECUTION (a reader contract's `BALANCE` / `EXTCODESIZE` / `EXTCODEHASH`,
 *    and `SLOAD` through a code override on the account itself) while each block
 *    is the head, then re-read at every K afterwards: each answer must be the one
 *    K gave as the head.
 *
 * ENGINE-PARAMETERISED: `test/historical-call.spec.ts` runs it on the default
 * engine through ./cut.ts, `test/revm-historical-call.spec.ts` on revm through
 * ./cut-revm.ts, and both hold the report to ONE contract.
 */
import {changeSetsForTests, createNode} from '../../src/node.js';
import type {NodeOptions, SlimNode} from '../../src/types.js';
import {
	createPublicClient,
	createWalletClient,
	custom,
	getContractAddress,
	decodeFunctionResult,
	encodeFunctionData,
	keccak256,
	type Hex,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {
	chainNodeOptions,
	changeSetJson,
	runChangeSetChain,
	word,
} from './change-set.js';
import {CHAIN_ID, CREATE_INIT, PK, SELFDESTRUCT_INIT} from './post-state.js';
import {counterAbi, counterBytecode} from './counter.js';
import {
	blockEnvProbeAbi,
	blockEnvProbeRuntimeBytecode,
} from './block-env-probe.js';
import {keysOfDump} from './state-history.js';

const signer = privateKeyToAccount(PK);
const SENDER = signer.address;
const chain = {
	id: CHAIN_ID,
	name: 'webevm',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

// ------------------------------------------------------------ bytecode ----
// Hand-written, one job each, every byte spelled out.

/**
 * READER: `PUSH0 CALLDATALOAD` (the address), `DUP1 BALANCE PUSH0 MSTORE`,
 * `DUP1 EXTCODESIZE PUSH1 20 MSTORE`, `EXTCODEHASH PUSH1 40 MSTORE`,
 * `PUSH1 60 PUSH0 RETURN`: three words, the account as execution sees it.
 * `EXTCODEHASH` is what tells an ABSENT account (zero) from an existing empty one.
 * Placed by a state override at an address nothing else touches.
 */
export const READER = '0x0000000000000000000000000000000000005eed';
const READER_CODE = '0x5f3580315f52803b6020523f60405260605ff3';
/** SLOT READER: `PUSH0 CALLDATALOAD SLOAD PUSH0 MSTORE PUSH1 20 PUSH0 RETURN`. */
const SLOT_READER_CODE = '0x5f35545f5260205ff3';
/** BLOCKHASH READER: `PUSH0 CALLDATALOAD BLOCKHASH PUSH0 MSTORE PUSH1 20 PUSH0 RETURN`. */
const BLOCKHASH_READER_CODE = '0x5f35405f5260205ff3';
/**
 * STORE: with no calldata, returns slot 0 (`JUMPDEST PUSH0 SLOAD PUSH0 MSTORE
 * PUSH1 20 PUSH0 RETURN` at 0x0a); with a word, stores it in slot 0
 * (`PUSH0 CALLDATALOAD PUSH0 SSTORE STOP`). 19 bytes.
 */
const STORE_RUNTIME = '3615600a575f355f55005b5f545f5260205ff3';
/** `PUSH1 13 DUP1 PUSH1 09 PUSH0 CODECOPY PUSH0 RETURN`, then the runtime. */
const STORE_INIT = `0x60138060095f395ff3${STORE_RUNTIME}`;
/** `PUSH0 PUSH0 REVERT`. */
const REVERTS_CODE = '0x5f5ffd';

const EMPTY_CODE_HASH = keccak256('0x');

type Outcome = {ok: unknown} | {code: number; message: string};

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

const hexN = (n: number | bigint) => '0x' + BigInt(n).toString(16);
const pad = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

/** An account as execution sees it at `block`: `{balance, size, hash}`, hex. */
async function accountByCall(
	node: SlimNode,
	address: string,
	block: unknown,
	overrides: Record<string, unknown> = {},
) {
	const r = String(
		await node.request({
			method: 'eth_call',
			params: [
				{to: READER, data: pad(address)},
				block,
				{...overrides, [READER]: {code: READER_CODE}},
			],
		}),
	);
	const w = (i: number) => '0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1));
	return {
		balance: hexN(BigInt(w(0))),
		size: hexN(BigInt(w(1))),
		hash: w(2),
	};
}

/**
 * One storage slot as execution sees it at `block`: the account's own code is
 * overridden with the slot reader, which keeps its storage (at K) underneath.
 * `stateOverride` is merged INTO the account's override (so `state` /
 * `stateDiff` compose with the reader).
 */
async function slotByCall(
	node: SlimNode,
	address: string,
	slot: string,
	block: unknown,
	stateOverride: Record<string, unknown> = {},
): Promise<string> {
	return String(
		await node.request({
			method: 'eth_call',
			params: [
				{to: address, data: pad(slot)},
				block,
				{[address]: {...stateOverride, code: SLOT_READER_CODE}},
			],
		}),
	);
}

/** The whole observable head: state, the open record and the sealed blocks. */
async function headFingerprint(node: SlimNode): Promise<string> {
	const p = changeSetsForTests(node);
	return JSON.stringify({
		dump: await node.dumpState(),
		open: changeSetJson(p.open),
		headBlock: changeSetJson(p.headBlock),
		sealed: p.sealedBlocks,
	});
}

async function sendSync(
	node: SlimNode,
	nonce: number,
	tx: {to?: string; data?: string; value?: bigint; gas?: bigint},
): Promise<any> {
	const raw = await signer.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: tx.gas ?? 300_000n,
		// Above every base fee these nodes are built with.
		maxFeePerGas: 100_000_000_000n,
		maxPriorityFeePerGas: 0n,
		...(tx.to !== undefined ? {to: tx.to as Hex} : {}),
		...(tx.data !== undefined ? {data: tx.data as Hex} : {}),
		...(tx.value !== undefined ? {value: tx.value} : {}),
	} as any);
	return node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
}

// ------------------------------------------------------------ consumer ----

/**
 * THE CONSUMER CASE, in bomber-world's shape: read the block number, mine twice
 * (each block changes storage and emits a log), then read logs up to the pinned
 * block and the contract's view at the pinned block. The two must describe ONE
 * moment: as many `Incremented` logs as the counter's value, the last of them
 * carrying that value.
 */
async function runConsumer(makeEngine: EngineFactory | undefined) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[SENDER]: 10n ** 24n},
		engine: makeEngine ? await makeEngine() : undefined,
		stateHistory: {blocks: 8},
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account: signer, chain, transport});
	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const counter = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress as Hex;
	const increment = async () => {
		const hash = await wallet.writeContract({
			address: counter,
			abi: counterAbi,
			functionName: 'increment',
		});
		await pub.getTransactionReceipt({hash});
	};
	await increment();

	// Read RAW, not through `pub.getBlockNumber()`, which viem caches.
	const blockNumber = async () =>
		BigInt(String(await node.request({method: 'eth_blockNumber'})));
	const pinned = await blockNumber();
	await increment();
	await increment();
	const head = await blockNumber();

	const logs = await pub.getContractEvents({
		address: counter,
		abi: counterAbi,
		eventName: 'Incremented',
		fromBlock: 0n,
		toBlock: pinned,
	});
	const read = (blockNumber?: bigint) =>
		pub.readContract({
			address: counter,
			abi: counterAbi,
			functionName: 'number',
			...(blockNumber !== undefined ? {blockNumber} : {}),
		});
	const out = {
		pinned: Number(pinned),
		head: Number(head),
		logCount: logs.length,
		lastLogValue: String(logs.at(-1)?.args.newValue),
		valueAtPinned: String(await read(pinned)),
		valueAtHead: String(await read()),
	};
	await node.dispose();
	return out;
}

// --------------------------------------------------- block environment ----

const ENV_PROBE = '0x000000000000000000000000000000000000e0e0';
const BLOCKHASH_READER = '0x000000000000000000000000000000000000b0b0';
const STORE = '0x000000000000000000000000000000000000cafe';

/**
 * K's block environment, BLOCKHASH and storage. K is the HEAD of node A (built
 * with `blockEnv` #1), whose dump node B (built with `blockEnv` #2) loads and
 * mines two blocks on, so every environment field differs between K and B's
 * head and a call answered from the wrong block cannot pass.
 */
async function runBlockEnvironment(makeEngine: EngineFactory | undefined) {
	const envA = {
		coinbase: '0x00000000000000000000000000000000000c0a01',
		prevRandao: word(0xa1a1),
		timestamp: 1_700_000_000n,
		baseFeePerGas: 2_000_000_000n,
		gasLimit: 20_000_000n,
	};
	const envB = {
		coinbase: '0x00000000000000000000000000000000000c0b02',
		prevRandao: word(0xb2b2),
		timestamp: 1_800_000_000n,
		baseFeePerGas: 3_000_000_000n,
		gasLimit: 25_000_000n,
	};
	const base = (blockEnv: NodeOptions['blockEnv']): NodeOptions => ({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		blockEnv,
		stateHistory: {blocks: 8},
	});
	const a = await createNode({
		...base(envA),
		engine: makeEngine ? await makeEngine() : undefined,
		initialBalances: {[SENDER]: 10n ** 24n},
		initialState: {
			[ENV_PROBE]: {code: blockEnvProbeRuntimeBytecode},
			[BLOCKHASH_READER]: {code: BLOCKHASH_READER_CODE},
			[STORE]: {code: `0x${STORE_RUNTIME}`},
		},
	});
	await sendSync(a, 0, {to: STORE, data: word(0x0a)}); // block 1
	await sendSync(a, 1, {to: STORE, data: word(0x0b)}); // block 2 = K
	const dump = await a.dumpState();
	await a.dispose();

	const node = await createNode({
		...base(envB),
		engine: makeEngine ? await makeEngine() : undefined,
	});
	await node.loadState(dump);
	await sendSync(node, 2, {to: STORE, data: word(0x0c)}); // block 3
	await sendSync(node, 3, {to: STORE, data: word(0x0d)}); // block 4 = head
	const K = 2;

	const env = async (block: unknown) => {
		const r = (await node.request({
			method: 'eth_call',
			params: [
				{
					to: ENV_PROBE,
					data: encodeFunctionData({
						abi: blockEnvProbeAbi,
						functionName: 'env',
					}),
				},
				block,
			],
		})) as Hex;
		const [basefee, prevrandao, coinbase, number, timestamp, gaslimit] =
			decodeFunctionResult({
				abi: blockEnvProbeAbi,
				functionName: 'env',
				data: r,
			});
		return {
			number: hexN(number),
			timestamp: hexN(timestamp),
			coinbase: coinbase.toLowerCase(),
			prevRandao: pad(hexN(prevrandao)),
			baseFeePerGas: hexN(basefee),
			gasLimit: hexN(gaslimit),
		};
	};
	const header = async (n: number) => {
		const b = (await node.request({
			method: 'eth_getBlockByNumber',
			params: [hexN(n), false],
		})) as any;
		return {
			hash: String(b.hash),
			env: {
				number: String(b.number),
				timestamp: String(b.timestamp),
				coinbase: String(b.miner).toLowerCase(),
				prevRandao: String(b.mixHash),
				baseFeePerGas: String(b.baseFeePerGas),
				gasLimit: String(b.gasLimit),
			},
		};
	};
	const blockHash = (n: number, block: unknown) =>
		node.request({
			method: 'eth_call',
			params: [{to: BLOCKHASH_READER, data: word(n)}, block],
		});
	const stored = (block: unknown) =>
		node.request({method: 'eth_call', params: [{to: STORE}, block]});

	const k = hexN(K);
	const out = {
		k: K,
		headerK: await header(K),
		headerKMinus1: await header(K - 1),
		headerHead: await header(4),
		atK: {
			env: await env(k),
			stored: await stored(k),
			blockHashOfK: await blockHash(K, k),
			blockHashOfKMinus1: await blockHash(K - 1, k),
			blockHashOfKPlus1: await blockHash(K + 1, k),
		},
		atHead: {
			env: await env('latest'),
			stored: await stored('latest'),
			blockHashOfK: await blockHash(K, 'latest'),
		},
	};
	await node.dispose();
	return out;
}

// ------------------------------------------------------ reconstruction ----

/**
 * Accounts created, self-destructed and storage-cleared AFTER K, read at K by
 * execution; `eth_estimateGas` at K; state overrides on top of K; and purity.
 *
 * Before K (cheats, mined into block K = 1): P holds balance 7 and slots
 * 0/1/2, Q holds balance 5 and slot 3. After K: a contract is CREATED at P
 * (which clears P's storage and writes slot 0 = 0x2a, block 2), a contract is
 * created at Q and SELF-DESTRUCTS in its constructor (block 3), and the STORE
 * contract is deployed at R (block 4).
 */
async function runReconstruction(makeEngine: EngineFactory | undefined) {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[SENDER]: 10n ** 24n},
		engine: makeEngine ? await makeEngine() : undefined,
		stateHistory: {blocks: 8},
	});
	const P = getContractAddress({from: SENDER, nonce: 0n}).toLowerCase();
	const Q = getContractAddress({from: SENDER, nonce: 1n}).toLowerCase();
	const R = getContractAddress({from: SENDER, nonce: 2n}).toLowerCase();
	const set = (method: string, params: unknown[]) =>
		node.request({method, params});
	await set('evm_setBalance', [P, '0x7']);
	await set('evm_setStorageAt', [P, '0x0', word(0xa0)]);
	await set('evm_setStorageAt', [P, '0x1', word(0xa1)]);
	await set('evm_setStorageAt', [P, '0x2', word(0xa2)]);
	await set('evm_setBalance', [Q, '0x5']);
	await set('evm_setStorageAt', [Q, '0x3', word(0x93)]);
	await node.mine(); // block 1 = K
	const K = hexN(1);

	const created = await sendSync(node, 0, {data: `0x${CREATE_INIT}`}); // 2
	const destroyed = await sendSync(node, 1, {data: `0x${SELFDESTRUCT_INIT}`}); // 3
	const deployed = await sendSync(node, 2, {data: STORE_INIT}); // 4

	const view = async (block: unknown) => ({
		P: {
			account: await accountByCall(node, P, block),
			slots: [
				await slotByCall(node, P, '0x0', block),
				await slotByCall(node, P, '0x1', block),
				await slotByCall(node, P, '0x2', block),
			],
			code: await node.request({method: 'eth_getCode', params: [P, block]}),
		},
		Q: {
			account: await accountByCall(node, Q, block),
			slot3: await slotByCall(node, Q, '0x3', block),
		},
		R: {
			account: await accountByCall(node, R, block),
			code: await node.request({method: 'eth_getCode', params: [R, block]}),
		},
	});

	const before = await headFingerprint(node);
	const atK = await view(K);
	const atHead = await view('latest');

	// eth_estimateGas at K: a plain transfer to R, which had no code at K.
	const transferToR = {from: SENDER, to: R, value: '0x1'};
	const estimate = {
		atK: await outcome(node, 'eth_estimateGas', [transferToR, K]),
		atHead: await outcome(node, 'eth_estimateGas', [transferToR, 'latest']),
	};

	// State overrides compose ON TOP of K's state.
	const overrides = {
		// An account absent at K, given a balance: it exists, with no code.
		absentGivenBalance: await accountByCall(node, R, K, {
			[R]: {balance: '0x99'},
		}),
		// `stateDiff` patches one slot of K's storage and leaves the others at K.
		stateDiff: [
			await slotByCall(node, P, '0x0', K, {stateDiff: {[word(1)]: word(0x77)}}),
			await slotByCall(node, P, '0x1', K, {stateDiff: {[word(1)]: word(0x77)}}),
		],
		// `state` replaces K's storage wholesale.
		state: [
			await slotByCall(node, P, '0x0', K, {state: {[word(2)]: word(0x55)}}),
			await slotByCall(node, P, '0x2', K, {state: {[word(2)]: word(0x55)}}),
		],
		// Code placed at an address that had none at K, and the call runs it.
		codeOnAbsent: await node.request({
			method: 'eth_call',
			params: [{to: R}, K, {[R]: {code: `0x${STORE_RUNTIME}`}}],
		}),
	};

	// Purity: every kind of historical execution, including the ones that fail,
	// leaves the head (state, open record, sealed history) byte-identical.
	const failures = {
		callReverts: await outcome(node, 'eth_call', [
			{to: R},
			K,
			{[R]: {code: REVERTS_CODE}},
		]),
		estimateThrows: await outcome(node, 'eth_estimateGas', [
			{from: SENDER, to: R},
			K,
			{[R]: {code: REVERTS_CODE}},
		]),
		badOverride: await outcome(node, 'eth_call', [
			{to: R},
			K,
			{[R]: {balance: 'lots'}},
		]),
	};
	const after = await headFingerprint(node);
	// ...and the head still answers as the head.
	const headAfter = await view('latest');

	await node.dispose();
	return {
		addresses: {P, Q, R},
		receipts: {
			created: {
				status: String(created.status),
				contractAddress: String(created.contractAddress).toLowerCase(),
			},
			destroyed: String(destroyed.status),
			deployed: {
				status: String(deployed.status),
				contractAddress: String(deployed.contractAddress).toLowerCase(),
			},
		},
		emptyCodeHash: EMPTY_CODE_HASH,
		atK,
		atHead,
		estimate,
		overrides,
		failures,
		pure: before === after,
		headStable: JSON.stringify(headAfter) === JSON.stringify(atHead),
	};
}

// -------------------------------------------------------- differential ----

/**
 * Every account and every slot the change-set chain touches, read BY EXECUTION
 * at `block`. Exported for ./state-history-persistence.ts, which asks the same
 * questions of a node before and after a dump / load.
 */
/**
 * A refusal, by code AND message, the way ./state-history.ts's `readAll` writes
 * one, so a transport that loses the code (as a worker node's comlink boundary
 * once did) reads as a different answer rather than as the same one.
 */
function refusalText(e: unknown): string {
	return `ERROR ${(e as {code?: unknown})?.code} ${String((e as Error)?.message ?? e)}`;
}

export async function executeAll(
	node: SlimNode,
	addresses: string[],
	slots: string[],
	block: unknown,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const a of addresses) {
		try {
			out[`account ${a}`] = JSON.stringify(await accountByCall(node, a, block));
		} catch (e) {
			out[`account ${a}`] = refusalText(e);
		}
	}
	for (const k of slots) {
		const [a, s] = k.split(':');
		try {
			out[`storage ${k}`] = await slotByCall(node, a, s, block);
		} catch (e) {
			out[`storage ${k}`] = refusalText(e);
		}
	}
	return out;
}

async function runDifferential(makeEngine: EngineFactory | undefined) {
	const opts = () => chainNodeOptions(makeEngine, {stateHistory: {blocks: 64}});

	// Run 1, the key universe (as ./state-history.ts does).
	const scout = await createNode(await opts());
	const addressSet = new Set<string>();
	const slotSet = new Set<string>();
	keysOfDump(await scout.dumpState(), addressSet, slotSet);
	const scoutChain = await runChangeSetChain(scout, async () => {
		keysOfDump(await scout.dumpState(), addressSet, slotSet);
	});
	for (const a of scoutChain.addresses) addressSet.add(a);
	for (const a of addressSet) slotSet.add(`${a}:${word(0)}`);
	await scout.dispose();
	// The reader's own address is overridden on every call, so it is not state.
	addressSet.delete(READER);
	const addresses = [...addressSet].sort();
	const slots = [...slotSet].sort();

	// Run 2, every key by execution while each block is the head.
	const node = await createNode(await opts());
	const snapshots = new Map<number, Record<string, string>>();
	const hashes = new Map<number, string>();
	const takeSnapshot = async (n: number) => {
		snapshots.set(n, await executeAll(node, addresses, slots, 'latest'));
		const b = (await node.request({
			method: 'eth_getBlockByNumber',
			params: [hexN(n), false],
		})) as {hash: string};
		hashes.set(n, b.hash);
	};
	await takeSnapshot(0);
	await runChangeSetChain(node, async (_label, n) => takeSnapshot(n));
	const head = Number(
		BigInt(String(await node.request({method: 'eth_blockNumber'}))),
	);

	// Cheats after the head: in the OPEN record, so part of every K's union.
	const [cheated] = addresses.filter((a) => a.endsWith('7777'));
	await node.request({method: 'evm_setCode', params: [cheated, '0x60016002']});
	await node.request({method: 'evm_setBalance', params: [cheated, '0xabcdef']});
	await node.request({
		method: 'evm_setStorageAt',
		params: [cheated, '0x0', word(0x77)],
	});
	const headAfterCheats = await executeAll(node, addresses, slots, 'latest');

	const before = await headFingerprint(node);
	const mismatches: string[] = [];
	let refsChecked = 0;
	for (let k = 0; k <= head; k++) {
		const expected = k === head ? headAfterCheats : snapshots.get(k)!;
		for (const [name, ref] of Object.entries({
			number: hexN(k),
			objectHash: {blockHash: hashes.get(k)!},
		})) {
			refsChecked++;
			const got = await executeAll(node, addresses, slots, ref);
			for (const key of Object.keys(expected))
				if (expected[key] !== got[key])
					mismatches.push(
						`block ${k} by ${name}: ${key}: expected ${expected[key]}, got ${got[key]}`,
					);
		}
	}
	const after = await headFingerprint(node);

	let distinctSnapshots = 0;
	for (let k = 1; k <= head; k++)
		if (
			JSON.stringify(snapshots.get(k)) !== JSON.stringify(snapshots.get(k - 1))
		)
			distinctSnapshots++;
	const errors = Object.entries(snapshots.get(head)!).filter(([, v]) =>
		v.startsWith('ERROR'),
	);

	await node.dispose();
	return {
		engineId: node.engine.id,
		head,
		keyCount: addresses.length + slots.length,
		refsChecked,
		distinctSnapshots,
		cheatsChangedTheHead:
			JSON.stringify(headAfterCheats) !== JSON.stringify(snapshots.get(head)),
		snapshotErrors: errors.length,
		mismatches: mismatches.slice(0, 50),
		mismatchCount: mismatches.length,
		pure: before === after,
	};
}

export async function runHistoricalCallChecks(
	params: {makeEngine?: EngineFactory} = {},
) {
	return {
		consumer: await runConsumer(params.makeEngine),
		blockEnvironment: await runBlockEnvironment(params.makeEngine),
		reconstruction: await runReconstruction(params.makeEngine),
		differential: await runDifferential(params.makeEngine),
	};
}
