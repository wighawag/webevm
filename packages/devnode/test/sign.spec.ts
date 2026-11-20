/**
 * sign.spec.ts: the signing methods of dev accounts (`eth_signTypedData_v4`
 * and its EIP-712 encoder, `personal_sign`, `eth_sign`, `eth_signTransaction`),
 * run IN NODE and in a real browser page, against the same assertions
 * (sign-expected.ts).
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertSign} from './sign-expected.js';
import {runSignChecks} from './helpers/sign-checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('dev accounts sign messages, typed data and transactions (Node)', async ({}, testInfo) => {
	// No page: this runs in the test runner's own Node process, once.
	test.skip(
		testInfo.project.name !== 'chromium',
		'Node run: the browser project does not matter, so it runs once',
	);
	assertSign(await runSignChecks());
});

test('dev accounts sign messages, typed data and transactions (browser)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'sign'}});
	console.log('\n[sign] errors:', r.errors);
	expect(r.errors).toEqual([]);
	assertSign(r.results.sign as Record<string, any>);
	await h.dispose();
});
