/**
 * worker-console-log-expected.ts: the assertions on console logging delivered
 * from a WORKER node to a main-thread subscriber (`delivered` in
 * helpers/worker-console-log.ts), shared by the default-engine spec and the
 * revm one: the same chain, the same entries over comlink, field for field
 * what a main-thread node on the same engine delivers, and the default sink
 * printing in the worker's console. It lives in its own module because
 * Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

export function assertWorkerDelivered(d: Record<string, any>) {
	// ---- 1. entries over comlink, the same as on the main thread ----
	const {mainThread, worker} = d;
	expect(mainThread.arrived).toBe(true);
	expect(worker.arrived).toBe(true);
	expect(worker.otherArrived).toBe(true);
	expect(worker.subscribed.map((e: any) => e.source)).toEqual([
		'transaction',
		'transaction',
		'transaction',
		'transaction',
		'eth_call',
	]);
	// Field for field, a transaction's hash, block and index included.
	expect(worker.subscribed).toEqual(mainThread.subscribed);
	expect(worker.subscribed[0]).toMatchObject({
		source: 'transaction',
		blockNumber: 1,
		txIndex: 0,
		txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
		blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
	});
	expect(worker.subscribed[4]).toEqual({
		args: ['peek by', expect.stringMatching(/^0x/), 'count', '1n'],
		message: expect.stringMatching(/^peek by 0x[0-9a-fA-F]{40} count 1$/),
		source: 'eth_call',
	});
	// Unsubscribe stops them; the other subscriber still gets the next ones.
	expect(worker.afterUnsubscribe).toEqual([]);
	expect(mainThread.afterUnsubscribe).toEqual([]);
	expect(worker.other).toHaveLength(8);
	expect(worker.other).toEqual(mainThread.other);

	// ...and the default sink printed each of them in the WORKER's console.
	expect(d.workerConsole).toEqual(
		worker.other.map((e: any) => ({
			from: 'console.log',
			onWorker: true,
			args: ['[webevm console.log]', e.message],
		})),
	);
}
