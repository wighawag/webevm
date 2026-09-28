/**
 * state-history-transports.ts: runs in the browser PAGE. Proves that
 * `stateHistory` needs nothing from the transports: the option passes through
 * `createWorkerNode` (and so through `exposeNode`'s `createNodeWorkerApi`, which
 * is what the worker module below exposes) like every other option, and the
 * historical reads a node answers through `node.request` are answered the same
 * through a worker-hosted node and over a port handed to `node.serveOn(port)`.
 *
 * FOUR TRANSPORTS, ONE CHAIN. The change-set chain (./change-set.ts, the write
 * routes the history batteries are proven against) is driven twice with the
 * same options: on a main-thread node (the REFERENCE, asked through
 * `node.request`) and on a worker-hosted node. The two are asserted to end in
 * the same state (`stateOfDump` of their `dumpState`s: state, history and block
 * count, not the wall-clock-dependent block hashes). Then every question is asked at every block K from 0 to
 * the head of:
 *
 *   - `reference`: the main-thread node's `request`;
 *   - `worker`: the worker-hosted node's `request` (comlink);
 *   - `workerPort`: a port the worker-hosted node serves, read by a consumer in
 *     ANOTHER worker through `providerOverPort` (worker to worker, the indexer
 *     case);
 *   - `mainThreadPort`: a port the main-thread reference node serves, read by the
 *     same consumer.
 *
 * THE QUESTIONS: the four point reads of every key the chain touches, the same
 * keys read BY EXECUTION (`eth_call`, ./historical-call.ts's `executeAll`), and
 * an `eth_estimateGas` of a call to every address, at every K by number and by
 * EIP-1898 `{blockHash}`. The window is deliberately SMALLER than the chain, so
 * the refusal beyond it is among the answers compared: a worker node that never
 * received `stateHistory` would refuse every block below the head with a
 * different message, and one that received a different window would refuse a
 * different set of blocks. Refusals are compared by code and message.
 *
 * Non-vacuity is reported alongside: how many answers were served and refused,
 * and how many blocks in the window answer differently from the head.
 */
import {wrap, transfer, type Remote} from 'comlink';
import {createNode} from '../../src/node.js';
import {createWorkerNode} from '../../src/worker-client.js';
import type {SlimNode} from '../../src/types.js';
import {
	chainNodeOptions,
	runChangeSetChain,
	SENDER,
	word,
} from './change-set.js';
import {keysOfDump, readAll, stateOfDump} from './state-history.js';
import {executeAll, READER} from './historical-call.js';
import type {ConsumerApi} from './serve-on-port-worker.js';

/** Smaller than the chain (10 blocks), so some blocks are beyond it. */
const WINDOW = 4;
/** Generous: one answer, even an `eth_estimateGas` search, is milliseconds. */
const ANSWER_BUDGET_MS = 10_000;

type Transport = 'reference' | 'worker' | 'workerPort' | 'mainThreadPort';

/**
 * A `request`-only node reading over the port the consumer attached as `id`, so
 * the same readers drive it. A rejection is re-thrown with its code and message,
 * as `providerOverPort` delivered them.
 */
function overPort(consumer: Remote<ConsumerApi>, id: string): SlimNode {
	return {
		async request(args: {method: string; params?: unknown[]}) {
			const a = await consumer.ask(id, args, ANSWER_BUDGET_MS);
			if (a.outcome === 'ANSWERED') return a.result;
			if (a.outcome === 'REJECTED')
				throw Object.assign(new Error(a.message), {code: a.code});
			throw new Error(`no answer over port ${id} to ${args.method}`);
		},
	} as unknown as SlimNode;
}

/** Every answer (or refusal, by code and message) at `block`, keyed. */
async function askAll(
	node: SlimNode,
	addresses: string[],
	slots: string[],
	block: unknown,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {
		...(await readAll(node, addresses, slots, block)),
		...(await executeAll(node, addresses, slots, block)),
	};
	for (const a of addresses) {
		try {
			out[`estimate ${a}`] = await node.request({
				method: 'eth_estimateGas',
				params: [{from: SENDER, to: a}, block],
			});
		} catch (e: any) {
			out[`estimate ${a}`] = `ERROR ${e?.code} ${String(e?.message ?? e)}`;
		}
	}
	return out;
}

export interface StateHistoryTransportsReport {
	head: number;
	window: number;
	/** The worker-hosted node ran the chain to the same state as the reference. */
	sameState: boolean;
	/** Questions asked per transport (every K, both ways of naming it). */
	questions: number;
	/** Reference answers that were served / refused, over all K. */
	served: number;
	refused: number;
	/** Blocks in the window, below the head, whose answers differ from the head's. */
	historicalBlocksThatDiffer: number;
	/** The reference's refusal of the first block beyond the window. */
	beyondWindowRefusal: unknown;
	/** Answers that differ from the reference, per transport (first few). */
	mismatches: Record<Exclude<Transport, 'reference'>, string[]>;
	mismatchCount: Record<Exclude<Transport, 'reference'>, number>;
}

export async function runStateHistoryTransportChecks(
	workerUrl: string,
): Promise<StateHistoryTransportsReport> {
	// No engine: the default engine is the only one that crosses `createWorkerNode`
	// (a worker that builds its own passes it through `exposeNode`, which forwards
	// the same options object to the same `createNode`).
	const {engine: _none, ...options} = await chainNodeOptions(undefined, {
		stateHistory: {blocks: WINDOW},
	});

	// ---- the reference, on the main thread, collecting the key universe ----
	const reference = await createNode(options);
	const addressSet = new Set<string>();
	const slotSet = new Set<string>();
	keysOfDump(await reference.dumpState(), addressSet, slotSet);
	const chain = await runChangeSetChain(reference, async () => {
		keysOfDump(await reference.dumpState(), addressSet, slotSet);
	});
	for (const a of chain.addresses) addressSet.add(a.toLowerCase());
	for (const a of addressSet) slotSet.add(`${a}:${word(0)}`);
	// The execution reader's own address is overridden on every call.
	addressSet.delete(READER);
	const addresses = [...addressSet].sort();
	const slots = [...slotSet].sort();

	// ---- the same chain on a worker-hosted node ----
	const nodeWorker = new Worker(workerUrl, {type: 'module'});
	const worker = await createWorkerNode({worker: nodeWorker, ...options});
	const consumerWorker = new Worker(workerUrl, {type: 'module'});
	const consumer = wrap<ConsumerApi>(consumerWorker);
	try {
		await runChangeSetChain(worker, async () => {});
		// The STATE, history and block count, not the whole dump: genesis is
		// stamped with the wall clock in whole seconds, so two nodes created
		// either side of a second boundary hash every block differently while
		// holding identical state (see `stateOfDump`). Comparing whole dumps made
		// this fail about one run in four.
		const sameState =
			stateOfDump(await worker.dumpState()) ===
			stateOfDump(await reference.dumpState());

		// ---- ports: one served by each node, read by the consumer worker ----
		const handOff = async (node: SlimNode, id: string) => {
			const {port1, port2} = new MessageChannel();
			await node.serveOn(port1);
			await consumer.attach(id, transfer(port2, [port2]));
		};
		await handOff(worker, 'worker');
		await handOff(reference, 'main');
		const transports: Record<Transport, SlimNode> = {
			reference,
			worker,
			workerPort: overPort(consumer, 'worker'),
			mainThreadPort: overPort(consumer, 'main'),
		};

		const head = Number(
			BigInt(String(await reference.request({method: 'eth_blockNumber'}))),
		);
		const mismatches = {
			worker: [] as string[],
			workerPort: [] as string[],
			mainThreadPort: [] as string[],
		};
		let questions = 0;
		let served = 0;
		let refused = 0;
		const atHead = new Map<string, Record<string, unknown>>();
		const byK = new Map<number, Record<string, unknown>>();
		// Each node's OWN hash for block k: genesis is stamped with the wall clock,
		// so two nodes running the same chain have different block hashes.
		const hashOf = async (node: SlimNode, k: number) =>
			(
				(await node.request({
					method: 'eth_getBlockByNumber',
					params: ['0x' + k.toString(16), false],
				})) as {hash: string}
			).hash;
		const refsOf = async (node: SlimNode, k: number) => ({
			number: '0x' + k.toString(16),
			blockHash: {blockHash: await hashOf(node, k)},
		});
		for (let k = head; k >= 0; k--) {
			const expectedRefs = await refsOf(reference, k);
			for (const [name, ref] of Object.entries(expectedRefs)) {
				const expected = await askAll(reference, addresses, slots, ref);
				if (k === head) atHead.set(name, expected);
				if (name === 'number') byK.set(k, expected);
				for (const v of Object.values(expected)) {
					questions++;
					if (String(v).startsWith('ERROR')) refused++;
					else served++;
				}
				for (const t of ['worker', 'workerPort', 'mainThreadPort'] as const) {
					const refs = await refsOf(transports[t], k);
					const got = await askAll(
						transports[t],
						addresses,
						slots,
						refs[name as keyof typeof refs],
					);
					for (const key of Object.keys(expected)) {
						const e = expected[key];
						const g = got[key];
						if (e !== g)
							mismatches[t].push(
								`block ${k} by ${name}: ${key}: expected ${e}, got ${g}`,
							);
					}
				}
			}
		}

		// Non-vacuity: blocks in the window that really differ from the head.
		const headAnswers = JSON.stringify(atHead.get('number'));
		let historicalBlocksThatDiffer = 0;
		for (let k = head - WINDOW; k < head; k++)
			if (JSON.stringify(byK.get(k)) !== headAnswers)
				historicalBlocksThatDiffer++;
		const beyondWindowRefusal = byK.get(head - WINDOW - 1)?.[
			`balance ${SENDER.toLowerCase()}`
		];

		return {
			head,
			window: WINDOW,
			sameState,
			questions,
			served,
			refused,
			historicalBlocksThatDiffer,
			beyondWindowRefusal,
			mismatches: {
				worker: mismatches.worker.slice(0, 20),
				workerPort: mismatches.workerPort.slice(0, 20),
				mainThreadPort: mismatches.mainThreadPort.slice(0, 20),
			},
			mismatchCount: {
				worker: mismatches.worker.length,
				workerPort: mismatches.workerPort.length,
				mainThreadPort: mismatches.mainThreadPort.length,
			},
		};
	} finally {
		consumerWorker.terminate();
		await worker.dispose();
		await reference.dispose();
	}
}
