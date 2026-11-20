/**
 * cheat.spec.ts: the core's cheats and snapshots reach the node through a dev
 * node untouched (the `hardhat_` / `anvil_` state cheats, the mining methods,
 * `evm_snapshot` / `evm_revert`), run IN NODE, in a real browser page, and on
 * revm, against the same assertions (cheat-expected.ts). Its own file, so
 * nothing else in the package waits on the core having these methods.
 */
import {test, expect} from '@playwright/test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertCheats} from './cheat-expected.js';
import {runCheatChecks} from './helpers/cheat-checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const cutRevm = resolve(here, './helpers/cut-revm.ts');
const webevmEntry = createRequire(import.meta.url).resolve('webevm');
const revmWasm = createRequire(webevmEntry).resolve('revm-wasm/revm.wasm');

test('the core cheats and snapshots through a dev node (Node)', async ({}, testInfo) => {
	// No page: this runs in the test runner's own Node process, once.
	test.skip(
		testInfo.project.name !== 'chromium',
		'Node run: the browser project does not matter, so it runs once',
	);
	assertCheats(await runCheatChecks(undefined), '@ethereumjs/evm');
});

test('the core cheats and snapshots through a dev node (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'cheats'}});
	console.log('\n[cheats] errors:', r.errors);
	expect(r.errors).toEqual([]);
	assertCheats(r.results.cheats as Record<string, any>, '@ethereumjs/evm');
	await h.dispose();
});

test('the core cheats and snapshots through a dev node (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut: cutRevm,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {
			loader: {'.wasm': 'binary'},
			alias: {'revm-wasm/revm.wasm': revmWasm},
		},
	});
	const r = await h.run({phase: 'once', params: {mode: 'cheats'}});
	console.log('\n[revm-cheats] errors:', r.errors);
	expect(r.errors).toEqual([]);
	assertCheats(r.results.cheats as Record<string, any>, 'revm-wasm');
	await h.dispose();
});
