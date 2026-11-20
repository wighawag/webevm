/**
 * alloc.spec.ts: `toAllocs`, the alloc export for forge's `vm.loadAllocs`, run
 * IN NODE (the export is pure, and a CLI such as rocketh calls it there) and in
 * a real browser page, against the same assertions (alloc-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertAllocs} from './alloc-expected.js';
import {runAllocChecks} from './helpers/alloc-checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('toAllocs exports a deployment as a forge alloc (Node)', async ({}, testInfo) => {
	// No page: this runs in the test runner's own Node process, once.
	test.skip(
		testInfo.project.name !== 'chromium',
		'Node run: the browser project does not matter, so it runs once',
	);
	assertAllocs(await runAllocChecks());
});

test('toAllocs exports a deployment as a forge alloc (browser)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'alloc'}});
	console.log('\n[alloc] errors:', r.errors);
	expect(r.errors).toEqual([]);
	assertAllocs(r.results.alloc as Record<string, any>);
	await h.dispose();
});
