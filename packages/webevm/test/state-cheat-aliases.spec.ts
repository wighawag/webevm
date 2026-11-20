/**
 * state-cheat-aliases.spec.ts: the state cheats under Hardhat's and anvil's
 * names, on the default engine. The battery is helpers/state-cheat-aliases.ts;
 * the revm half is revm-state-cheat-aliases.spec.ts, held to the same
 * assertions (state-cheat-aliases-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateCheatAliases} from './state-cheat-aliases-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('hardhat_* and anvil_* state cheats (default engine)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-cheat-aliases'}});

	console.log('\n[state-cheat-aliases] errors:', r.errors);
	const c = r.results.stateCheatAliases as Record<string, any>;
	console.log('[state-cheat-aliases]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	expect(c.sameEffect.evm.engineId).toBe('@ethereumjs/evm');
	assertStateCheatAliases(c, '@ethereumjs/evm');

	await h.dispose();
});
