/**
 * revm-genesis-timestamp.spec.ts: the genesisTimestamp battery with the revm
 * engine installed. What revm adds is the EXECUTION half: its `TIMESTAMP` at
 * block 0 must read the pinned value, at the head and pinned below it; the
 * contract is the default engine's (genesis-timestamp-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertGenesisTimestamp} from './genesis-timestamp-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('genesisTimestamp pins block 0 and only block 0 (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'genesis-timestamp'}});

	console.log('\n[revm-genesis-timestamp] errors:', r.errors);
	const c = r.results.revmGenesisTimestamp as Record<string, any>;
	console.log('[revm-genesis-timestamp]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.pinned.engineId).toBe('revm-wasm');
	assertGenesisTimestamp(c, 'revm');

	await h.dispose();
});
