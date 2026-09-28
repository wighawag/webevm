/**
 * revm-worker-roundtrip.ts: runs in the browser PAGE and drives
 * ./revm-worker.ts (the consumer's own worker module, which builds the revm
 * engine inside the Worker) through the ordinary `createWorkerNode()` client.
 *
 * The client code here is deliberately the SAME as ./worker-roundtrip.ts's: the
 * point of the recipe is that a consumer's main thread does not change when the
 * engine does. What differs is the Worker URL it is handed, and therefore which
 * EVM answers.
 *
 * What it measures, in the order it measures it:
 *   1. the node's identity ACROSS the boundary (`engine.id`,
 *      `computeStateRoot`, `senderMode`; the engine id is what the node was BUILT with, so it is
 *      necessary but weak on its own), plus a SECOND worker node with
 *      `computeStateRoot: true`, which revm serves (the trie is derived from the flat
 *      state, ADR 0014; it used to be refused here), reporting a real root
 *      across the boundary;
 *   2. REFERENCE EXECUTION GAS through the boundary, on a freshly deployed
 *      contract: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)`
 *      1107052 and its result hash. This is the strong evidence: an engine that
 *      failed to come up cannot produce these at all, because `createNode()` has
 *      no fallback path: a node either runs the engine it was given or throws;
 *   3. a COMMITTING transaction (20 of them) crossing the boundary, with the
 *      state they wrote read back through the node's own surface three ways
 *      (a contract read, the raw slot, the sender's nonce) plus the money that
 *      left the sender, which no receipt field can fake;
 *   4. the main thread staying responsive while the Worker computes.
 *
 * `eth_sendRawTransactionSync` is signed here rather than sent through viem's
 * estimate-then-send path, for the same reason ./worker-roundtrip.ts does it:
 * fewer comlink round trips per transaction, and nothing here is measuring viem.
 */
import {createWorkerNode} from '../../src/worker-client.js';
import {encodeFunctionData, decodeFunctionResult} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
/** What the sender starts with, as everywhere else in this suite. */
const FUNDED_BALANCE = 10n ** 24n;
/** How many committing transactions cross the boundary. */
const INCREMENTS = 20;
/**
 * How many heavy reads make up the responsiveness window.
 *
 * ./worker-roundtrip.ts runs 5 of them on `@ethereumjs/evm`; revm executes the
 * same call several times faster, so 5 would leave WebKit (whose nested
 * `setTimeout` is clamped to ~4 ms) barely over the sampler bar. More iterations,
 * not a bigger `sumTo`: the read budget is 30M gas and `sumTo(50000)` already
 * spends ~12.5M of it.
 */
const HEAVY_CALLS = 15;

/**
 * Restates the node's intrinsic-gas formula for a CALL, so decomposing an
 * estimate into EXECUTION gas is a real comparison rather than a tautology. The
 * same restatement, for the same reason, as ./revm-engine.ts's.
 *
 * A CALL only: every fork-dependent term in the shared formula applies to a
 * CREATE, so a call's intrinsic gas is the same number at every fork this engine
 * admits.
 */
function intrinsicGasForCall(dataHex: string): bigint {
	const hex = dataHex.startsWith('0x') ? dataHex.slice(2) : dataHex;
	let gas = 21_000n;
	for (let i = 0; i < hex.length; i += 2) {
		gas += hex.slice(i, i + 2) === '00' ? 4n : 16n;
	}
	return gas;
}

export async function revmWorkerRoundtrip(workerUrl: string, sumTo: number) {
	const worker = new Worker(workerUrl, {type: 'module'});
	// THE RECIPE, from the main thread's side: unchanged client code. The only
	// thing that says "revm" up here is which module the Worker was pointed at.
	const node = await createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: FUNDED_BALANCE},
	});

	const results: Record<string, unknown> = {
		engineId: node.engine?.id,
		computeStateRoot: node.computeStateRoot,
		senderMode: node.senderMode,
	};

	// ---- computeStateRoot, on revm, INSIDE the Worker ----
	// revm serves `computeStateRoot: true` (the trie is derived from the flat state
	// between blocks and no engine reads it, ADR 0014; this used to be the
	// refusal the recipe asserted). Built inside the Worker, it must still be
	// revm, and its root must cross the boundary as a real one.
	const trieWorker = new Worker(workerUrl, {type: 'module'});
	try {
		const trieNode = await createWorkerNode({
			worker: trieWorker,
			chainId: CHAIN_ID,
			computeStateRoot: true,
		});
		await trieNode.mine();
		results.trieServed = {
			engineId: trieNode.engine?.id,
			computeStateRoot: trieNode.computeStateRoot,
			root: await trieNode.getStateRoot(),
		};
		await trieNode.dispose();
	} catch (e) {
		results.trieServed = `threw:${String((e as Error)?.message ?? e)}`;
	}
	trieWorker.terminate();

	const send = async (raw: `0x${string}`) =>
		(await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as {status: string; contractAddress?: `0x${string}`};
	const call = async (to: `0x${string}`, data: `0x${string}`) =>
		String(
			await node.request({
				method: 'eth_call',
				params: [{from: account.address, to, data}, 'latest'],
			}),
		);
	const estimate = async (to: `0x${string}`, data: `0x${string}`) =>
		String(
			await node.request({
				method: 'eth_estimateGas',
				params: [{from: account.address, to, data}],
			}),
		);

	// ---- deploy, on revm, in the Worker ----
	const deployRcpt = await send(
		(await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: 0,
			to: undefined,
			data: counterBytecode,
			gas: 3_000_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		})) as `0x${string}`,
	);
	const address = deployRcpt.contractAddress as `0x${string}`;
	results.deployStatus = deployRcpt.status;

	// ---- the reference numbers, measured THROUGH the boundary ----
	// Taken on the freshly deployed contract, before any increment, so `number()`
	// is the same cold-SLOAD read the main-thread specs measure.
	const calls = {
		number: encodeFunctionData({abi: counterAbi, functionName: 'number'}),
		sumTo2000: encodeFunctionData({
			abi: counterAbi,
			functionName: 'sumTo',
			args: [2000n],
		}),
		keccakLoop2000: encodeFunctionData({
			abi: counterAbi,
			functionName: 'keccakLoop',
			args: [2000n],
		}),
	} as const;
	const callResults: Record<string, string> = {};
	const executionGas: Record<string, string> = {};
	for (const [name, data] of Object.entries(calls)) {
		callResults[name] = await call(address, data);
		executionGas[name] = (
			BigInt(await estimate(address, data)) - intrinsicGasForCall(data)
		).toString();
	}
	results.callResults = callResults;
	results.executionGas = executionGas;

	// ---- committing transactions, across the boundary ----
	const balanceBefore = BigInt(
		String(
			await node.request({
				method: 'eth_getBalance',
				params: [account.address, 'latest'],
			}),
		),
	);
	const incrementData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});
	let nonce = Number(
		await node.request({
			method: 'eth_getTransactionCount',
			params: [account.address, 'latest'],
		}),
	);
	const t0 = performance.now();
	let last: {status: string} | undefined;
	for (let i = 0; i < INCREMENTS; i++) {
		last = await send(
			(await account.signTransaction({
				chainId: CHAIN_ID,
				nonce: nonce++,
				to: address,
				data: incrementData,
				gas: 200_000n,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
				type: 'eip1559',
			})) as `0x${string}`,
		);
	}
	const roundtripAvgMs = (performance.now() - t0) / INCREMENTS;
	results.txStatus = last!.status;
	results.roundtripAvgMs = roundtripAvgMs;

	// ...and the state those transactions wrote, read back through the node's own
	// surface: the contract's answer, the raw slot underneath it, and the nonce.
	results.numberAfterTx = String(
		decodeFunctionResult({
			abi: counterAbi,
			functionName: 'number',
			data: (await call(address, calls.number)) as `0x${string}`,
		}),
	);
	results.storageAfterTx = String(
		await node.request({
			method: 'eth_getStorageAt',
			params: [address, '0x0', 'latest'],
		}),
	);
	results.senderNonceAfterTx = String(
		await node.request({
			method: 'eth_getTransactionCount',
			params: [account.address, 'latest'],
		}),
	);
	const balanceAfter = BigInt(
		String(
			await node.request({
				method: 'eth_getBalance',
				params: [account.address, 'latest'],
			}),
		),
	);
	// A receipt can report a perfect `gasUsed` while nothing was charged; the
	// balance is the reading that cannot.
	results.senderPaid = balanceAfter < balanceBefore;
	results.senderBalanceDelta = (balanceBefore - balanceAfter).toString();

	// ---- the main thread stays responsive while the Worker computes ----
	// Identical in shape to ./worker-roundtrip.ts: `maxGap` is REPORTED, never
	// asserted against a fixed millisecond bound (WebKit clamps
	// `performance.now()` to 1 ms, and `setTimeout(…, 0)` is clamped too). What is
	// asserted is `sampleCount` (a BLOCKED main thread cannot run the sampler at
	// all), plus a ratio of two figures taken in the same window on the same clock.
	const sumData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'sumTo',
		args: [BigInt(sumTo)],
	});
	let maxGap = 0;
	let sampleCount = 0;
	let lastTick = performance.now();
	let stop = false;
	const sampler = () => {
		const now = performance.now();
		const gap = now - lastTick;
		if (gap > maxGap) maxGap = gap;
		lastTick = now;
		sampleCount++;
		if (!stop) setTimeout(sampler, 0);
	};
	sampler();
	const tCompute = performance.now();
	for (let i = 0; i < HEAVY_CALLS; i++) await call(address, sumData);
	const workerComputeMs = performance.now() - tCompute;
	stop = true;

	results.mainThreadMaxGapMs = maxGap;
	results.mainThreadSampleCount = sampleCount;
	results.workerComputeMs = workerComputeMs;

	await node.dispose();
	return {
		results,
		timings: [
			{label: 'roundtripAvg', ms: roundtripAvgMs},
			{label: 'mainThreadMaxGap', ms: maxGap},
			{label: 'workerCompute', ms: workerComputeMs},
		],
	};
}
