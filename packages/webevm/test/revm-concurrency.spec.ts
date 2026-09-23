/**
 * revm-concurrency.spec.ts — TWO EXECUTIONS AT ONCE MUST NOT DESTROY EACH OTHER'S
 * STATE, with the `webevm/revm` engine installed.
 *
 * The suite is the one `concurrency.spec.ts` runs (helpers/concurrency.ts) and the
 * expectations are the same (./concurrency-expected.ts). What changes is which EVM
 * executed the transactions.
 *
 * WHY THIS FILE EXISTS, given that revm's `call` cannot commit and therefore opens
 * no checkpoint level for an overlapping transaction to mis-pop: because the defect
 * ADR 0012 records is not a property of either EVM. It is a property of the node's
 * dispatcher and of the state manager both engines read and write through
 * (ADR 0005, ADR 0010), so WRITE-VERSUS-WRITE interleaves here exactly as it does
 * on the default engine and a non-executing read is just as dirty mid-transaction.
 * A fix that had lived inside `createEthereumjsEngine.call` would have left this
 * spec red, which is precisely why the serialisation point is in `createNode`.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import type {ConcurrencyReport} from './helpers/concurrency.js';
import {assertConcurrencyReport} from './concurrency-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('overlapping requests cannot corrupt each other (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'concurrency'}});

	console.log('\n[revm-concurrency] errors:', r.errors);
	const c = r.results.revmConcurrency as ConcurrencyReport;
	console.log('[revm-concurrency]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	// The battery really ran ON REVM, and the transactions really went through the
	// seam — counted AT it, because a suite whose transactions had quietly gone
	// back to `@ethereumjs/vm` would pass every assertion below while measuring
	// nothing.
	expect(c.engineId).toBe('revm-wasm');
	expect(Object.keys(c.transactionsByEngine ?? {})).toEqual(['revm-wasm']);
	// Several hundred transactions across the battery's fresh-node-per-offset
	// scans; the exact number is not pinned (it would only restate the scan
	// widths), but "revm executed them, and a lot of them" is.
	expect((c.transactionsByEngine ?? {})['revm-wasm']).toBeGreaterThan(100);

	assertConcurrencyReport(c, expect);

	await h.dispose();
});
