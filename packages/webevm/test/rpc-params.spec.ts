/**
 * rpc-params.spec.ts: PARAMETERS THAT USED TO BE IGNORED ARE HONOURED OR REFUSED.
 *
 * `eth_call` / `eth_estimateGas` state overrides (default engine, without and
 * with `computeStateRoot`), `eth_getLogs` `blockHash` and `eth_feeHistory` `newestBlock`.
 * Each was silently dropped before, so the node answered a different question
 * from the one asked. The battery is `helpers/rpc-params.ts`; the revm half of
 * the override battery is `revm-rpc-params.spec.ts`.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertStateOverrides} from './rpc-params-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('state overrides, eth_getLogs blockHash and eth_feeHistory newestBlock are honoured or refused', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'rpc-params'}});

	console.log('\n[rpc-params] errors:', r.errors);
	const c = r.results.rpcParams as Record<string, any>;
	console.log('[rpc-params]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	assertStateOverrides(c.overridesNone, 'without computeStateRoot');
	assertStateOverrides(c.overridesTrie, 'computeStateRoot: true');

	const l = c.logsAndFeeHistory;
	const [first, second] = l.incrementBlocks;
	expect(second.number).toBe(first.number + 1);

	// ---- eth_getLogs blockHash ----
	// Both increments' logs exist; before the fix a blockHash query returned both.
	expect(l.allLogBlocks).toEqual([first.number, second.number]);
	expect(l.byHash).toEqual([
		{blockNumber: first.number, blockHash: first.hash},
	]);
	expect(l.byUnknownHash).toMatchObject({code: -32000});
	expect(l.byUnknownHash.message).toContain('unknown block');
	expect(l.hashAndRange).toMatchObject({code: -32602});
	expect(l.garbageRange).toMatchObject({code: -32602});

	// ---- eth_feeHistory newestBlock ----
	// The window ENDS at the block asked for (it used to end at the head).
	expect(l.pinned.ok.oldestBlock).toBe('0x' + (first.number - 1).toString(16));
	expect(l.pinned.ok.baseFeePerGas).toHaveLength(3);
	expect(l.pinned.ok.gasUsedRatio).toHaveLength(2);
	expect(l.pinned.ok.reward).toHaveLength(2);
	// The last ratio is the increment block's, which really used gas.
	expect(l.pinned.ok.gasUsedRatio[1]).toBeGreaterThan(0);
	expect(l.pinned.ok.baseFeePerGas[1]).toBe(l.incBlockBaseFee);
	expect(l.atHead.ok.oldestBlock).toBe('0x' + (l.head - 1).toString(16));
	expect(l.beyondHead).toMatchObject({code: -32000});
	// Asking for more blocks than precede the newest one is clamped at genesis.
	expect(l.moreThanExists.ok.oldestBlock).toBe('0x0');
	expect(l.moreThanExists.ok.gasUsedRatio).toHaveLength(2);
	expect(l.moreThanExists.ok.gasUsedRatio[0]).toBe(0); // genesis is empty
	expect(l.moreThanExists.ok.baseFeePerGas[0]).toBe(l.genesisBaseFee);
	// Genesis and mined blocks carry DIFFERENT base fees on this node, so the
	// per-block values are really read per block (not the old constant).
	expect(l.genesisBaseFee).not.toBe(l.incBlockBaseFee);
	expect(l.moreThanExists.ok.baseFeePerGas[1]).toBe(l.incBlockBaseFee);
	expect(l.hashAsNewest).toMatchObject({code: -32602});
	expect(l.garbageCount).toMatchObject({code: -32602});
	expect(l.zeroCount.ok).toMatchObject({
		oldestBlock: '0x0',
		baseFeePerGas: [],
		gasUsedRatio: [],
		reward: [],
	});

	// ---- the pending nonce, under manual mining ----
	const n = c.pendingNonce;
	expect(n.beforeMine).toEqual({pending: '0x2', latest: '0x0'});
	expect(n.statuses).toEqual(['0x1', '0x1']);
	expect(n.afterMine).toEqual({pending: '0x2', latest: '0x2'});

	await h.dispose();
});
