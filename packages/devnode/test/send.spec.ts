/**
 * send.spec.ts: `eth_sendTransaction` from dev accounts on the default engine,
 * in both sender modes. The battery is helpers/send-checks.ts; the revm half is
 * revm-send.spec.ts, held to the same assertions (send-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertSend} from './send-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('eth_sendTransaction from dev accounts (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'send'}});

	console.log('\n[send] errors:', r.errors);
	const c = r.results.send as Record<string, any>;
	console.log('[send]', JSON.stringify(c ?? null, null, 2).slice(0, 4000));
	expect(r.errors).toEqual([]);
	assertSend(c, '@ethereumjs/evm');

	await h.dispose();
});
