/**
 * worker-roundtrip.ts — runs in the browser page. Proves the slim node's
 * Worker story:
 *   1. The SAME node API works across a comlink thread boundary (createWorkerNode
 *      returns the same {request, mine, ...} shape as createNode).
 *   2. Round-trip latency over comlink (send raw tx sync + read) is measured.
 *   2b. The node's IDENTITY fields survive the boundary as plain values — in
 *      particular `engine`, which is what a bug report quotes to say which
 *      EVM produced a result. It is proxied by worker-host.ts and nothing else
 *      asserts it round-trips (the same omission silently dropped `senderMode`
 *      for a month; that observation note was discharged by deletion with the
 *      fix, in commit 606a89c, and the story it carried now lives in
 *      `src/worker-host.ts`'s module comment, in the field-by-field check at 2c
 *      below, and in `worker.spec.ts`'s assertion on it).
 *   2c. ...and so does EVERY OTHER field, named by NOTHING: the Worker-backed
 *      node is compared field for field against a main-thread `createNode()`,
 *      so a field ADDED to `SlimNode` later is covered by this the day it is
 *      added rather than the day somebody remembers to assert it. THE LIMIT OF
 *      THAT, stated because the guarantee otherwise reads wider than it is: the
 *      reference is a node INSTANCE, so this covers every field such an instance
 *      CARRIES, and an OPTIONAL `SlimNode` member the reference node does not set
 *      is invisible here. The compile-time half is what covers that one: the ONE
 *      proxy in `src/worker-host.ts` is a literal typed `Required<SlimNode>`, so
 *      dropping a field there, optional or not, no longer builds.
 *   3. The main thread stays NON-BLOCKING while the Worker runs a heavy compute:
 *      we kick off a heavy sumTo() in the Worker and simultaneously tick a
 *      main-thread rAF/now() loop; if the main thread were blocked (as it is when
 *      the EVM runs on the main thread), the loop would freeze. We report the
 *      longest main-thread gap observed during the Worker compute.
 *
 * The Worker URL is injected by the test as `params.workerUrl` (a bundled
 * worker-entry served by the harness server).
 */
import {createWorkerNode} from '../../src/worker-client.js';
import {createNode} from '../../src/node.js';
import type {SlimNode} from '../../src/types.js';
import {createWalletClient, createPublicClient, custom} from 'viem';
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

export async function workerRoundtrip(workerUrl: string, sumTo: number) {
	const worker = new Worker(workerUrl, {type: 'module'});
	const node = await createWorkerNode({
		worker,
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

	// deploy across the thread boundary (same API as main-thread node).
	// Sign + send raw ourselves (sync receipt) to avoid viem's estimate path
	// round-tripping over comlink during the deploy.
	const deployRaw = await account.signTransaction({
		chainId: CHAIN_ID,
		nonce: 0,
		to: undefined,
		data: counterBytecode,
		gas: 3_000_000n,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 1_000_000_000n,
		type: 'eip1559',
	});
	const deployRcpt: any = await node.request({
		method: 'eth_sendRawTransactionSync',
		params: [deployRaw],
	});
	const address = deployRcpt.contractAddress as `0x${string}`;

	// measure comlink round-trip: signed sendRawTransactionSync + read, averaged
	const N = 20;
	let nonce = Number(
		await node.request({
			method: 'eth_getTransactionCount',
			params: [account.address, 'latest'],
		}),
	);
	const incrementData = (await import('viem')).encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});
	const t0 = performance.now();
	for (let i = 0; i < N; i++) {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: nonce++,
			to: address,
			data: incrementData,
			gas: 200_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		});
		await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
	}
	const roundtripAvgMs = (performance.now() - t0) / N;

	const number = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();

	// main-thread non-blocking proof: kick a heavy compute in the Worker (a big
	// sumTo via eth_call) and sample the main-thread clock at high frequency; the
	// largest gap between samples is how long the main thread was ever stalled.
	const sumData = (await import('viem')).encodeFunctionData({
		abi: counterAbi,
		functionName: 'sumTo',
		args: [BigInt(sumTo)],
	});
	// We report maxGap but do NOT assert a raw millisecond bound on it: WebKit
	// clamps `performance.now()` to 1 ms and `setTimeout(…, 0)` is clamped too, so
	// the value quantises to integers and any fixed bound sits one quantum from a
	// coin flip (a `< 15` bound returned exactly 15 on WebKit and reddened the
	// gate for unrelated work). `sampleCount` is the load-invariant proof: a main
	// thread that is BLOCKED cannot run the sampler at all, so "it fired many
	// times during the compute" is the property, measured on no clock.
	let maxGap = 0;
	let sampleCount = 0;
	let last = performance.now();
	let stop = false;
	const sampler = () => {
		const now = performance.now();
		const gap = now - last;
		if (gap > maxGap) maxGap = gap;
		last = now;
		sampleCount++;
		if (!stop) setTimeout(sampler, 0);
	};
	sampler();
	// run a batch of heavy compute calls in the Worker
	const tCompute = performance.now();
	for (let i = 0; i < 5; i++) {
		await node.request({
			method: 'eth_call',
			params: [{to: address, data: sumData}, 'latest'],
		});
	}
	const workerComputeMs = performance.now() - tCompute;
	stop = true;

	// Read back THROUGH comlink: every plain SlimNode field the worker-host
	// proxy is supposed to forward. An omission here reads as `undefined`.
	const engineId = node.engine?.id;
	const senderMode = node.senderMode;
	const computeStateRoot = node.computeStateRoot;

	// THE SAME QUESTION, ASKED WITHOUT NAMING ANY FIELD. The three readings above
	// are today's fields; this is the one that covers tomorrow's. A main-thread
	// node built with the same options is the reference shape, and EVERY key it
	// has must arrive across the boundary with the same kind of value. `senderMode`
	// was dropped from the proxy for a month reading as `undefined` on a property
	// typed `'recover' | 'trusted'`; this reports exactly that class of gap for any
	// field, including one added after this test was written.
	const reference = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	});
	const shapeGaps: string[] = [];
	for (const key of Object.keys(reference) as (keyof SlimNode)[]) {
		const mine = reference[key];
		const theirs = (node as SlimNode)[key];
		if (theirs === undefined) {
			shapeGaps.push(`${key}: absent across the boundary`);
		} else if (typeof theirs !== typeof mine) {
			shapeGaps.push(
				`${key}: ${typeof theirs} across the boundary, ${typeof mine} on the main thread`,
			);
		}
	}
	await reference.dispose();

	await node.dispose();
	return {
		number,
		engineId,
		senderMode,
		computeStateRoot,
		shapeGaps,
		roundtripAvgMs,
		mainThreadMaxGapMs: maxGap,
		mainThreadSampleCount: sampleCount,
		workerComputeMs,
	};
}
