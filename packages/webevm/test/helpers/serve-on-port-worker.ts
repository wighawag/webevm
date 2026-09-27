/**
 * serve-on-port-worker.ts: ONE worker module playing BOTH parts of the
 * worker-to-worker case, because a harness serves one worker entry point. The
 * page starts it twice:
 *
 *   - as the NODE worker, driven by the ordinary `createWorkerNode()` client
 *     (the `createNode` half below is exactly what `webevm/worker-entry` exposes);
 *   - as the CONSUMER worker (standing in for an indexer running in another
 *     worker), which is handed the other end of a `MessageChannel` and turns it
 *     back into a provider with `providerOverPort`, as a consumer would.
 *
 * The consumer half is driven from the page over comlink only to START and READ
 * it: the requests it makes go over the handed port, straight to whichever thread
 * serves the node. That is what the page-blocking check in ./serve-on-port.ts
 * relies on.
 */
import {expose} from 'comlink';
import {providerOverPort} from '@eip-1193/over-port';
import {createNodeWorkerApi} from '../../src/worker-host.js';

type Provider = ReturnType<typeof providerOverPort>;

/** One answer, as the page reads it back (plain values only: it is cloned). */
export type ConsumerAnswer =
	| {outcome: 'ANSWERED'; result: unknown}
	| {outcome: 'REJECTED'; code: unknown; message: string}
	| {outcome: 'NO_ANSWER'};

const providers = new Map<string, Provider>();
let loop: {stop: boolean; answeredAt: number[]; results: unknown[]} | undefined;
let loopDone: Promise<void> | undefined;

function providerFor(id: string): Provider {
	const provider = providers.get(id);
	if (!provider) throw new Error(`no provider attached as ${id}`);
	return provider;
}

const consumerApi = {
	/** Take one end of a channel and make it a provider, as a consumer would. */
	attach(id: string, port: MessagePort) {
		providers.set(id, providerOverPort(port));
	},
	/**
	 * One request over the port. `NO_ANSWER` means nothing came back within the
	 * budget: what a port whose server was stopped does, since a stopped server
	 * answers nothing (it is not an error on the serving side).
	 */
	async ask(
		id: string,
		args: {method: string; params?: unknown[]},
		budgetMs = 2_000,
	): Promise<ConsumerAnswer> {
		const answer: Promise<ConsumerAnswer> = providerFor(id)
			.request(args as never)
			.then(
				(result) => ({outcome: 'ANSWERED', result}) as const,
				(e: {code?: unknown; message?: string}) =>
					({
						outcome: 'REJECTED',
						code: e?.code,
						message: String(e?.message),
					}) as const,
			);
		const silence = new Promise<ConsumerAnswer>((resolve) =>
			setTimeout(() => resolve({outcome: 'NO_ANSWER'}), budgetMs),
		);
		return Promise.race([answer, silence]);
	},
	/**
	 * Start asking `eth_chainId` back to back, stamping each answer with the wall
	 * clock (`Date.now()`, the one clock two threads share), until stopped.
	 */
	startLoop(id: string) {
		const provider = providerFor(id);
		const state = {
			stop: false,
			answeredAt: [] as number[],
			results: [] as unknown[],
		};
		loop = state;
		loopDone = (async () => {
			while (!state.stop) {
				state.results.push(await provider.request({method: 'eth_chainId'}));
				state.answeredAt.push(Date.now());
			}
		})();
	},
	async stopLoop() {
		if (!loop) throw new Error('no loop running');
		loop.stop = true;
		await loopDone;
		return {answeredAt: loop.answeredAt, results: loop.results};
	},
};

export type ConsumerApi = typeof consumerApi;

expose({...createNodeWorkerApi(), ...consumerApi});
