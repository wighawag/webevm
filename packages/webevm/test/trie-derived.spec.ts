/**
 * trie-derived.spec.ts: `stateMode:'trie'` runs on the same flat state as every
 * node and DERIVES its trie from it (src/derived-trie.ts, ADR 0014), on the
 * DEFAULT engine. The batteries are helpers/trie-derived.ts and
 * helpers/storage-collision.ts; the revm half is revm-trie-derived.spec.ts, held
 * to the same assertions (trie-derived-expected.ts,
 * storage-collision-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertTrieDerived} from './trie-derived-expected.js';
import {assertStorageCollisions} from './storage-collision-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('trie mode: a dump carries storage and a reload reproduces every root; none mode builds no trie; history composes (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'trie-derived'}});
	console.log('\n[trie-derived] errors:', r.errors);
	const c = r.results.trieDerived as Record<string, any>;
	console.log(
		'[trie-derived]',
		JSON.stringify(
			{dumpReload: c?.dumpReload, none: c?.noTrieInNoneMode},
			null,
			2,
		),
	);
	expect(r.errors).toEqual([]);
	expect(c.dumpReload.engineId).toBe('@ethereumjs/evm');
	expect(c.history.differential.engineId).toBe('@ethereumjs/evm');
	assertTrieDerived(c, '@ethereumjs/evm');
	await h.dispose();
});

test('a creation over a storage-only account succeeds and wipes it, in both state modes (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'storage-collision'}});
	console.log('\n[storage-collision] errors:', r.errors);
	const c = r.results.storageCollision as Record<string, any>;
	console.log('[storage-collision]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	assertStorageCollisions(c, '@ethereumjs/evm');
	await h.dispose();
});
