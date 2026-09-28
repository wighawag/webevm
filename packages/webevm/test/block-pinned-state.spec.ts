/**
 * block-pinned-state.spec.ts: A STATE READ PINNED TO A BLOCK IS NEVER ANSWERED
 * FROM A DIFFERENT BLOCK.
 *
 * This node keeps only the state at its head. A read pinned to the head (by tag,
 * number, hash or EIP-1898 object) is served; one pinned below it is refused with
 * -32000 `historical state not available`; one above it or to an unknown hash is
 * -32000 `header not found`. Before the fix every one of them was answered from
 * the head, silently. The battery and its reasoning live in
 * `helpers/block-pinned-state.ts`.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

const METHODS = [
	'eth_call',
	'eth_estimateGas',
	'eth_getBalance',
	'eth_getTransactionCount',
	'eth_getCode',
	'eth_getStorageAt',
];
const SERVED = [
	'absent',
	'latest',
	'pending',
	'safe',
	'finalized',
	'headNumber',
	'headHash',
	'headObjectNumber',
	'headObjectHash',
	'headHashUpper',
	'headObjectHashCanonical',
	'headNumberZeroPadded',
];
const HISTORICAL = ['previousNumber', 'earliest', 'previousObjectNumber'];
const NOT_FOUND = ['future', 'unknownHash', 'huge'];

test('a state read pinned to a block below the head is refused, and the head is still served', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'block-pinned-state'}});

	console.log('\n[block-pinned-state] errors:', r.errors);
	const c = r.results.blockPinnedState as Record<string, any>;
	console.log('[block-pinned-state]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.head).toBe(c.previous + 1);

	// 1) THE BUG, in the consumer's own shape: a view call pinned to the block
	// BEFORE a storage-changing block (deploy leaves 0, the increment makes it 1).
	// It used to return the NEW value, 1, with no error.
	expect(c.viemPinnedToPrevious.value).toBeUndefined();
	expect(c.viemPinnedToPrevious.error).toContain(
		'historical state not available',
	);
	// 2) Pinned to the head, it still works and sees the head's value.
	expect(c.viemPinnedToHead).toBe('1');

	for (const m of METHODS) {
		const row = c.matrix[m];
		// Every way of naming the head is served, and all agree with `latest`.
		for (const ref of SERVED) {
			expect(row[ref], `${m} @ ${ref}`).toHaveProperty('ok');
			expect(row[ref].ok, `${m} @ ${ref}`).toEqual(row.latest.ok);
		}
		for (const ref of HISTORICAL) {
			expect(row[ref], `${m} @ ${ref}`).toMatchObject({code: -32000});
			expect(row[ref].message).toContain('historical state not available');
		}
		for (const ref of NOT_FOUND) {
			expect(row[ref], `${m} @ ${ref}`).toMatchObject({code: -32000});
			expect(row[ref].message).toContain('header not found');
		}
		expect(row.garbage, `${m} @ garbage`).toMatchObject({code: -32602});
		// EIP-1898 names ONE of hash or number; both at once is refused.
		expect(row.bothKeys, `${m} @ bothKeys`).toMatchObject({code: -32602});
	}
	expect(c.earliestAtGenesis).toEqual({ok: '0x0'});

	// The head value really is the post-increment one, so "served" above is not
	// vacuous agreement between wrong answers.
	expect(c.matrix.eth_getStorageAt.latest.ok).toBe(
		'0x' + '00'.repeat(31) + '01',
	);

	await h.dispose();
});
