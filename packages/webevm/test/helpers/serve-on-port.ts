/**
 * serve-on-port.ts: runs in the browser PAGE. Proves a node can SERVE its
 * EIP-1193 `request` on a `MessagePort` it is handed (`node.serveOn(port)`), so
 * a consumer in ANOTHER worker talks to it directly with `@eip-1193/over-port`'s
 * `providerOverPort`, and the page relays nothing.
 *
 * The same battery runs against BOTH kinds of node, because the point of the
 * call being on `SlimNode` is that they stay interchangeable:
 *   - a worker-hosted node (`createWorkerNode`), where the port is TRANSFERRED
 *     into the node's worker;
 *   - a main-thread node (`createNode`), where it is served in place.
 *
 * The consumer is always a separate Worker (./serve-on-port-worker.ts), standing
 * in for the indexer this exists for.
 *
 * "NO REQUEST PASSES THROUGH THE PAGE" IS MEASURED TWO WAYS, on the worker-hosted
 * node (a main-thread node IS the page, so neither question applies to it):
 *
 *   - PAGE TRAFFIC, on every engine. After the hand-off the consumer asks back to
 *     back, and every message crossing the page's own handles on the two workers
 *     is counted. A relay, in page code or as a comlink hop through the page,
 *     would be messages there; the bar is zero, alongside answers in the window.
 *   - A BLOCKED PAGE, the stronger form where it holds. The page's thread
 *     busy-waits with no event loop turn at all, and answers stamped INSIDE that
 *     window prove the page's thread was not needed. It holds on Chromium. It
 *     does NOT hold on WebKit, which routes MessagePort traffic between workers
 *     through the main thread inside the engine (measured: zero answers during
 *     the block, all of them the moment it ends), so there it is reported, not
 *     asserted. No page CODE is involved either way; that is what the first check
 *     pins.
 */
import {wrap, transfer, type Remote} from 'comlink';
import {createWorkerNode} from '../../src/worker-client.js';
import {createNode} from '../../src/node.js';
import type {SlimNode} from '../../src/types.js';
import type {ConsumerApi, ConsumerAnswer} from './serve-on-port-worker.js';

const CHAIN_ID = 31337;
/** How long the consumer asks while the page's thread is free but watching. */
const PAGE_FREE_MS = 500;
/** How long the page holds its thread while the consumer asks. */
const PAGE_BLOCK_MS = 1_000;

export interface ServeOnPortReport {
	/** What the consumer got back for `eth_chainId` over the first port. */
	firstAnswer: ConsumerAnswer;
	/** An unsupported method, asked over the port. */
	unsupported: ConsumerAnswer;
	/** Two ports served at once: both answer. */
	twoPorts: {first: ConsumerAnswer; second: ConsumerAnswer};
	/** After the SECOND port's server is stopped: it is silent, the first is not. */
	afterStop: {stopped: ConsumerAnswer; stillServed: ConsumerAnswer};
}

export interface WorkerReport extends ServeOnPortReport {
	/**
	 * Messages that crossed the page's handles on EITHER worker while the
	 * consumer was being answered: zero means the page relayed nothing.
	 */
	pageMessagesWhileServing: number;
	/** Messages the same counters saw BEFORE that window (the counters' control). */
	pageMessagesBefore: number;
	/** Answers the consumer got in that same window. */
	answeredWhilePageFree: number;
	/**
	 * Answers the consumer got while the page's thread was BLOCKED. Engine
	 * dependent, and reported rather than asserted everywhere: Chromium carries
	 * worker-to-worker port traffic without the page's thread, WebKit routes it
	 * through the main thread inside the engine (measured: zero), so a busy page
	 * stalls it there even though no page code touches it.
	 */
	answeredWhilePageBlocked: number;
	/** Every loop answer was the chain id (none was a stray value). */
	loopResults: unknown[];
}

export interface MainThreadReport extends ServeOnPortReport {
	/** A port served before `dispose()` is silent after it. */
	afterDispose: ConsumerAnswer;
}

function startConsumer(workerUrl: string): {
	worker: Worker;
	api: Remote<ConsumerApi>;
	traffic: PageTraffic;
} {
	const worker = new Worker(workerUrl, {type: 'module'});
	// Counted BEFORE comlink listens: see `countPageTraffic`.
	const traffic = countPageTraffic(worker);
	return {worker, api: wrap<ConsumerApi>(worker), traffic};
}

/** Hand one end of a fresh channel to `node`, the other to the consumer as `id`. */
async function handOff(
	node: SlimNode,
	consumer: Remote<ConsumerApi>,
	id: string,
) {
	const {port1, port2} = new MessageChannel();
	const served = await node.serveOn(port1);
	await consumer.attach(id, transfer(port2, [port2]));
	return served;
}

/** The part of the battery both kinds of node answer identically. */
async function battery(
	node: SlimNode,
	consumer: Remote<ConsumerApi>,
): Promise<ServeOnPortReport> {
	await handOff(node, consumer, 'a');
	const firstAnswer = await consumer.ask('a', {method: 'eth_chainId'});
	const unsupported = await consumer.ask('a', {method: 'eth_notAMethod'});

	const second = await handOff(node, consumer, 'b');
	const twoPorts = {
		first: await consumer.ask('a', {method: 'eth_blockNumber'}),
		second: await consumer.ask('b', {method: 'eth_blockNumber'}),
	};

	await second.close();
	const afterStop = {
		stopped: await consumer.ask('b', {method: 'eth_chainId'}, 500),
		stillServed: await consumer.ask('a', {method: 'eth_chainId'}),
	};
	return {firstAnswer, unsupported, twoPorts, afterStop};
}

type PageTraffic = {toPage: number; fromPage: number};

/**
 * Count every message crossing the page's own handle on `worker`, both ways.
 * Comlink's listener is left in place; this one only counts.
 *
 * REGISTER IT BEFORE COMLINK'S LISTENER, or the count lags by one: a microtask
 * checkpoint runs after EACH listener, so the awaited reply comlink resolves has
 * already been acted on (a snapshot taken) before a later listener counts it.
 */
function countPageTraffic(worker: Worker): PageTraffic {
	const count = {toPage: 0, fromPage: 0};
	worker.addEventListener('message', () => count.toPage++);
	const post = worker.postMessage.bind(worker) as (...a: unknown[]) => void;
	worker.postMessage = ((...a: unknown[]) => {
		count.fromPage++;
		post(...a);
	}) as Worker['postMessage'];
	return count;
}

export async function serveOnPortFromWorker(
	workerUrl: string,
): Promise<WorkerReport> {
	const nodeWorker = new Worker(workerUrl, {type: 'module'});
	const nodeTraffic = countPageTraffic(nodeWorker);
	const node = await createWorkerNode({worker: nodeWorker, chainId: CHAIN_ID});
	const consumer = startConsumer(workerUrl);
	const consumerTraffic = consumer.traffic;
	try {
		const report = await battery(node, consumer.api);

		await handOff(node, consumer.api, 'loop');
		await consumer.api.startLoop('loop');

		// THE PAGE-TRAFFIC CHECK, on every engine: the page's thread is FREE, and
		// not one message crosses its handles on either worker while the consumer
		// is being answered. A relay (in page code, or a comlink hop) would be
		// messages here.
		const before = {...nodeTraffic};
		const beforeConsumer = {...consumerTraffic};
		const freeFrom = Date.now();
		await new Promise((resolve) => setTimeout(resolve, PAGE_FREE_MS));
		const freeUntil = Date.now();
		const pageMessagesWhileServing =
			nodeTraffic.toPage -
			before.toPage +
			(nodeTraffic.fromPage - before.fromPage) +
			(consumerTraffic.toPage - beforeConsumer.toPage) +
			(consumerTraffic.fromPage - beforeConsumer.fromPage);

		// THE PAGE-BLOCKING CHECK: the page's thread held in a busy loop, with no
		// event loop turn at all. Stronger than the check above where it holds, and
		// it does NOT hold on every engine: see `answeredWhilePageBlocked`.
		const blockedFrom = Date.now();
		while (Date.now() - blockedFrom < PAGE_BLOCK_MS) {
			// busy-wait: no event loop turn, so nothing can be relayed from here
		}
		const blockedUntil = Date.now();
		const {answeredAt, results} = await consumer.api.stopLoop();
		const within = (from: number, until: number) =>
			answeredAt.filter((t) => t > from && t < until).length;
		return {
			...report,
			pageMessagesWhileServing,
			// The counter's own control: it DID see the comlink traffic of the
			// battery before that window, so a zero inside it is not a deaf counter.
			pageMessagesBefore:
				before.toPage +
				before.fromPage +
				beforeConsumer.toPage +
				beforeConsumer.fromPage,
			answeredWhilePageFree: within(freeFrom, freeUntil),
			answeredWhilePageBlocked: within(blockedFrom, blockedUntil),
			loopResults: [...new Set(results)],
		};
	} finally {
		consumer.worker.terminate();
		await node.dispose();
	}
}

export async function serveOnPortFromMainThread(
	workerUrl: string,
): Promise<MainThreadReport> {
	const node = await createNode({chainId: CHAIN_ID});
	const consumer = startConsumer(workerUrl);
	try {
		const report = await battery(node, consumer.api);
		await handOff(node, consumer.api, 'disposed');
		await node.dispose();
		const afterDispose = await consumer.api.ask(
			'disposed',
			{method: 'eth_chainId'},
			500,
		);
		return {...report, afterDispose};
	} finally {
		consumer.worker.terminate();
	}
}
