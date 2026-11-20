/**
 * snapshots.spec.ts: `evm_snapshot` / `evm_revert` and anvil's names for them,
 * on the default engine. The battery is helpers/snapshots.ts; the revm half is
 * revm-snapshots.spec.ts, held to the same assertions (snapshots-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertSnapshots} from './snapshots-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('evm_snapshot / evm_revert (default engine)', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'snapshots'}});

	console.log('\n[snapshots] errors:', r.errors);
	const c = r.results.snapshots as Record<string, any>;
	console.log('[snapshots]', JSON.stringify(c ?? null, null, 2).slice(0, 4000));
	expect(r.errors).toEqual([]);
	expect(c.restore.engineId).toBe('@ethereumjs/evm');
	assertSnapshots(c, '@ethereumjs/evm');

	await h.dispose();
});
