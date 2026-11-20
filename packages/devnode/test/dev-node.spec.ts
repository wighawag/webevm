/**
 * dev-node.spec.ts: `@webevm/devnode`'s first slice on the default engine. The
 * battery is helpers/dev-node-checks.ts; the revm half is revm-dev-node.spec.ts,
 * held to the same assertions (dev-node-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertDevNode} from './dev-node-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('dev accounts, funded at genesis, everything else forwarded (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'dev-node'}});

	console.log('\n[dev-node] errors:', r.errors);
	const c = r.results.devNode as Record<string, any>;
	console.log('[dev-node]', JSON.stringify(c ?? null, null, 2).slice(0, 4000));
	expect(r.errors).toEqual([]);
	assertDevNode(c, '@ethereumjs/evm');

	await h.dispose();
});
