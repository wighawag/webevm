/**
 * revm-trie-derived.spec.ts: trie mode on the revm engine, which used to REFUSE
 * it (trie mode ran on `MerkleStateManager`, with no synchronous view for revm
 * to read, ADR 0005) and now serves it, because the trie is derived from the
 * flat state between blocks and no engine reads it (ADR 0014). Held to the same
 * assertions as the default engine (trie-derived-expected.ts,
 * storage-collision-expected.ts). The GeneralStateTests roots with revm are
 * revm-statetest.spec.ts; the conformance battery's trie-mode run on revm is
 * revm-conformance.spec.ts.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertTrieDerived} from './trie-derived-expected.js';
import {assertStorageCollisions} from './storage-collision-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

const harness = {
	cut,
	coi: false,
	nodePolyfills: ['buffer', 'process', 'global'],
	esbuild: {loader: {'.wasm': 'binary'}},
} as const;

test('trie mode on revm: a dump carries storage and a reload reproduces every root; none mode builds no trie; history composes', async ({
	page,
}) => {
	const h = await mountHarness(page, harness as any);
	const r = await h.run({phase: 'once', params: {mode: 'trie-derived'}});
	console.log('\n[revm-trie-derived] errors:', r.errors);
	const c = r.results.revmTrieDerived as Record<string, any>;
	expect(r.errors).toEqual([]);
	// It really ran on revm, in trie mode.
	expect(c.dumpReload.engineId).toBe('revm-wasm');
	expect(c.history.differential.engineId).toBe('revm-wasm');
	assertTrieDerived(c, 'revm');
	await h.dispose();
});

test('a creation over a storage-only account succeeds and wipes it, in both state modes (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, harness as any);
	const r = await h.run({phase: 'once', params: {mode: 'storage-collision'}});
	console.log('\n[revm-storage-collision] errors:', r.errors);
	const c = r.results.revmStorageCollision as Record<string, any>;
	console.log('[revm-storage-collision]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	assertStorageCollisions(c, 'revm');
	await h.dispose();
});
