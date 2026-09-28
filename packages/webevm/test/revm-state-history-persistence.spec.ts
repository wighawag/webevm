/**
 * revm-state-history-persistence.spec.ts: the state-history-persistence battery
 * with the revm engine installed. The history a revm node records came through
 * the synchronous by-key writers, and a loaded one is replayed to revm through a
 * historical call's checkpoint, so whether it crosses a dump intact is a
 * question for this engine separately; the contract is the default engine's
 * (state-history-persistence-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateHistoryPersistence} from './state-history-persistence-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('the stateHistory window survives dumpState / loadState (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'state-history-persistence'},
	});

	console.log('\n[revm-state-history-persistence] errors:', r.errors);
	const c = r.results.revmStateHistoryPersistence as Record<string, any>;
	console.log('[revm-state-history-persistence]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.roundTrip.engineId).toBe('revm-wasm');
	assertStateHistoryPersistence(c, 'revm');

	await h.dispose();
});
