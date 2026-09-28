/**
 * revm-rpc-params.spec.ts: `eth_call` / `eth_estimateGas` state overrides on the
 * revm engine. revm reads the node's state stacks directly and opens no
 * checkpoint of its own, so it must SEE the level the node pushes for the
 * overrides, and that level must be gone afterwards. Same assertions as the
 * default engine (rpc-params-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateOverrides} from './rpc-params-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('state overrides are seen and then gone (revm)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'rpc-params'}});

	console.log('\n[revm-rpc-params] errors:', r.errors);
	const c = r.results.revmRpcParams as Record<string, any>;
	console.log('[revm-rpc-params]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	assertStateOverrides(c, 'revm');

	await h.dispose();
});
