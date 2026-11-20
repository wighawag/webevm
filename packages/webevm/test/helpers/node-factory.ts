/**
 * node-factory.ts: runs in the browser PAGE. Proves `exposeNode({createNode})`,
 * the worker host's optional NODE FACTORY (ADR 0017), from the side that matters:
 * the MAIN THREAD, driving the worker through the ordinary `createWorkerNode()`.
 *
 *   1. The node the factory returns IS what the main thread drives: every
 *      `SlimNode` member is called through the proxy and the factory's decorator
 *      (`./node-factory-worker.ts`) reports having been reached by each, its own
 *      `engine` value arrives, and the field-for-field parity check
 *      `./worker-roundtrip.ts` holds the default worker to finds no gap.
 *   2. The factory receives the main thread's options unchanged, and the engine
 *      `createEngine` built, merged in, when that is set.
 *   3. A factory that is not a function, and one that rejects, both REJECT the
 *      main thread's `createWorkerNode()` with their message instead of hanging
 *      it (`./engine-misuse.ts`'s budgeted drive), and the non-function one is
 *      also reported early, without a throw, on the thread it was written on.
 *
 * The worker's behaviour is chosen by its URL's `?factory=` query, one mount for
 * all of it.
 */
import {createWorkerNode} from '../../src/worker-client.js';
import type {SlimNode} from '../../src/types.js';
import type {FactoryProbe} from './node-factory-worker.js';
import {shapeGapsAgainstMainThread} from './worker-roundtrip.js';
import {
	driveMisusedEngineWorker,
	reportHostOptionsEarlySignal,
} from './engine-misuse.js';

const CHAIN_ID = 31337;
const FUNDED = '0x00000000000000000000000000000000000000f1';

function withMode(workerUrl: string, mode: string): string {
	const url = new URL(workerUrl);
	url.searchParams.set('factory', mode);
	return url.href;
}

async function openNode(workerUrl: string): Promise<{
	node: SlimNode;
	worker: Worker;
}> {
	const worker = new Worker(workerUrl, {type: 'module'});
	const node = await createWorkerNode({
		worker,
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[FUNDED]: 10n ** 18n},
	});
	return {node, worker};
}

async function probe(node: SlimNode): Promise<FactoryProbe> {
	return (await node.request({method: 'test_factoryProbe'})) as FactoryProbe;
}

/**
 * Call EVERY `SlimNode` method through the proxy (dispose last, so the probe
 * before it still has a node to answer), and read every plain field.
 */
async function driveEveryMember(node: SlimNode) {
	const chainId = await node.request({method: 'eth_chainId'});
	const balance = await node.request({
		method: 'eth_getBalance',
		params: [FUNDED, 'latest'],
	});
	await node.mine();
	const dump = await node.dumpState();
	await node.loadState(dump);
	// No state root on this node: `-32004` is an answer, and reaching it is the
	// point (the decorator records the call either way).
	let stateRoot: string;
	try {
		stateRoot = await node.getStateRoot();
	} catch (e) {
		stateRoot = `refused: ${String((e as Error)?.message ?? e)}`;
	}
	const unsubscribe = node.onNewHead(() => {});
	await unsubscribe();
	const channel = new MessageChannel();
	const served = await node.serveOn(channel.port1);
	await served.close();
	channel.port2.close();
	const beforeDispose = await probe(node);
	return {
		chainId,
		balance,
		stateRoot,
		beforeDispose,
		engineId: (await node.engine)?.id,
		senderMode: await node.senderMode,
		computeStateRoot: await node.computeStateRoot,
	};
}

export async function runNodeFactoryChecks(workerUrl: string) {
	// 1. The factory's node is the one driven, member for member.
	const decorated = await openNode(withMode(workerUrl, 'decorate'));
	const members = await driveEveryMember(decorated.node);
	const shapeGaps = await shapeGapsAgainstMainThread(decorated.node);
	await decorated.node.dispose();
	decorated.worker.terminate();

	// 2. With `createEngine` too: the factory gets the engine it built.
	const withEngine = await openNode(withMode(workerUrl, 'sees-engine'));
	const engineProbe = await probe(withEngine.node);
	await withEngine.node.dispose();
	withEngine.worker.terminate();

	// 3. The two failures reach the main thread as rejections, never as a hang.
	const notAFunction = await driveMisusedEngineWorker(
		withMode(workerUrl, 'not-a-function'),
	);
	const rejects = await driveMisusedEngineWorker(
		withMode(workerUrl, 'rejects'),
	);
	const early = reportHostOptionsEarlySignal({createNode: {notA: 'function'}});

	return {
		members,
		shapeGaps,
		withoutEngine: members.beforeDispose.received,
		withEngine: engineProbe.received,
		notAFunction,
		rejects,
		early,
	};
}
