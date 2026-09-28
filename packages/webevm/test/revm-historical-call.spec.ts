/**
 * revm-historical-call.spec.ts: the historical-call battery with the revm engine
 * installed. revm reads K's state through the same checkpoint the node opens for
 * a state override, and answers BLOCKHASH through its own store, so whether a
 * call at K sees K is a question for this engine separately; the contract is the
 * default engine's (historical-call-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertHistoricalCall} from './historical-call-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('eth_call and eth_estimateGas at a block in the stateHistory window execute at that block (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'historical-call'}});

	console.log('\n[revm-historical-call] errors:', r.errors);
	const c = r.results.revmHistoricalCall as Record<string, any>;
	console.log('[revm-historical-call]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.differential.engineId).toBe('revm-wasm');
	assertHistoricalCall(c, 'revm');

	await h.dispose();
});
