/**
 * revm-state-cheat-aliases.spec.ts: the state-cheat-alias battery with the revm
 * engine installed. What revm adds is the EXECUTION half: the transaction and
 * the call that read the cheated state run on revm; the contract is the
 * default engine's (state-cheat-aliases-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateCheatAliases} from './state-cheat-aliases-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('hardhat_* and anvil_* state cheats (revm)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'state-cheat-aliases'}});

	console.log('\n[revm-state-cheat-aliases] errors:', r.errors);
	const c = r.results.revmStateCheatAliases as Record<string, any>;
	console.log('[revm-state-cheat-aliases]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.sameEffect.evm.engineId).toBe('revm-wasm');
	assertStateCheatAliases(c, 'revm');

	await h.dispose();
});
