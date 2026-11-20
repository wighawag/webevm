/**
 * revm-dev-node.spec.ts: the dev-node battery with every node on the revm
 * engine (`webevm/revm`), held to the same assertions (dev-node-expected.ts).
 *
 * WHERE THE WASM COMES FROM: the copy of `revm-wasm` that webevm itself
 * depends on, resolved through webevm's own entry and aliased for esbuild. So
 * this package needs no `revm-wasm` dependency of its own, and the bytes are
 * always the ones `webevm/revm` was built against.
 */
import {test, expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertDevNode} from './dev-node-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');
const webevmEntry = createRequire(import.meta.url).resolve('webevm');
const revmWasm = createRequire(webevmEntry).resolve('revm-wasm/revm.wasm');

test('dev accounts, funded at genesis, everything else forwarded (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {
			loader: {'.wasm': 'binary'},
			alias: {'revm-wasm/revm.wasm': revmWasm},
		},
	});
	const r = await h.run({phase: 'once', params: {mode: 'dev-node'}});

	console.log('\n[revm-dev-node] errors:', r.errors);
	const c = r.results.devNode as Record<string, any>;
	console.log(
		'[revm-dev-node]',
		JSON.stringify(c ?? null, null, 2).slice(0, 4000),
	);
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	assertDevNode(c, 'revm-wasm');

	await h.dispose();
});
