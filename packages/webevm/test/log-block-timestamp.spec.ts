/**
 * log-block-timestamp.spec.ts: every log the node serves carries
 * `blockTimestamp` (execution-apis#639), a hex quantity equal to its block's
 * `timestamp`, through `eth_getLogs` and through receipts, and still after a
 * dumpState / loadState. The battery is helpers/log-block-timestamp.ts.
 *
 * No revm twin: a log's block metadata is written by the node after the engine
 * has executed, so no engine can change it. Both engines are still held to it
 * by the conformance battery's node-owned log metadata step and by the
 * persistence-reload flow, which run on both.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('every log carries its block timestamp, before and after a reload', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'log-block-timestamp'},
	});

	console.log('\n[log-block-timestamp] errors:', r.errors);
	const c = r.results.logBlockTimestamp as Record<string, any>;
	console.log('[log-block-timestamp]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	for (const phase of ['live', 'reloaded'] as const) {
		const p = c[phase];
		// Every log agrees with BOTH block lookups.
		expect(p.mismatches, phase).toEqual([]);
		// Four transactions, two logs each, read through both paths.
		expect(p.fromGetLogs, phase).toBe(8);
		expect(p.fromReceipts, phase).toBe(8);
		expect(p.getLogsEqualsReceipts, phase).toBe(true);
		// Three log-carrying blocks with three DIFFERENT timestamps, none of them
		// genesis's: a node stamping every log with one block's timestamp (the
		// head's, genesis's) cannot pass.
		expect(p.logBlocks, phase).toBe(3);
		expect(p.distinctTimestamps, phase).toBe(3);
		expect(Object.values(p.timestamps), phase).not.toContain(
			c.genesisTimestamp,
		);
	}
	// The reloaded node serves the very timestamps the original did.
	expect(c.reloaded.timestamps).toEqual(c.live.timestamps);

	// The persisted log shape is unchanged (the timestamp is looked up from the
	// block, not stored on the log), so the reload above IS an older dump's.
	expect(c.dumpShape.logs).toBe(8);
	expect(c.dumpShape.distinctKeySets).toEqual([c.dumpShape.legacyKeys]);

	await h.dispose();
});
