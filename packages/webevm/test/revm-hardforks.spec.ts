/**
 * revm-hardforks.spec.ts: the hardfork battery (helpers/hardforks.ts) with the
 * `webevm/revm` engine installed, held to the SAME literals as the default
 * engine (./hardforks-expected.ts).
 *
 * What revm adds is the half the node cannot do for it: executing each fork's
 * rules itself (charging EIP-7623's floor on a receipt, applying an EIP-7702
 * authorization list, running `CLZ` and the Osaka precompiles), against the
 * node's own state. The node's half (the refusals, the read budget, the
 * estimate's bounds and the delegations a read is run with) is above the seam
 * and identical by construction, which is what the shared literals check.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertHardforks} from './hardforks-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('hardfork: Cancun, Prague and Osaka on revm, the same numbers as the default engine', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'hardforks'}});

	console.log('\n[revm-hardforks] errors:', r.errors);
	const c = r.results.revmHardforks as Record<string, any>;
	console.log('[revm-hardforks]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.engineId).toBe('revm-wasm');
	assertHardforks(c, 'revm');

	await h.dispose();
});
