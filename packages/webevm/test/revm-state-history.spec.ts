/**
 * revm-state-history.spec.ts: the state-history battery with the revm engine
 * installed. revm writes the node's state through the synchronous by-key writers
 * of src/state-manager.ts, so whether history reconstructs what it wrote is a
 * question for this engine separately; the contract is the default engine's
 * (state-history-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateHistory} from './state-history-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('point reads at any block in the stateHistory window answer as that block did (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-history'}});

	console.log('\n[revm-state-history] errors:', r.errors);
	const c = r.results.revmStateHistory as Record<string, any>;
	console.log('[revm-state-history]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.differential.engineId).toBe('revm-wasm');
	assertStateHistory(c, 'revm');

	await h.dispose();
});
