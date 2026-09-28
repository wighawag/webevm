/**
 * revm-change-set.spec.ts: the per-block CHANGE SET on the revm engine. revm
 * writes the node's state through the SYNCHRONOUS by-key writers of
 * src/state-manager.ts (`setAccountAt`, `setCodeAt`, `removeAccountAt`,
 * `setStorageAt`, `clearStorageAt`) with no checkpoint around them, so it is a
 * second route into the record and must satisfy the same invariant as the
 * default engine (change-set-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertChangeSets} from './change-set-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('the change set records every changed key with its previous value (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'change-set'}});

	console.log('\n[revm-change-set] errors:', r.errors);
	const c = r.results.revmChangeSet as Record<string, any>;
	console.log('[revm-change-set]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.differential.engineId).toBe('revm-wasm');
	assertChangeSets(c, 'revm');

	await h.dispose();
});
