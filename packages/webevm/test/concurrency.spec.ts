/**
 * concurrency.spec.ts — TWO EXECUTIONS AT ONCE MUST NOT DESTROY EACH OTHER'S
 * STATE, on the default `@ethereumjs/evm` engine.
 *
 * The node used to dispatch requests with no serialisation of any kind while both
 * halves of execution opened checkpoint levels on ONE shared state manager — the
 * transaction path through `runTx` (checkpoint, execute, commit) and the default
 * engine's `eth_call` through its purity checkpoint (checkpoint, execute, revert).
 * `commit()` merges the top level downward and `revert()` discards it, and neither
 * knows who opened the level it is acting on, so a read arriving mid-transaction
 * reverted the level the transaction had just committed into. Every scan below is
 * a measured reproduction of that; the fix is the node's serialisation point and
 * the reasoning is `docs/adr/0012-...`.
 *
 * WHAT MAKES THESE TESTS WORTH HAVING: each scan sweeps an exact range of
 * MICROTASK-TICK offsets with a fresh node per offset, so the overlap is
 * deterministic rather than hoped for, and each reports `issuedWhilePending` —
 * how many offsets really did issue their second request while the first was still
 * running. Asserting that count is what stops this file going quietly vacuous if
 * the timing ever shifts. Verified to FAIL with the serialisation point removed:
 * 23/32 offsets corrupt on the read-versus-write scan, 32/32 on write-versus-write
 * and on the `eth_call`-commits-its-own-write scan, 27/32 torn, and the twelve-at-
 * once queue check dying on `nonce too high` from its own lost nonces.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import type {ConcurrencyReport} from './helpers/concurrency.js';
import {assertConcurrencyReport} from './concurrency-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('overlapping requests cannot corrupt each other (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'concurrency'}});

	console.log('\n[concurrency] errors:', r.errors);
	const c = r.results.concurrency as ConcurrencyReport;
	console.log('[concurrency]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	expect(c.engineId).toBe('@ethereumjs/evm');
	// Nothing was injected, so the node built its own default engine and there is
	// nothing out here to count at the seam.
	expect(c.transactionsByEngine).toBeNull();

	assertConcurrencyReport(c, expect);

	await h.dispose();
});
