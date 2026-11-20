/**
 * snapshot-cost.spec.ts: what `evm_snapshot` and `evm_revert` cost at a few
 * state sizes (helpers/snapshot-cost.ts). It asserts only that every round
 * reverted and that the cost GROWS with the state (it is O(state) by design);
 * the numbers themselves are machine-dependent and are logged, recorded in
 * docs/spikes/snapshots-in-the-core/measurement.md and quoted in the README.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('what a snapshot and a revert cost', async ({page}) => {
	test.setTimeout(300_000);
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'snapshot-cost'}});

	console.log('\n[snapshot-cost] errors:', r.errors);
	const rows = r.results.snapshotCost as {
		accounts: number;
		computeStateRoot: boolean;
		dumpBytes: number;
		snapshotMs: number;
		revertMs: number;
	}[];
	console.table(rows);
	expect(r.errors).toEqual([]);
	for (const trie of [false, true]) {
		const mode = rows.filter((x) => x.computeStateRoot === trie);
		const small = mode[0];
		const large = mode[mode.length - 1];
		expect(large.dumpBytes).toBeGreaterThan(small.dumpBytes);
		expect(large.revertMs).toBeGreaterThan(small.revertMs);
	}

	await h.dispose();
});
