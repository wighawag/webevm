/**
 * revm-snapshots.spec.ts: the snapshot battery with the revm engine installed.
 * What revm adds is the EXECUTION half: the transactions a revert undoes, and
 * the ones that continue the chain after it, run on revm against the restored
 * state (snapshots-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertSnapshots} from './snapshots-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('evm_snapshot / evm_revert (revm)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'snapshots'}});

	console.log('\n[revm-snapshots] errors:', r.errors);
	const c = r.results.revmSnapshots as Record<string, any>;
	console.log(
		'[revm-snapshots]',
		JSON.stringify(c ?? null, null, 2).slice(0, 4000),
	);
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.restore.engineId).toBe('revm-wasm');
	assertSnapshots(c, 'revm');

	await h.dispose();
});
