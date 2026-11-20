/**
 * impersonation-checks.ts: the battery for impersonation (`hardhat_` and
 * `anvil_impersonateAccount` / `stopImpersonatingAccount`), run in a real
 * browser page by ./cut.ts (default engine) and ./cut-revm.ts (`webevm/revm`).
 *
 * THE PATTERN IS webevm's TRUSTED-SENDER SUITE
 * (`packages/webevm/test/helpers/trusted-sender.ts`): an impersonated address
 * holds NO key, so the only proof that a transaction executed AS it is the
 * post-state, read to the wei (its balance charged, its nonce advanced), the
 * receipt's `from`, and an EVM-side witness that cannot be faked by a node
 * naming the right `from` on a receipt: a contract that stores `CALLER`, and a
 * contract created at the address derived from the impersonated sender.
 *
 * WHAT IS SENT is read from the wire: the dev node wraps a SPY, so the raw
 * transaction the layer submitted, the method it used and the sender it
 * claimed are decoded with viem, independently of the package.
 *
 * It RETURNS what it observed (bigints as decimal strings) and asserts nothing
 * itself: ../impersonation-expected.ts holds the assertions, the same for both
 * engines.
 */
import {
	parseTransaction,
	recoverTransactionAddress,
	type TransactionSerialized,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	createNode,
	type Engine,
	type NodeOptions,
	type RequestArguments,
	type SlimNode,
} from 'webevm';
import {
	createDevNode,
	devAccountBalances,
	wrapDevNode,
} from '../../src/index.js';
import {FEES, RECIPIENT} from './send-checks.js';

type MakeEngine = (() => Promise<Engine>) | undefined;

/** Three key-less addresses, funded at genesis, and impersonated below. */
export const IMPERSONATED = [
	'0x00000000000000000000000000000000000000a1',
	'0x00000000000000000000000000000000000000a2',
	'0x00000000000000000000000000000000000000a3',
] as const;
/** What each of them holds at genesis. */
export const IMPERSONATED_BALANCE = 10n ** 21n;

/**
 * Init code deploying the runtime `CALLER PUSH1 0 SSTORE STOP`
 * (`0x3360005500`): every call stores its `msg.sender` in slot 0.
 */
export const CALLER_RECORDER_INITCODE = '0x6433600055006000526005601bf3';

/** anvil's account 0, which the layer holds the key for. */
const DEV_KEY =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SEND_METHODS = new Set([
	'eth_sendRawTransaction',
	'eth_sendRawTransactionSync',
	'evm_sendRawTransactionAs',
	'evm_sendRawTransactionSyncAs',
]);

const IMPERSONATION_METHODS = [
	'hardhat_impersonateAccount',
	'hardhat_stopImpersonatingAccount',
	'anvil_impersonateAccount',
	'anvil_stopImpersonatingAccount',
] as const;

/** What a rejected request carried, or 'resolved'. */
async function outcome(p: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		return {resolved: await p};
	} catch (e) {
		const err = e as {code?: unknown; message?: unknown};
		return {code: err.code, message: err.message};
	}
}

/** What a synchronous call threw, or 'returned'. */
function thrown(run: () => unknown): Record<string, unknown> {
	try {
		run();
		return {returned: true};
	} catch (e) {
		return {message: (e as Error).message};
	}
}

/** A raw transaction's fields, decoded by viem, as JSON. */
function decode(raw: string) {
	const tx = parseTransaction(raw as TransactionSerialized) as Record<
		string,
		unknown
	>;
	return JSON.parse(
		JSON.stringify(tx, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
	) as Record<string, unknown>;
}

async function receiptOf(node: SlimNode, hash: unknown) {
	return (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	})) as Record<string, string> | null;
}

/** A trusted node whose every request is recorded, plus its engine id. */
async function spiedTrustedNode(makeEngine: MakeEngine, options: NodeOptions) {
	const inner = await createNode({
		...FEES,
		senderMode: 'trusted',
		...options,
		...(makeEngine ? {engine: await makeEngine()} : {}),
	});
	const calls: RequestArguments[] = [];
	const spied: SlimNode = {
		...inner,
		request(args) {
			calls.push(JSON.parse(JSON.stringify(args)));
			return inner.request(args);
		},
	};
	return {spied, calls};
}

export async function runImpersonationChecks(makeEngine: MakeEngine) {
	const engine = async () => (makeEngine ? {engine: await makeEngine()} : {});
	const [X, Y, Z] = IMPERSONATED;
	const fundAccounts = Object.fromEntries(
		IMPERSONATED.map((a) => [a, IMPERSONATED_BALANCE]),
	);

	// ---- ON: wrapDevNode over a spied 'trusted' node --------------------------
	const {spied, calls} = await spiedTrustedNode(makeEngine, {
		initialBalances: devAccountBalances({fundAccounts}),
	});
	const node = wrapDevNode(spied, {impersonation: true});
	const sends = (since: number) =>
		calls.slice(since).filter((c) => SEND_METHODS.has(c.method));
	const req = (method: string, params?: unknown[]) =>
		node.request({method, params});
	const balance = async (a: string) =>
		(await req('eth_getBalance', [a, 'latest'])) as string;
	const nonce = async (a: string) =>
		(await req('eth_getTransactionCount', [a, 'latest'])) as string;
	const [dev] = (await req('eth_accounts')) as string[];

	// 1. Before impersonating, a send from X is refused, naming the method that
	// would let it, and moves nothing.
	const beforeImpersonating = {
		send: await outcome(
			req('eth_sendTransaction', [{from: X, to: RECIPIENT, value: '0x1'}]),
		),
		nonce: await nonce(X),
		balance: await balance(X),
	};

	// 2. Impersonate X (Hardhat's name), then send AS X: a transfer, a create,
	// and a call to the created contract, which records its caller.
	const impersonateX = await outcome(req('hardhat_impersonateAccount', [X]));
	const recipientBefore = await balance(RECIPIENT);
	let since = calls.length;
	const transferHash = await req('eth_sendTransaction', [
		{from: X, to: RECIPIENT, value: '0x3039'},
	]);
	const transferSends = sends(since).map((c) => ({
		method: c.method,
		claimed: (c.params as unknown[])[1] ?? null,
		tx: decode((c.params as string[])[0]!),
	}));
	const transfer = {
		hash: transferHash,
		receipt: await receiptOf(node, transferHash),
		tx: await req('eth_getTransactionByHash', [transferHash]),
		sends: transferSends,
		balance: await balance(X),
		nonce: await nonce(X),
		recipientBefore,
		recipientAfter: await balance(RECIPIENT),
	};
	const deployHash = await req('eth_sendTransaction', [
		{from: X, data: CALLER_RECORDER_INITCODE},
	]);
	const deploy = {receipt: await receiptOf(node, deployHash)};
	const recorder = deploy.receipt?.contractAddress;
	const callHash = await req('eth_sendTransaction', [
		{from: X, to: recorder, data: '0x'},
	]);
	const call = {
		receipt: await receiptOf(node, callHash),
		slot0: await req('eth_getStorageAt', [recorder, '0x0', 'latest']),
		balance: await balance(X),
		nonce: await nonce(X),
	};

	// 3. Two impersonated senders, otherwise identical transactions: Y through
	// anvil's name, Z through Hardhat's, both at nonce 0.
	const impersonateY = await outcome(req('anvil_impersonateAccount', [Y]));
	await req('hardhat_impersonateAccount', [Z]);
	since = calls.length;
	const twoHashes = [
		await req('eth_sendTransaction', [{from: Y, to: RECIPIENT, value: '0x1'}]),
		await req('eth_sendTransaction', [{from: Z, to: RECIPIENT, value: '0x1'}]),
	];
	const twoSends = sends(since).map((c) => ({
		claimed: (c.params as unknown[])[1] ?? null,
		tx: decode((c.params as string[])[0]!),
	}));
	const twoSenders = {
		hashes: twoHashes,
		sends: twoSends,
		receipts: await Promise.all(twoHashes.map((h) => receiptOf(node, h))),
		balances: [await balance(Y), await balance(Z)],
		nonces: [await nonce(Y), await nonce(Z)],
	};

	// 4. Signing methods refuse an impersonated address: no key is held for it.
	const typedData = {
		types: {
			EIP712Domain: [{name: 'name', type: 'string'}],
			Mail: [{name: 'contents', type: 'string'}],
		},
		primaryType: 'Mail',
		domain: {name: 'webevm'},
		message: {contents: 'hello'},
	};
	since = calls.length;
	const signRefusals = {
		eth_signTransaction: await outcome(
			req('eth_signTransaction', [{from: Z, to: RECIPIENT, value: '0x1'}]),
		),
		personal_sign: await outcome(req('personal_sign', ['0x1234', Z])),
		eth_sign: await outcome(req('eth_sign', [Z, '0x1234'])),
		eth_signTypedData_v4: await outcome(
			req('eth_signTypedData_v4', [Z, JSON.stringify(typedData)]),
		),
		nonce: await nonce(Z),
		sendsMade: sends(since).length,
	};

	// 5. A dev account that is also impersonated signs and sends with its KEY.
	const impersonateDev = await outcome(
		req('hardhat_impersonateAccount', [dev]),
	);
	since = calls.length;
	const devHash = await req('eth_sendTransaction', [
		{from: dev, to: RECIPIENT, value: '0x1'},
	]);
	const devRaw = (sends(since)[0]?.params as string[])[0]!;
	const devSignature = await req('personal_sign', ['0x1234', dev]);
	const devSignedTx = (await req('eth_signTransaction', [
		{from: dev, to: RECIPIENT, value: '0x1'},
	])) as string;
	const devAccount = privateKeyToAccount(DEV_KEY);
	const devAlsoImpersonated = {
		receipt: await receiptOf(node, devHash),
		sendRecoversTo: (
			await recoverTransactionAddress({
				serializedTransaction: devRaw as TransactionSerialized,
			})
		).toLowerCase(),
		signTxRecoversTo: (
			await recoverTransactionAddress({
				serializedTransaction: devSignedTx as TransactionSerialized,
			})
		).toLowerCase(),
		personalSign: devSignature,
		viemPersonalSign: await devAccount.signMessage({message: {raw: '0x1234'}}),
	};

	// 6. Stop impersonating: X through anvil's name (impersonated through
	// Hardhat's), Y through Hardhat's (impersonated through anvil's). Sends from
	// both are refused again and move nothing; Z still sends.
	const stopX = await outcome(req('anvil_stopImpersonatingAccount', [X]));
	const stopY = await outcome(req('hardhat_stopImpersonatingAccount', [Y]));
	const nonceXBefore = await nonce(X);
	since = calls.length;
	const afterStop = {
		x: await outcome(
			req('eth_sendTransaction', [{from: X, to: RECIPIENT, value: '0x1'}]),
		),
		y: await outcome(
			req('eth_sendTransaction', [{from: Y, to: RECIPIENT, value: '0x1'}]),
		),
		sendsMade: sends(since).length,
		nonceXBefore,
		nonceXAfter: await nonce(X),
		z: await outcome(
			req('eth_sendTransaction', [{from: Z, to: RECIPIENT, value: '0x1'}]),
		),
		// Stopping an address that is not impersonated is no error, as on anvil.
		stopAgain: await outcome(req('hardhat_stopImpersonatingAccount', [X])),
	};

	// 7. Malformed parameters are -32602.
	const malformed = {
		noParams: await outcome(req('hardhat_impersonateAccount')),
		notAnAddress: await outcome(req('anvil_impersonateAccount', ['0x1234'])),
		stopNotAnAddress: await outcome(
			req('hardhat_stopImpersonatingAccount', [42]),
		),
	};
	const engineId = node.engine.id;
	await node.dispose();

	// ---- OFF: the methods answer -32601 naming the option --------------------
	const offNode = await createDevNode({
		senderMode: 'trusted',
		...(await engine()),
	});
	const off: Record<string, unknown> = {};
	for (const method of IMPERSONATION_METHODS)
		off[method] = await outcome(offNode.request({method, params: [X]}));
	off.unknownFrom = await outcome(
		offNode.request({
			method: 'eth_sendTransaction',
			params: [{from: X, to: RECIPIENT, value: '0x1'}],
		}),
	);
	await offNode.dispose();

	// ---- createDevNode: makes a 'trusted' node, refuses an explicit 'recover'
	const created = await createDevNode({
		impersonation: true,
		fundAccounts,
		...FEES,
		...(await engine()),
	});
	await created.request({method: 'anvil_impersonateAccount', params: [X]});
	const createdHash = await created.request({
		method: 'eth_sendTransaction',
		params: [{from: X, to: RECIPIENT, value: '0x1'}],
	});
	const createdNode = {
		senderMode: created.senderMode,
		receipt: await receiptOf(created, createdHash),
	};
	await created.dispose();
	const createRecover = await outcome(
		createDevNode({impersonation: true, senderMode: 'recover'}),
	);

	// ---- wrapDevNode on a 'recover' node is refused at once -----------------
	const recoverNode = await createNode({...(await engine())});
	const wrapRecover = thrown(() =>
		wrapDevNode(recoverNode, {impersonation: true}),
	);
	// Off, it wraps a 'recover' node as before.
	const wrapRecoverOff = thrown(() => wrapDevNode(recoverNode));
	await recoverNode.dispose();

	return {
		engineId,
		dev,
		beforeImpersonating,
		impersonateX,
		impersonateY,
		impersonateDev,
		transfer,
		deploy,
		call,
		twoSenders,
		signRefusals,
		devAlsoImpersonated,
		stopX,
		stopY,
		afterStop,
		malformed,
		off,
		createdNode,
		createRecover,
		wrapRecover,
		wrapRecoverOff,
	};
}
