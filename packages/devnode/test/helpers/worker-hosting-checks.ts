/**
 * worker-hosting-checks.ts: runs in the browser PAGE (the main thread). The two
 * worker shapes of `@webevm/devnode` (ADR 0017), each driven through webevm's
 * ORDINARY `createWorkerNode()`, as a consumer drives them:
 *
 *   A. KEYS ON THE MAIN THREAD: `wrapDevNode` over the proxy a plain webevm
 *      worker returns, its genesis funded by passing `devAccountBalances()` as
 *      the worker node's `initialBalances`. Execution is in the worker; the
 *      accounts, sends and signatures are answered here.
 *   B. KEYS IN THE WORKER: `exposeDevNode` in the worker module
 *      (./dev-worker.ts), so the main thread gets a dev node it never configured.
 *      Every `SlimNode` member is driven across the boundary, an `RpcError` the
 *      layer raises must arrive whole, and EVERYTHING the main thread receives is
 *      searched for the worker's mnemonic and keys.
 *   C. A BAD CONFIG in the worker REJECTS `createWorkerNode()` (never a hang,
 *      measured with a budget as webevm's `engine-misuse.ts` does), and is also
 *      reported early, without a throw, by `createDevNodeWorkerApi()`.
 *
 * It RETURNS what it observed (bigints as decimal strings) and asserts nothing;
 * ../worker-hosting.spec.ts holds the expectations.
 */
import {createWorkerNode} from 'webevm/worker-client';
import {createNode, RpcError, type SlimNode} from 'webevm';
import {providerOverPort} from '@eip-1193/over-port';
import {bytesToHex} from '@noble/hashes/utils.js';
import {mnemonicToAccount, privateKeyToAccount} from 'viem/accounts';
import {devAccountBalances, wrapDevNode} from '../../src/index.js';
import {createDevNodeWorkerApi} from '../../src/worker-host.js';
import {deriveDevAccounts} from '../../src/accounts.js';
import {WORKER_ACCOUNT_COUNT, WORKER_MNEMONIC} from './dev-worker-config.js';

const CHAIN_ID = 31337;
/** No dev account: funded by the MAIN thread's `initialBalances`, then impersonated. */
export const STRANGER = '0x00000000000000000000000000000000000000aa';
/** Where the sends go. */
export const RECIPIENT = '0x00000000000000000000000000000000000000bb';
/** An address nobody holds a key for, never impersonated. */
export const NOBODY = '0x00000000000000000000000000000000000000cc';
export const MESSAGE = 'hello from the main thread';

/** How long a hang is given to prove it is one. */
const SETTLE_BUDGET_MS = 10_000;

/** anvil's first default key: the main-thread recipe's account 0. */
const ANVIL_KEY_0 =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

type Consumer = {
	request(args: {method: string; params?: unknown[]}): Promise<unknown>;
};

function withHost(workerUrl: string, host: string): string {
	const url = new URL(workerUrl);
	url.searchParams.set('host', host);
	return url.href;
}

/** What a rejected request carried, or `{resolved}`. */
async function outcome(p: Promise<unknown>): Promise<unknown> {
	try {
		return {resolved: await p};
	} catch (e) {
		const err = e as {code?: unknown; message?: unknown; data?: unknown};
		return {
			code: err.code,
			message: err.message,
			data: err.data,
			name: (e as Error)?.name,
			isRpcError: e instanceof RpcError,
		};
	}
}

/**
 * The battery both recipes answer identically: accounts, a funded send, a
 * signature, and a served port answering the account methods.
 */
async function exercise(node: SlimNode, sign: (m: string) => Promise<string>) {
	const req = (method: string, params?: unknown[]) =>
		node.request({method, params});
	const accounts = (await req('eth_accounts')) as string[];
	const dev = accounts[0];
	const genesisBalance = String(
		BigInt((await req('eth_getBalance', [dev, '0x0'])) as string),
	);
	const hash = (await req('eth_sendTransaction', [
		{from: dev, to: RECIPIENT, value: '0x2a'},
	])) as string;
	const receipt = (await req('eth_getTransactionReceipt', [hash])) as {
		status: string;
		from: string;
	};
	const recipientBalance = String(
		BigInt((await req('eth_getBalance', [RECIPIENT, 'latest'])) as string),
	);
	const signature = await req('personal_sign', [MESSAGE, dev]);
	const expectedSignature = await sign(MESSAGE);

	// A PORT: whoever holds the other end reaches the node's thread directly
	// (for a main-thread layer, the main thread; for an in-worker one, the
	// worker), and it answers the account methods either way.
	const channel = new MessageChannel();
	const served = await node.serveOn(channel.port1);
	const consumer = providerOverPort(channel.port2) as unknown as Consumer;
	const servedAccounts = await consumer.request({method: 'eth_accounts'});
	await served.close();
	channel.port2.close();

	return {
		accounts,
		genesisBalance,
		send: {
			hash,
			status: receipt.status,
			from: receipt.from,
			recipientBalance,
		},
		signature,
		expectedSignature,
		servedAccounts,
	};
}

/** A: the layer on the MAIN thread, over a plain webevm worker. */
async function keysOnTheMainThread(workerUrl: string) {
	const worker = new Worker(withHost(workerUrl, 'plain'), {type: 'module'});
	const proxy = await createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: devAccountBalances(),
	});
	const node = wrapDevNode(proxy);
	const result = await exercise(node, (message) =>
		privateKeyToAccount(ANVIL_KEY_0).signMessage({message}),
	);
	const engineId = node.engine.id;
	// The layer's dispose disposes the proxy, which terminates the worker.
	await node.dispose();
	return {...result, engineId};
}

/** A JSON rendering of anything the main thread received, bigints and bytes included. */
function render(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		typeof v === 'bigint'
			? v.toString()
			: v instanceof Uint8Array
				? bytesToHex(v)
				: v,
	);
}

/** B: the layer INSIDE the worker, through `exposeDevNode`. */
async function keysInTheWorker(workerUrl: string) {
	const worker = new Worker(withHost(workerUrl, 'dev'), {type: 'module'});
	const node = await createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		// The MAIN thread's genesis entry: it still applies under the worker's
		// dev funding.
		initialBalances: {[STRANGER]: 10n ** 18n},
	});
	/** Everything this thread receives from the worker, for the leak scan. */
	const received: unknown[] = [];
	const req = async (method: string, params?: unknown[]) => {
		const answer = await node.request({method, params});
		received.push(answer);
		return answer;
	};
	const failure = async (method: string, params?: unknown[]) => {
		const answer = await outcome(node.request({method, params}));
		received.push(answer);
		return answer;
	};

	const viemAccount = mnemonicToAccount(WORKER_MNEMONIC);
	const result = await exercise(node, (message) =>
		viemAccount.signMessage({message}),
	);
	received.push(result);
	const expectedAccounts = Array.from({length: WORKER_ACCOUNT_COUNT}, (_, i) =>
		mnemonicToAccount(WORKER_MNEMONIC, {
			path: `m/44'/60'/0'/0/${i}`,
		}).address.toLowerCase(),
	);

	// THE PLAIN MEMBERS, read off the remote.
	const values = {
		engineId: node.engine.id,
		senderMode: node.senderMode,
		computeStateRoot: node.computeStateRoot,
	};

	// EVERY OTHER MEMBER, through the proxy. (The stranger has not moved since
	// genesis, and the node keeps no historical state, so `latest` reads it.)
	const strangerGenesis = String(
		BigInt((await req('eth_getBalance', [STRANGER, 'latest'])) as string),
	);
	let heads = 0;
	const unsubscribe = node.onNewHead(() => {
		heads++;
	});
	// The subscription is registered asynchronously over comlink.
	await new Promise((resolve) => setTimeout(resolve, 100));
	await node.mine();
	await new Promise((resolve) => setTimeout(resolve, 200));
	unsubscribe();
	const dump = await node.dumpState();
	received.push(dump);
	const blockBeforeLoad = await req('eth_blockNumber');
	await node.loadState(dump);
	const blockAfterLoad = await req('eth_blockNumber');
	const stateRoot = await outcome(node.getStateRoot());
	received.push(stateRoot);

	// THE LAYER'S OWN METHODS, and its errors, across the boundary.
	const impersonate = await req('hardhat_impersonateAccount', [STRANGER]);
	const impersonatedHash = (await req('eth_sendTransaction', [
		{from: STRANGER, to: RECIPIENT, value: '0x1'},
	])) as string;
	const impersonatedReceipt = (await req('eth_getTransactionReceipt', [
		impersonatedHash,
	])) as {status: string; from: string};
	const signedTransaction = await req('eth_signTransaction', [
		{from: result.accounts[0], to: RECIPIENT, value: '0x1'},
	]);
	const typedSignature = await req('eth_signTypedData_v4', [
		result.accounts[0],
		{
			types: {Mail: [{name: 'contents', type: 'string'}]},
			primaryType: 'Mail',
			domain: {name: 'worker', chainId: CHAIN_ID},
			message: {contents: 'hi'},
		},
	]);
	const errors = {
		unknownSender: await failure('eth_sendTransaction', [
			{from: NOBODY, to: RECIPIENT, value: '0x1'},
		]),
		signImpersonated: await failure('personal_sign', [MESSAGE, STRANGER]),
		wrongChainId: await failure('eth_sendTransaction', [
			{from: result.accounts[0], to: RECIPIENT, chainId: '0x1'},
		]),
	};

	const shapeGaps = await shapeGapsAgainstMainThread(node);

	await node.dispose();

	// THE LEAK SCAN: no key and no mnemonic in anything received.
	const keys = deriveDevAccounts({
		mnemonic: WORKER_MNEMONIC,
		count: WORKER_ACCOUNT_COUNT,
	}).map((a) => bytesToHex(a.privateKey));
	const everything = render(received).toLowerCase();
	const leaks = [
		...keys.filter((k) => everything.includes(k)).map((k) => `key ${k}`),
		...(everything.includes(WORKER_MNEMONIC) ? ['the mnemonic'] : []),
		...(everything.includes('abandon') ? ['a mnemonic word'] : []),
	];

	return {
		...result,
		expectedAccounts,
		values,
		strangerGenesis,
		heads,
		blockBeforeLoad,
		blockAfterLoad,
		stateRoot,
		impersonate,
		impersonated: {
			status: impersonatedReceipt.status,
			from: impersonatedReceipt.from,
		},
		signedTransaction: typeof signedTransaction,
		typedSignature: typeof typedSignature,
		errors,
		shapeGaps,
		receivedBytes: everything.length,
		leaks,
	};
}

/**
 * Every key a main-thread dev node carries must arrive across the boundary
 * with the same kind of value (webevm's `shapeGapsAgainstMainThread`, against a
 * dev node). Empty means no gap.
 */
async function shapeGapsAgainstMainThread(node: SlimNode): Promise<string[]> {
	const reference = wrapDevNode(await createNode({chainId: CHAIN_ID}));
	const gaps: string[] = [];
	for (const key of Object.keys(reference) as (keyof SlimNode)[]) {
		const theirs = node[key];
		if (theirs === undefined) gaps.push(`${key}: absent across the boundary`);
		else if (typeof theirs !== typeof reference[key])
			gaps.push(`${key}: ${typeof theirs}, ${typeof reference[key]} here`);
	}
	await reference.dispose();
	return gaps;
}

interface Settled {
	outcome: 'REJECTED' | 'DID_NOT_THROW' | 'NEVER_SETTLED';
	message: string;
}

/** C: drive a worker whose host config is bad, with a budget for the hang. */
async function driveBadWorker(workerUrl: string): Promise<Settled> {
	const worker = new Worker(workerUrl, {type: 'module'});
	let result: Settled = {outcome: 'NEVER_SETTLED', message: ''};
	const settled = createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	}).then(
		async (node) => {
			result = {outcome: 'DID_NOT_THROW', message: ''};
			await node.dispose();
		},
		(e: unknown) => {
			result = {
				outcome: 'REJECTED',
				message: String((e as Error)?.message ?? e),
			};
		},
	);
	await Promise.race([
		settled,
		new Promise<void>((resolve) => setTimeout(resolve, SETTLE_BUDGET_MS)),
	]);
	worker.terminate();
	return result;
}

/** C, the worker's half: what `createDevNodeWorkerApi` logs, and that it does not throw. */
function earlySignal(hostOptions: Record<string, unknown>) {
	const lines: string[] = [];
	const realError = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(' '));
	};
	let threw = 'DID_NOT_THROW';
	try {
		createDevNodeWorkerApi(hostOptions as never);
	} catch (e) {
		threw = String((e as Error)?.message ?? e);
	} finally {
		console.error = realError;
	}
	return {reported: lines.join('\n'), threw};
}

export async function runWorkerHostingChecks(workerUrl: string) {
	const mainThread = await keysOnTheMainThread(workerUrl);
	const inWorker = await keysInTheWorker(workerUrl);
	const bad = {
		mnemonic: await driveBadWorker(withHost(workerUrl, 'bad-mnemonic')),
		key: await driveBadWorker(withHost(workerUrl, 'bad-key')),
		engine: await driveBadWorker(withHost(workerUrl, 'bad-engine')),
	};
	const early = {
		mnemonic: earlySignal({accounts: {mnemonic: 'not a real mnemonic at all'}}),
		key: earlySignal({accounts: ['0x1234']}),
		balance: earlySignal({balance: -1n}),
		good: earlySignal({accounts: 2}),
	};
	return {mainThread, inWorker, bad, early};
}
