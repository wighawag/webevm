/**
 * genesis-timestamp.spec.ts: `genesisTimestamp` pins block 0's timestamp, on
 * the default engine. The battery is helpers/genesis-timestamp.ts; the revm half
 * is revm-genesis-timestamp.spec.ts, held to the same assertions
 * (genesis-timestamp-expected.ts). The construction refusals and the worker
 * pass-through involve no engine and run here once; the worker module is the
 * serve-on-port one, which exposes the ordinary node api.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertGenesisTimestamp} from './genesis-timestamp-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const worker = resolve(here, './helpers/serve-on-port-worker.ts');

test('genesisTimestamp pins block 0 and only block 0 (default engine)', async ({
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
		params: {mode: 'genesis-timestamp', workerUrl},
	});

	console.log('\n[genesis-timestamp] errors:', r.errors);
	const c = r.results.genesisTimestamp as Record<string, any>;
	console.log('[genesis-timestamp]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	expect(c.battery.pinned.engineId).toBe('@ethereumjs/evm');
	assertGenesisTimestamp(c.battery, '@ethereumjs/evm');

	// Construction: absent, zero and a real date are accepted; anything that is
	// not a non-negative bigint throws, naming the option.
	const k = c.construction;
	expect(k.absent).toBe('accepted');
	expect(k.zero).toBe('accepted');
	expect(k.pinned).toBe('accepted');
	for (const [name, message] of Object.entries(k.refusals)) {
		expect(message, name).not.toBe('accepted');
		expect(message, name).toContain('genesisTimestamp');
		expect(message, name).toContain('non-negative bigint');
	}
	expect(Object.keys(k.refusals).sort()).toEqual(
		['float', 'negative', 'null', 'number', 'string'].sort(),
	);

	// The option reaches a worker-hosted node.
	expect(c.worker.genesisBlockTimestamp).toBe(c.battery.genesisT);

	await h.dispose();
});
