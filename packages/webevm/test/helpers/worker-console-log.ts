/**
 * worker-console-log.ts: runs in the browser PAGE. Solidity `console.log` on a
 * WORKER-hosted node, enabled in the worker module through
 * `exposeNode({createConsoleLog})` (`./console-log-worker.ts`) and observed from
 * this thread through `createWorkerNode()`'s `onConsoleLog` (ADR 0018).
 *
 *   1. A main-thread subscriber receives the entries of a deployment, a
 *      transaction and an `eth_call`, field for field what a main-thread node
 *      delivers for the same chain, and unsubscribing stops them; the default
 *      sink printed them in the WORKER's console.
 *   2. A custom `onLog` passed in the worker module runs there, and replaces
 *      the default print.
 *   3. A worker node without console logging refuses `onConsoleLog`
 *      synchronously, naming `createConsoleLog`.
 *   4. A `createNode` factory receives the option `createConsoleLog` built, and
 *      one that enables console logging by itself delivers entries here.
 *   5. A non-function and a throwing `createConsoleLog` reject the main thread
 *      instead of hanging it, the first also said early on its own thread.
 *   6. `createWorkerNode({consoleLog})` is refused before anything is posted.
 */
import {createNode} from '../../src/node.js';
import {createWorkerNode} from '../../src/worker-client.js';
import {consoleLog, type ConsoleLogEntry} from '../../src/console-log.js';
import type {NodeOptions, SlimNode} from '../../src/types.js';
import {encodeFunctionData, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {
	consoleLogProbeAbi,
	consoleLogProbeBytecode,
} from './console-log-probe.js';
import {
	reportChannelName,
	type WorkerReport,
} from './console-log-worker-report.js';
import {
	driveMisusedEngineWorker,
	reportHostOptionsEarlySignal,
} from './engine-misuse.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
/** Pinned, so the worker node and the main-thread one mine identical blocks. */
const PINNED_TIME = 1_800_000_000n;
/** How long a condition that should become true is given to do so. */
const WAIT_BUDGET_MS = 10_000;

/** An entry as it can cross back to the spec: bigints as decimal strings. */
type PlainEntry = Omit<ConsoleLogEntry, 'args'> & {args: unknown[]};

function plain(e: ConsoleLogEntry): PlainEntry {
	return {
		...e,
		args: e.args.map((a) => (typeof a === 'bigint' ? `${a}n` : a)),
	} as PlainEntry;
}

/** Shared by both kinds of node, so neither `engine` nor `consoleLog`. */
function nodeOptions(): Omit<NodeOptions, 'engine' | 'consoleLog'> {
	return {
		chainId: CHAIN_ID,
		initialBalances: {[account.address]: 10n ** 24n},
		genesisTimestamp: PINNED_TIME,
		blockEnv: {timestamp: PINNED_TIME},
	};
}

function withMode(workerUrl: string, mode: string): string {
	const url = new URL(workerUrl);
	url.searchParams.set('consoleLog', mode);
	return url.href;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `cond()` holds; `false` if it never did within the budget. */
async function waitFor(cond: () => boolean): Promise<boolean> {
	const until = performance.now() + WAIT_BUDGET_MS;
	while (!cond()) {
		if (performance.now() > until) return false;
		await sleep(10);
	}
	return true;
}

/**
 * Entries reach a WORKER node's subscriber over the callback's own comlink port,
 * and an unsubscribe goes over its own, so neither is ordered against a request's
 * answer. This lets either settle before the next step.
 */
const settle = () => sleep(200);

/** Everything the worker posts on its report channel, for one mode. */
function listen(mode: string) {
	const reports: WorkerReport[] = [];
	const channel = new BroadcastChannel(reportChannelName(mode));
	channel.onmessage = (ev) => reports.push(ev.data as WorkerReport);
	return {reports, close: () => channel.close()};
}

async function openWorkerNode(workerUrl: string, mode: string) {
	const worker = new Worker(withMode(workerUrl, mode), {type: 'module'});
	const node = await createWorkerNode({worker, ...nodeOptions()});
	return node;
}

/** The fixture's calls, through `request` only. */
function client(node: SlimNode) {
	let nonce = 0;
	async function send(to: Hex | null, data: Hex): Promise<Hex> {
		const raw = await account.signTransaction({
			chainId: CHAIN_ID,
			nonce: nonce++,
			...(to ? {to} : {}),
			data,
			gas: 1_000_000n,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		});
		return (await node.request({
			method: 'eth_sendRawTransaction',
			params: [raw],
		})) as Hex;
	}
	return {
		send,
		async deploy(): Promise<Hex> {
			const hash = await send(null, consoleLogProbeBytecode);
			const receipt = (await node.request({
				method: 'eth_getTransactionReceipt',
				params: [hash],
			})) as {contractAddress: Hex};
			return receipt.contractAddress;
		},
		work: (n: bigint) =>
			encodeFunctionData({
				abi: consoleLogProbeAbi,
				functionName: 'work',
				args: [n],
			}),
		peek: () =>
			encodeFunctionData({
				abi: consoleLogProbeAbi,
				functionName: 'peek',
				args: [account.address],
			}),
		call(to: Hex, data: Hex) {
			return node.request({
				method: 'eth_call',
				params: [{from: account.address, to, data}, 'latest'],
			});
		},
	};
}

/**
 * The same chain on any node: a deployment (1 entry), a transaction (3) and an
 * `eth_call` (1) with two subscribers, then the first unsubscribes and a second
 * transaction (3) reaches only the other.
 */
async function scenario(node: SlimNode) {
	const first: PlainEntry[] = [];
	const other: PlainEntry[] = [];
	const unsubscribe = node.onConsoleLog((e) => first.push(plain(e)));
	node.onConsoleLog((e) => other.push(plain(e)));
	await settle();
	const c = client(node);
	const address = await c.deploy();
	await c.send(address, c.work(1n));
	await c.call(address, c.peek());
	const arrived = await waitFor(() => first.length >= 5 && other.length >= 5);
	const subscribed = [...first];
	unsubscribe();
	await settle();
	await c.send(address, c.work(2n));
	const otherArrived = await waitFor(() => other.length >= 8);
	await settle();
	return {
		arrived,
		otherArrived,
		subscribed,
		afterUnsubscribe: first.slice(subscribed.length),
		other,
	};
}

/** 1. entries over comlink, field for field, and the default sink in the worker. */
async function delivered(workerUrl: string) {
	const reference = await createNode({
		...nodeOptions(),
		consoleLog: consoleLog({onLog: () => {}}),
	});
	const mainThread = await scenario(reference);
	await reference.dispose();

	const reports = listen('default');
	const node = await openWorkerNode(workerUrl, 'default');
	try {
		const worker = await scenario(node);
		await waitFor(
			() => reports.reports.filter((r) => r.from === 'console.log').length >= 8,
		);
		await settle();
		return {
			mainThread,
			worker,
			workerConsole: reports.reports.filter((r) => r.from === 'console.log'),
		};
	} finally {
		await node.dispose();
		reports.close();
	}
}

/** 2. a custom `onLog` runs on the worker, instead of the default print. */
async function onLog(workerUrl: string) {
	const reports = listen('on-log');
	const node = await openWorkerNode(workerUrl, 'on-log');
	try {
		const c = client(node);
		const address = await c.deploy();
		await c.call(address, c.peek());
		await waitFor(
			() => reports.reports.filter((r) => r.from === 'onLog').length >= 2,
		);
		await settle();
		return reports.reports;
	} finally {
		await node.dispose();
		reports.close();
	}
}

/** 3. a worker node without console logging refuses, synchronously. */
async function without(workerUrl: string) {
	const node = await openWorkerNode(workerUrl, 'none');
	try {
		let threw = 'DID NOT THROW';
		let returned: unknown;
		try {
			returned = node.onConsoleLog(() => {});
		} catch (e) {
			threw = String((e as Error)?.message ?? e);
		}
		return {threw, returnedSomething: returned !== undefined};
	} finally {
		await node.dispose();
	}
}

/** 4. a `createNode` factory, with `createConsoleLog` and by itself. */
async function factory(workerUrl: string, mode: string) {
	const reports = listen(mode);
	const node = await openWorkerNode(workerUrl, mode);
	try {
		const got: PlainEntry[] = [];
		let threw = 'DID NOT THROW';
		try {
			node.onConsoleLog((e) => got.push(plain(e)));
		} catch (e) {
			threw = String((e as Error)?.message ?? e);
		}
		await settle();
		const c = client(node);
		const address = await c.deploy();
		await c.call(address, c.peek());
		await waitFor(() => got.length >= 2);
		return {
			threw,
			messages: got.map((e) => `${e.source} ${e.message}`),
			factory: reports.reports.filter((r) => r.from === 'factory'),
		};
	} finally {
		await node.dispose();
		reports.close();
	}
}

/** 6. the client refuses `consoleLog` before posting anything to the worker. */
async function clientRefusal() {
	let posted = 0;
	const fakeWorker = {
		postMessage: () => {
			posted++;
		},
		addEventListener: () => {},
		removeEventListener: () => {},
		terminate: () => {},
	} as unknown as Worker;
	let outcome = 'DID NOT REJECT';
	try {
		await createWorkerNode({
			worker: fakeWorker,
			chainId: CHAIN_ID,
			consoleLog: consoleLog() as never,
		});
	} catch (e) {
		outcome = `REJECTED ${String((e as Error)?.message ?? e)}`;
	}
	return {outcome, posted};
}

export async function runWorkerConsoleLogChecks(workerUrl: string) {
	return {
		delivered: await delivered(workerUrl),
		onLog: await onLog(workerUrl),
		without: await without(workerUrl),
		factoryReceives: await factory(workerUrl, 'factory-receives'),
		factoryEnables: await factory(workerUrl, 'factory-enables'),
		notAFunction: await driveMisusedEngineWorker(
			withMode(workerUrl, 'not-a-function'),
		),
		early: reportHostOptionsEarlySignal({createConsoleLog: consoleLog()}),
		throws: await driveMisusedEngineWorker(withMode(workerUrl, 'throws')),
		clientRefusal: await clientRefusal(),
	};
}
