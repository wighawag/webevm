/**
 * worker-console-log.spec.ts: Solidity `console.log` on a WORKER-hosted node.
 * It is enabled in the worker module, `exposeNode({createConsoleLog: () =>
 * consoleLog()})`, and observed from the main thread through
 * `createWorkerNode()`'s `onConsoleLog`, which crosses comlink as `onNewHead`
 * does (ADR 0018, "In a Worker, console logging is enabled in the worker
 * module"). Driven by helpers/worker-console-log.ts against the worker module
 * helpers/console-log-worker.ts. Without the option nothing changes, which
 * `worker.spec.ts` keeps proving untouched.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const consoleLogWorker = resolve(here, './helpers/console-log-worker.ts');

test('console logging in a Worker: enabled in the worker module, observed from the main thread', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: consoleLogWorker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'worker-console-log', workerUrl},
	});
	console.log('\n[worker-console-log] errors:', r.errors);
	const c = r.results.workerConsoleLog as Record<string, any>;
	console.log('[worker-console-log]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	// ---- 1. entries over comlink, the same as on the main thread ----
	const {mainThread, worker} = c.delivered;
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
	expect(c.delivered.workerConsole).toEqual(
		worker.other.map((e: any) => ({
			from: 'console.log',
			onWorker: true,
			args: ['[webevm console.log]', e.message],
		})),
	);

	// ---- 2. a custom onLog runs on the worker, instead of the default print ----
	expect(c.onLog).toEqual([
		{
			from: 'onLog',
			onWorker: true,
			source: 'transaction',
			message: expect.stringMatching(/^deployed by 0x/),
		},
		{
			from: 'onLog',
			onWorker: true,
			source: 'eth_call',
			message: expect.stringMatching(/^peek by 0x.* count 0$/),
		},
	]);

	// ---- 3. without console logging, onConsoleLog refuses synchronously ----
	expect(c.without.threw).toMatch(/^webevm\/worker-client: onConsoleLog /);
	expect(c.without.threw).toContain('createConsoleLog');
	expect(c.without.returnedSomething).toBe(false);

	// ---- 4. a createNode factory ----
	// With createConsoleLog: it receives the very option that built.
	expect(c.factoryReceives.factory).toEqual([
		{from: 'factory', hasConsoleLog: true, isTheBuiltOne: true},
	]);
	expect(c.factoryReceives.threw).toBe('DID NOT THROW');
	// Enabling it by itself, with no createConsoleLog: entries still arrive.
	for (const key of ['factoryReceives', 'factoryEnables']) {
		expect(c[key].threw, key).toBe('DID NOT THROW');
		expect(c[key].messages, key).toEqual([
			expect.stringMatching(/^transaction deployed by 0x/),
			expect.stringMatching(/^eth_call peek by 0x.* count 0$/),
		]);
	}

	// ---- 5. misuses reject, never hang ('NEVER_SETTLED' would be the hang) ----
	expect(c.notAFunction.outcome).toBe('REJECTED');
	expect(c.notAFunction.message).toContain('webevm/worker-host');
	expect(c.notAFunction.message).toContain(
		'`createConsoleLog` must be a FUNCTION',
	);
	expect(c.notAFunction.message).toContain('an object');
	expect(c.notAFunction.message).toContain(
		'{createConsoleLog: () => consoleLog()}',
	);
	// ...said early on the worker's own thread too, without a throw.
	expect(c.early.threw).toBe('DID_NOT_THROW');
	expect(c.early.reported).toBe(c.notAFunction.message);

	expect(c.throws.outcome).toBe('REJECTED');
	expect(c.throws.message).toContain(
		'console-log-worker: this createConsoleLog throws',
	);

	// ---- 6. createWorkerNode({consoleLog}) is refused before anything is posted ----
	expect(c.clientRefusal.posted).toBe(0);
	expect(c.clientRefusal.outcome).toMatch(
		/^REJECTED webevm\/worker-client: `consoleLog` is not supported by createWorkerNode\(\)/,
	);
	expect(c.clientRefusal.outcome).toContain(
		'exposeNode({createConsoleLog: () => consoleLog()})',
	);

	await h.dispose();
});
