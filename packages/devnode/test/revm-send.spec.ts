/**
 * revm-send.spec.ts: the send battery with every node on the revm engine
 * (`webevm/revm`), held to the same assertions (send-expected.ts). The wasm is
 * webevm's own copy, as in revm-dev-node.spec.ts.
 */
import {test, expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertSend} from './send-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');
const webevmEntry = createRequire(import.meta.url).resolve('webevm');
const revmWasm = createRequire(webevmEntry).resolve('revm-wasm/revm.wasm');

test('eth_sendTransaction from dev accounts (revm)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {
			loader: {'.wasm': 'binary'},
			alias: {'revm-wasm/revm.wasm': revmWasm},
		},
	});
	const r = await h.run({phase: 'once', params: {mode: 'send'}});

	console.log('\n[revm-send] errors:', r.errors);
	const c = r.results.send as Record<string, any>;
	console.log('[revm-send]', JSON.stringify(c ?? null, null, 2).slice(0, 4000));
	expect(r.errors).toEqual([]);
	assertSend(c, 'revm-wasm');

	await h.dispose();
});
