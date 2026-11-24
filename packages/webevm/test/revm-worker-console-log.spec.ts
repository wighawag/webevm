/**
 * revm-worker-console-log.spec.ts: console logging on a revm-backed WORKER
 * node. The worker module (helpers/revm-console-log-worker.ts) passes both
 * worker-module options, `exposeNode({createEngine: () =>
 * createRevmEngine({wasm}), createConsoleLog: () => consoleLog()})`, and a
 * main-thread subscriber on the `createWorkerNode()` proxy receives the
 * entries, field for field what a main-thread revm node delivers, held to the
 * same assertions as the default engine's worker case
 * (./worker-console-log-expected.ts).
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertWorkerDelivered} from './worker-console-log-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');
const workerEntry = resolve(here, './helpers/revm-console-log-worker.ts');

test('console logging in a Worker on revm: createEngine and createConsoleLog together, observed from the main thread', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: workerEntry,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'revm-worker-console-log', workerUrl},
	});
	console.log('\n[revm-worker-console-log] errors:', r.errors);
	const c = r.results.revmWorkerConsoleLog as Record<string, any>;
	console.log('[revm-worker-console-log]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	// Both nodes really ran on revm, not silently on the default engine.
	expect(c.delivered.referenceEngineId).toBe('revm-wasm');
	expect(c.delivered.workerEngineId).toBe('revm-wasm');
	assertWorkerDelivered(c.delivered);

	await h.dispose();
});
