/**
 * historical-call.spec.ts: with `stateHistory: {blocks: N}`, `eth_call` and
 * `eth_estimateGas` pinned to a block K in the window execute against K's state
 * and K's block environment, on the DEFAULT engine, and leave the head as it
 * was. The battery is helpers/historical-call.ts; the revm half is
 * revm-historical-call.spec.ts, held to the same assertions
 * (historical-call-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertHistoricalCall} from './historical-call-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('eth_call and eth_estimateGas at a block in the stateHistory window execute at that block (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'historical-call'}});

	console.log('\n[historical-call] errors:', r.errors);
	const c = r.results.historicalCall as Record<string, any>;
	console.log('[historical-call]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	expect(c.differential.engineId).toBe('@ethereumjs/evm');
	assertHistoricalCall(c, '@ethereumjs/evm');

	await h.dispose();
});
