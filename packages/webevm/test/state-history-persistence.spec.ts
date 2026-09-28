/**
 * state-history-persistence.spec.ts: the `stateHistory` undo log survives
 * `dumpState` / `loadState` on the DEFAULT engine: a loaded node gives every
 * historical answer (point reads and `eth_call`) the writer gave, at every block
 * in the window; old dumps still load; a changed window truncates or serves
 * what the dump has; a node without the option ignores the field. The battery
 * is helpers/state-history-persistence.ts; the revm half is
 * revm-state-history-persistence.spec.ts, held to the same assertions
 * (state-history-persistence-expected.ts). The real page reload through
 * IndexedDB is persistence-reload.spec.ts's.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateHistoryPersistence} from './state-history-persistence-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('the stateHistory window survives dumpState / loadState (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'state-history-persistence'},
	});

	console.log('\n[state-history-persistence] errors:', r.errors);
	const c = r.results.stateHistoryPersistence as Record<string, any>;
	console.log('[state-history-persistence]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	expect(c.roundTrip.engineId).toBe('@ethereumjs/evm');
	assertStateHistoryPersistence(c, '@ethereumjs/evm');

	await h.dispose();
});
