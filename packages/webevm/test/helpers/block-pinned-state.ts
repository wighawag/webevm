/**
 * block-pinned-state.ts: A STATE READ PINNED TO A BLOCK IS EITHER ANSWERED AT
 * THAT BLOCK OR REFUSED, never answered from the head.
 *
 * The defect this suite pins: `eth_call` (and every other state read taking a
 * block parameter) ignored the block and answered from the live state, while
 * `eth_getLogs` honoured its range. A client that pins a pair of reads to one
 * block (logs up to N, and a view call at N) so they describe the same moment got
 * logs as of N and storage as of the head, silently. This node keeps only the
 * head's state, so the contract is: the head (by tag, number, hash or EIP-1898
 * object) is served, a block below it is REFUSED with -32000 `historical state
 * not available`, and a block above it is `header not found`.
 *
 * THE CONSUMER'S SHAPE IS REPRODUCED FIRST, through viem: read a block number,
 * mine a transaction that changes storage, then `readContract` pinned to the
 * block read before it. That call must fail; before the fix it returned the NEW
 * value, which is the bug.
 */
import {createNode, type SlimNode} from '../../src/index.js';
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

/** What one raw request produced: a result, or the RpcError's code and message. */
export type Outcome = {ok: unknown} | {code: number; message: string};

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

export async function runBlockPinnedStateChecks() {
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const counter = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress as Hex;

	// ---- the consumer's shape --------------------------------------------------
	// Read the head, then a block that CHANGES STORAGE is mined, then read pinned
	// to the block read before it.
	// Read RAW, not through `pub.getBlockNumber()`: viem caches that for seconds,
	// so it would report the same number on both sides of the mine below.
	const blockNumber = async () =>
		BigInt(String(await node.request({method: 'eth_blockNumber'})));
	const previous = await blockNumber();
	await wallet.writeContract({
		address: counter,
		abi: counterAbi,
		functionName: 'increment',
	});
	const head = await blockNumber();
	const headBlock = await pub.getBlock({blockNumber: head});

	let viemPinnedToPrevious: {value?: string; error?: string};
	try {
		const v = await pub.readContract({
			address: counter,
			abi: counterAbi,
			functionName: 'number',
			blockNumber: previous,
		});
		viemPinnedToPrevious = {value: String(v)};
	} catch (e: any) {
		viemPinnedToPrevious = {error: String(e?.message ?? e)};
	}
	const viemPinnedToHead = String(
		await pub.readContract({
			address: counter,
			abi: counterAbi,
			functionName: 'number',
			blockNumber: head,
		}),
	);

	// ---- every state read, at every kind of block reference --------------------
	const callData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'number',
	});
	const call = {to: counter, data: callData};
	const prevHex = '0x' + previous.toString(16);
	const headHex = '0x' + head.toString(16);
	const futureHex = '0x' + (head + 1n).toString(16);
	const methods: Record<string, (block: unknown) => [string, unknown[]]> = {
		eth_call: (b) => ['eth_call', [call, b]],
		eth_estimateGas: (b) => [
			'eth_estimateGas',
			[{...call, from: account.address}, b],
		],
		eth_getBalance: (b) => ['eth_getBalance', [account.address, b]],
		eth_getTransactionCount: (b) => [
			'eth_getTransactionCount',
			[account.address, b],
		],
		eth_getCode: (b) => ['eth_getCode', [counter, b]],
		eth_getStorageAt: (b) => ['eth_getStorageAt', [counter, '0x0', b]],
	};
	const refs: Record<string, unknown> = {
		absent: undefined,
		latest: 'latest',
		pending: 'pending',
		safe: 'safe',
		finalized: 'finalized',
		headNumber: headHex,
		headHash: headBlock.hash,
		headObjectNumber: {blockNumber: headHex},
		headObjectHash: {blockHash: headBlock.hash},
		headHashUpper: '0x' + headBlock.hash!.slice(2).toUpperCase(),
		headObjectHashCanonical: {
			blockHash: headBlock.hash,
			requireCanonical: true,
		},
		headNumberZeroPadded: '0x000' + head.toString(16),
		previousNumber: prevHex,
		earliest: 'earliest',
		previousObjectNumber: {blockNumber: prevHex},
		future: futureHex,
		unknownHash: '0x' + '11'.repeat(32),
		garbage: 'yesterday',
		bothKeys: {blockHash: headBlock.hash, blockNumber: headHex},
		huge: '0x' + 'f'.repeat(20),
	};
	const matrix: Record<string, Record<string, Outcome>> = {};
	for (const [name, build] of Object.entries(methods)) {
		matrix[name] = {};
		for (const [refName, ref] of Object.entries(refs)) {
			// An absent block parameter is sent as a SHORTER params array, which is
			// how a client omits it, not as an explicit `undefined`.
			const [method, params] = build(ref);
			const trimmed =
				ref === undefined ? params.slice(0, params.length - 1) : params;
			matrix[name][refName] = await outcome(node, method, trimmed);
		}
	}

	// `earliest` IS the head on a chain that has mined nothing, and is served.
	const empty = await createNode({chainId: CHAIN_ID});
	const earliestAtGenesis = await outcome(empty, 'eth_getBalance', [
		account.address,
		'earliest',
	]);

	return {
		earliestAtGenesis,
		previous: Number(previous),
		head: Number(head),
		viemPinnedToPrevious,
		viemPinnedToHead,
		matrix,
	};
}
