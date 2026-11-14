/**
 * block-clock.spec.ts: the node's clock and its time cheats, on the default
 * engine. The battery is helpers/block-clock.ts; the revm half is
 * revm-block-clock.spec.ts, held to the same assertions
 * (block-clock-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertBlockClock} from './block-clock-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('the block clock and its time cheats (default engine)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'block-clock'}});

	console.log('\n[block-clock] errors:', r.errors);
	const c = r.results.blockClock as Record<string, any>;
	console.log('[block-clock]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	expect(c.next.engineId).toBe('@ethereumjs/evm');
	assertBlockClock(c, '@ethereumjs/evm');

	await h.dispose();
});
