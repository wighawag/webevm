/**
 * state-history-transports.spec.ts: `stateHistory` passes through the Worker
 * transport like every other option, and historical reads (the four point
 * reads, `eth_call` and `eth_estimateGas`, served in the window and refused
 * beyond it) answer the same through a worker-hosted node and over a port handed
 * to `node.serveOn(port)` as through the main-thread node's `request`, on the
 * same chain. The driver is ./helpers/state-history-transports.ts; the worker
 * module is the serve-on-port one (it exposes both the node api and the
 * consumer api), for the reason ./serve-on-port.spec.ts gives.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const worker = resolve(here, './helpers/serve-on-port-worker.ts');

test('historical reads answer the same through a Worker and over serveOn ports as through node.request', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'state-history-transports', workerUrl},
	});

	console.log('\n[state-history-transports] errors:', r.errors);
	const t = r.results.transports as any;
	console.log('[state-history-transports]', JSON.stringify(t, null, 2));
	expect(r.errors).toEqual([]);

	// The worker-hosted node ran the same chain to the same state.
	expect(t.sameState).toBe(true);
	// THE PROPERTY: every answer, served or refused, is the reference's.
	expect(t.mismatchCount).toEqual({
		worker: 0,
		workerPort: 0,
		mainThreadPort: 0,
	});

	// Not vacuous: the chain is longer than the window, so blocks were both
	// served and refused, the refusal is the window's (it names the oldest
	// servable block and the option), and the served history is not the head.
	expect(t.head).toBeGreaterThan(t.window + 1);
	expect(t.served).toBeGreaterThan(1000);
	expect(t.refused).toBeGreaterThan(100);
	expect(String(t.beyondWindowRefusal)).toContain(
		'historical state not available',
	);
	expect(String(t.beyondWindowRefusal)).toContain(
		`oldest block whose state this node holds is block ${t.head - t.window}`,
	);
	expect(String(t.beyondWindowRefusal)).toContain(
		`stateHistory: {blocks: ${t.window}}`,
	);
	expect(t.historicalBlocksThatDiffer).toBeGreaterThanOrEqual(t.window - 1);

	await h.dispose();
});
