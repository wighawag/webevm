/**
 * impersonation.spec.ts: `hardhat_` / `anvil_impersonateAccount` and the
 * sends they enable, on the default engine. The battery is
 * helpers/impersonation-checks.ts; the revm half is revm-impersonation.spec.ts,
 * held to the same assertions (impersonation-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertImpersonation} from './impersonation-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('impersonation over the trusted-sender primitive (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'impersonation'}});

	console.log('\n[impersonation] errors:', r.errors);
	const c = r.results.impersonation as Record<string, any>;
	console.log(
		'[impersonation]',
		JSON.stringify(c ?? null, null, 2).slice(0, 4000),
	);
	expect(r.errors).toEqual([]);
	assertImpersonation(c, '@ethereumjs/evm');

	await h.dispose();
});
