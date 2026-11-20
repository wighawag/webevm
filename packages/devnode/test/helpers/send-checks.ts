/**
 * send-checks.ts: the battery for `eth_sendTransaction` from dev accounts, run in
 * a real browser page by ./cut.ts (default engine) and ./cut-revm.ts
 * (`webevm/revm`), each in BOTH sender modes.
 *
 * WHAT IS SENT is read from the wire, not from the node's answers: every dev
 * node here wraps its node in a SPY that records each request the layer makes,
 * so the raw transaction the layer submitted (and the method it used) is
 * decoded with viem, independently of the package. `eth_getTransactionByHash`
 * carries neither access lists nor authorization lists, so the raw bytes are the
 * only place every field can be checked.
 *
 * It RETURNS what it observed (bigints as decimal strings) and asserts nothing
 * itself: ../send-expected.ts holds the assertions, the same for both engines.
 */
import {
	createWalletClient,
	custom,
	parseTransaction,
	recoverTransactionAddress,
	type EIP1193Provider,
	type TransactionSerialized,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	createNode,
	type Engine,
	type NodeOptions,
	type RequestArguments,
	type SenderMode,
	type SlimNode,
} from 'webevm';
import {
	createDevNode,
	devAccountBalances,
	wrapDevNode,
} from '../../src/index.js';

type MakeEngine = (() => Promise<Engine>) | undefined;

/** The node's fee market, every value distinct, so a fill cannot pass by accident. */
export const FEES = {
	gasPrice: 9_000_000_000n,
	baseFeePerGas: 5_000_000_000n,
	maxPriorityFeePerGas: 2_000_000_000n,
};

/** An EOA that is no dev account: the recipient, and an unknown `from`. */
export const RECIPIENT = '0x00000000000000000000000000000000000000cc';
export const STRANGER = '0x00000000000000000000000000000000000000ee';
/** Where the type-4 authorities delegate to (no code there: a call runs nothing). */
export const DELEGATE = '0x00000000000000000000000000000000000000dd';
/** The authorities of the type-4 sends: keys that are no dev account. */
const AUTHORITY_KEYS = [
	'0x0000000000000000000000000000000000000000000000000000000000000002',
	'0x0000000000000000000000000000000000000000000000000000000000000003',
] as const;

const SEND_METHODS = new Set([
	'eth_sendRawTransaction',
	'eth_sendRawTransactionSync',
	'evm_sendRawTransactionAs',
	'evm_sendRawTransactionSyncAs',
]);

const hex = (v: bigint | number) => `0x${BigInt(v).toString(16)}`;

/** A node whose every request is recorded, wrapped as a dev node. */
async function spiedDevNode(makeEngine: MakeEngine, options: NodeOptions = {}) {
	const inner = await createNode({
		...FEES,
		...options,
		initialBalances: devAccountBalances(),
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
	const node = wrapDevNode(spied);
	const accounts = (await node.request({method: 'eth_accounts'})) as string[];
	/** The send requests the layer made since `from` calls ago. */
	const sends = (since = 0) =>
		calls.slice(since).filter((c) => SEND_METHODS.has(c.method));
	return {node, inner, calls, sends, accounts};
}

/** What a rejected request carried, or 'resolved'. */
async function outcome(p: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		return {resolved: await p};
	} catch (e) {
		const err = e as {code?: unknown; message?: unknown};
		return {code: err.code, message: err.message};
	}
}

/** A raw transaction's fields, decoded by viem, as JSON. */
async function decode(raw: string) {
	const tx = parseTransaction(raw as TransactionSerialized) as Record<
		string,
		unknown
	>;
	const plain = JSON.parse(
		JSON.stringify(tx, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
	) as Record<string, unknown>;
	return {
		...plain,
		signer: (
			await recoverTransactionAddress({
				serializedTransaction: raw as TransactionSerialized,
			})
		).toLowerCase(),
	};
}

async function receiptOf(node: SlimNode, hash: unknown) {
	return (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	})) as {from: string; status: string; blockNumber: string} | null;
}

async function signedAuthorization(
	key: (typeof AUTHORITY_KEYS)[number],
	chainId: number,
	nonce: number,
) {
	const a = await privateKeyToAccount(key).signAuthorization({
		chainId,
		address: DELEGATE,
		nonce,
	});
	return {
		chainId: hex(a.chainId),
		address: a.address.toLowerCase(),
		nonce: hex(a.nonce),
		yParity: hex(a.yParity ?? 0),
		r: a.r,
		s: a.s,
	};
}

/** One mode's battery: the send path, every type's fields, concurrency, refusal. */
async function runMode(makeEngine: MakeEngine, mode: SenderMode) {
	const engine = async () => (makeEngine ? {engine: await makeEngine()} : {});

	// 1. A PLAIN SEND THROUGH viem, on a `createDevNode` node: it mines (auto).
	const devNode = await createDevNode({senderMode: mode, ...(await engine())});
	const [deployer] = (await devNode.request({
		method: 'eth_accounts',
	})) as `0x${string}`[];
	const wallet = createWalletClient({
		transport: custom(devNode as unknown as EIP1193Provider),
	});
	const viemHash = await wallet.sendTransaction({
		account: deployer,
		to: RECIPIENT,
		value: 1234n,
		chain: null,
	});
	const viemSend = {
		receipt: await receiptOf(devNode, viemHash),
		recipientBalance: await devNode.request({
			method: 'eth_getBalance',
			params: [RECIPIENT, 'latest'],
		}),
		blockNumber: await devNode.request({method: 'eth_blockNumber'}),
	};
	await devNode.dispose();

	// 2. THE PATH: which method the layer submitted through, and whether its
	// signature is real (the dump's raw transaction replays on a 'recover' node).
	const s = await spiedDevNode(makeEngine, {senderMode: mode});
	const [from] = s.accounts;
	const pathHash = await s.node.request({
		method: 'eth_sendTransaction',
		params: [{from, to: RECIPIENT, value: '0x1'}],
	});
	const pathSends = s.sends();
	const dump = await s.node.dumpState();
	const raw = dump.transactions[String(pathHash)]!.raw;
	const replayNode = await createDevNode({
		senderMode: 'recover',
		...FEES,
		...(await engine()),
	});
	const replayHash = await outcome(
		replayNode.request({method: 'eth_sendRawTransaction', params: [raw]}),
	);
	const path = {
		receipt: await receiptOf(s.node, pathHash),
		sends: pathSends.map((c) => ({
			method: c.method,
			from: (c.params as unknown[])[1] ?? null,
		})),
		signer: (await decode(raw)).signer,
		hash: pathHash,
		replayHash,
		replayReceipt:
			'resolved' in replayHash
				? await receiptOf(replayNode, replayHash.resolved)
				: null,
	};
	await replayNode.dispose();

	// 3. FIELDS, per type: every field NAMED is what is sent; every one left
	// out is filled (nonce from `pending`, gas from `eth_estimateGas` on the same
	// request just before, fees from the node's fee market).
	const chainId = Number(await s.node.request({method: 'eth_chainId'}));
	const accessList = [
		{
			address: RECIPIENT,
			storageKeys: [
				'0x0000000000000000000000000000000000000000000000000000000000000007',
			],
		},
	];
	const authorities = AUTHORITY_KEYS.map((k) =>
		privateKeyToAccount(k).address.toLowerCase(),
	);
	const fields: Record<string, unknown> = {};
	const sendAndRead = async (
		name: string,
		request: Record<string, unknown>,
	) => {
		const pendingNonce = await s.node.request({
			method: 'eth_getTransactionCount',
			params: [from, 'pending'],
		});
		const estimate =
			request.gas === undefined
				? await s.node.request({method: 'eth_estimateGas', params: [request]})
				: null;
		const since = s.calls.length;
		const result = await outcome(
			s.node.request({method: 'eth_sendTransaction', params: [request]}),
		);
		const sent = s.sends(since);
		fields[name] = {
			request,
			result,
			pendingNonce,
			estimate,
			sent:
				sent.length === 1
					? await decode((sent[0].params as string[])[0])
					: null,
			sendCount: sent.length,
			receipt:
				'resolved' in result ? await receiptOf(s.node, result.resolved) : null,
		};
	};
	const nextNonce = async () =>
		hex(
			BigInt(
				(await s.node.request({
					method: 'eth_getTransactionCount',
					params: [from, 'pending'],
				})) as string,
			),
		);
	const named = {
		to: RECIPIENT,
		value: '0x2a',
		data: '0x1234',
		gas: '0x186a0',
	};
	// Type 0.
	await sendAndRead('type0Full', {
		from,
		...named,
		nonce: await nextNonce(),
		gasPrice: hex(11_000_000_000n),
	});
	await sendAndRead('type0Sparse', {
		from,
		to: RECIPIENT,
		gasPrice: hex(12_000_000_000n),
	});
	await sendAndRead('type0ByType', {from, to: RECIPIENT, type: '0x0'});
	// Type 1.
	await sendAndRead('type1Full', {
		from,
		...named,
		nonce: await nextNonce(),
		gasPrice: hex(11_000_000_000n),
		accessList,
	});
	await sendAndRead('type1Sparse', {
		from,
		to: RECIPIENT,
		gasPrice: hex(12_000_000_000n),
		accessList,
	});
	// Type 2.
	await sendAndRead('type2Full', {
		from,
		...named,
		nonce: await nextNonce(),
		maxFeePerGas: hex(13_000_000_000n),
		maxPriorityFeePerGas: hex(3_000_000_000n),
		accessList,
	});
	await sendAndRead('type2Sparse', {from, to: RECIPIENT});
	await sendAndRead('type2OnlyMaxFee', {
		from,
		to: RECIPIENT,
		maxFeePerGas: hex(13_000_000_000n),
	});
	await sendAndRead('type2Create', {from, data: '0x00'});
	// Type 4: each authority delegates to DELEGATE and the transaction is sent to it.
	await sendAndRead('type4Full', {
		from,
		...named,
		to: authorities[0],
		nonce: await nextNonce(),
		maxFeePerGas: hex(13_000_000_000n),
		maxPriorityFeePerGas: hex(3_000_000_000n),
		accessList,
		authorizationList: [
			await signedAuthorization(AUTHORITY_KEYS[0], chainId, 0),
		],
	});
	await sendAndRead('type4Sparse', {
		from,
		to: authorities[1],
		authorizationList: [
			await signedAuthorization(AUTHORITY_KEYS[1], chainId, 0),
		],
	});
	const delegatedCode = await Promise.all(
		authorities.map((a) =>
			s.node.request({method: 'eth_getCode', params: [a, 'latest']}),
		),
	);
	// A named nonce is sent as named, even a stale one the node then refuses.
	await sendAndRead('staleNonce', {from, to: RECIPIENT, nonce: '0x0'});
	// Requests that cannot be sent as named are refused, never trimmed.
	await sendAndRead('gasPriceAnd1559', {
		from,
		to: RECIPIENT,
		gasPrice: hex(11_000_000_000n),
		maxFeePerGas: hex(13_000_000_000n),
	});
	await sendAndRead('accessListOnType0', {
		from,
		to: RECIPIENT,
		type: '0x0',
		accessList,
	});
	await sendAndRead('wrongChainId', {from, to: RECIPIENT, chainId: '0x1'});

	// 4. CONCURRENCY: two sends from one account at once both mine, with
	// consecutive nonces, in auto mining (each mined at once) and in manual (both
	// queued, then one block).
	const concurrency: Record<string, unknown> = {};
	const concurrent = async (node: SlimNode) => {
		const before = await node.request({
			method: 'eth_getTransactionCount',
			params: [from, 'pending'],
		});
		const hashes = await Promise.all(
			[1, 2].map((v) =>
				outcome(
					node.request({
						method: 'eth_sendTransaction',
						params: [{from, to: RECIPIENT, value: hex(v)}],
					}),
				),
			),
		);
		return {before, hashes};
	};
	// The auto-mining half reuses the spied node, so it starts at whatever nonce
	// the field sends left the account at.
	concurrency.auto = await (async () => {
		const {before, hashes} = await concurrent(s.node);
		return {
			before,
			hashes,
			txs: await Promise.all(
				hashes.map(async (h) =>
					'resolved' in h
						? {
								receipt: await receiptOf(s.node, h.resolved),
								tx: await s.node.request({
									method: 'eth_getTransactionByHash',
									params: [h.resolved],
								}),
							}
						: null,
				),
			),
		};
	})();
	const manual = await spiedDevNode(makeEngine, {
		senderMode: mode,
		miningConfig: {type: 'manual'},
	});
	concurrency.manual = await (async () => {
		const {before, hashes} = await concurrent(manual.node);
		const mined = await manual.node.mine();
		return {
			before,
			hashes,
			mined,
			txs: await Promise.all(
				hashes.map(async (h) =>
					'resolved' in h
						? {
								receipt: await receiptOf(manual.node, h.resolved),
								tx: await manual.node.request({
									method: 'eth_getTransactionByHash',
									params: [h.resolved],
								}),
							}
						: null,
				),
			),
		};
	})();
	await manual.node.dispose();

	// 5. REFUSAL: a `from` that is no dev account, and no `from` at all, moves
	// nothing and reaches no send method.
	const snapshot = async () => ({
		blockNumber: await s.node.request({method: 'eth_blockNumber'}),
		fromNonce: await s.node.request({
			method: 'eth_getTransactionCount',
			params: [from, 'pending'],
		}),
		strangerNonce: await s.node.request({
			method: 'eth_getTransactionCount',
			params: [STRANGER, 'pending'],
		}),
		recipient: await s.node.request({
			method: 'eth_getBalance',
			params: [RECIPIENT, 'latest'],
		}),
	});
	const before = await snapshot();
	const since = s.calls.length;
	const unknown = await outcome(
		s.node.request({
			method: 'eth_sendTransaction',
			params: [{from: STRANGER, to: RECIPIENT, value: '0x1'}],
		}),
	);
	const noFrom = await outcome(
		s.node.request({
			method: 'eth_sendTransaction',
			params: [{to: RECIPIENT, value: '0x1'}],
		}),
	);
	const noParams = await outcome(
		s.node.request({method: 'eth_sendTransaction'}),
	);
	const refusal = {
		unknown,
		noFrom,
		noParams,
		before,
		after: await snapshot(),
		sendsMade: s.sends(since).length,
	};
	await s.node.dispose();

	return {
		engineId: s.node.engine.id,
		from,
		chainId,
		authorities,
		viemSend,
		path,
		fields,
		delegatedCode,
		concurrency,
		refusal,
	};
}

export async function runSendChecks(makeEngine: MakeEngine) {
	const out: Record<string, unknown> = {
		recover: await runMode(makeEngine, 'recover'),
		trusted: await runMode(makeEngine, 'trusted'),
	};
	// Before Prague the node refuses an authorization list, in its own words.
	const cancun = await createDevNode({
		hardfork: 'cancun',
		...(makeEngine ? {engine: await makeEngine()} : {}),
	});
	const [from] = (await cancun.request({method: 'eth_accounts'})) as string[];
	out.cancunType4 = await outcome(
		cancun.request({
			method: 'eth_sendTransaction',
			params: [
				{
					from,
					to: RECIPIENT,
					authorizationList: [
						await signedAuthorization(AUTHORITY_KEYS[0], 31337, 0),
					],
				},
			],
		}),
	);
	await cancun.dispose();
	return out;
}
