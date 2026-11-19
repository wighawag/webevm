/**
 * revm-block-clock.spec.ts: the block-clock battery with the revm engine
 * installed. What revm adds is the EXECUTION half: a transaction's `TIMESTAMP`
 * must read the block the clock stamped; the contract is the default engine's
 * (block-clock-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertBlockClock} from './block-clock-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('the block clock and its time cheats (revm)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'block-clock'}});

	console.log('\n[revm-block-clock] errors:', r.errors);
	const c = r.results.revmBlockClock as Record<string, any>;
	console.log('[revm-block-clock]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.next.engineId).toBe('revm-wasm');
	assertBlockClock(c, 'revm');

	await h.dispose();
});
