/**
 * state-history.spec.ts: with `stateHistory: {blocks: N}`, the four point reads
 * pinned to any block in the window answer as that block's head did, on the
 * DEFAULT engine; beyond the window they are refused, naming the window and the
 * option. The battery is helpers/state-history.ts; the revm half is
 * revm-state-history.spec.ts, held to the same assertions
 * (state-history-expected.ts). The construction checks involve no engine and run
 * here once.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateHistory} from './state-history-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('point reads at any block in the stateHistory window answer as that block did (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-history'}});

	console.log('\n[state-history] errors:', r.errors);
	const c = r.results.stateHistory as Record<string, any>;
	console.log('[state-history]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	expect(c.battery.differential.engineId).toBe('@ethereumjs/evm');
	assertStateHistory(c.battery, '@ethereumjs/evm');

	// Construction: absent is off, {blocks: N} is on, anything else throws, and
	// so does combining it with stateMode:'trie'.
	const k = c.construction;
	expect(k.absent).toBe('accepted');
	expect(k.one).toBe('accepted');
	expect(k.trieWithout).toBe('accepted');
	for (const [name, message] of Object.entries(k.refusals)) {
		expect(message, name).not.toBe('accepted');
		expect(message, name).toContain('stateHistory');
		expect(message, name).toContain('positive safe integer');
	}
	expect(k.trie).toContain('stateHistory');
	expect(k.trie).toContain("stateMode:'trie'");

	await h.dispose();
});
