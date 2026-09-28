/**
 * viem-surface.spec.ts — drives the slim node through a typical viem/wagmi dapp
 * lifecycle in real Chromium and REPORTS the EIP-1193 method surface it exercised,
 * flagging any method that returned `-32601` (a gap a real integration would hit).
 *
 * This is a coverage/observability test, not a correctness oracle (that's
 * conformance.spec.ts). Its job: catch silent method gaps and prove the common
 * happy path (deploy + receipt POLLING + read + simulate + write + logs +
 * newHeads) works end-to-end through a stock viem client.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('slim-node EIP-1193 surface under a typical viem/wagmi lifecycle', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'viem-surface'}});

	console.log('\n[viem-surface] errors:', r.errors);
	const s = r.results.viemSurface as any;
	console.log(
		'[viem-surface] methods exercised:',
		JSON.stringify(s.methodsSeen),
	);
	console.log(
		'[viem-surface] UNSUPPORTED (-32601):',
		JSON.stringify(s.unsupported),
	);
	console.log('[viem-surface] real errors:', JSON.stringify(s.errored));
	console.log('[viem-surface] deployedAddress:', s.deployedAddress);
	console.log(
		'[viem-surface] finalNumber:',
		s.finalNumber,
		'numberAfterAll:',
		s.numberAfterAll,
	);
	console.log('[viem-surface] callCounts:', JSON.stringify(s.callCounts));
	console.log('[viem-surface] rawTxNonces:', JSON.stringify(s.rawTxNonces));

	expect(r.errors).toEqual([]);

	// The happy path basics complete end-to-end through a stock viem client.
	expect(s.deployedAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
	expect(s.receiptPollingWorked).toBe(true);
	expect(s.watchBlocksFired).toBe(true);

	// REGRESSION GUARD (was the quarantined estimate-leak bug): repeated
	// eth_estimateGas / eth_call used to leak warm-storage state across the node's
	// checkpoint()/revert(), so the SECOND+ warm SSTORE estimate came back ~2000
	// gas too low; viem used it as the gas LIMIT and writes after the first ran
	// OUT OF GAS (number stuck at 1). Fixed in node.ts evmCall by resetting the EVM
	// journal warm/access tracking + originalStorageCache per call. This probe is
	// what surfaced it (conformance.spec only estimated the cold first call), so it
	// now guards the fix: every increment must land.
	expect(s.finalNumber).toBe('2'); // after the 2 explicit writes
	expect(s.numberAfterAll).toBe('3'); // after the 3rd (watchBlocks-trigger) write

	// No NON--32601 errors: any method we DO answer must answer cleanly.
	expect(s.errored).toEqual([]);

	// `eth_feeHistory` ANSWERS THE REQUEST IT WAS GIVEN: one `reward` entry per
	// REQUESTED PERCENTILE, per block. A single entry regardless is well-formed
	// enough to parse and wrong for anybody who INDEXES it — rocketh asks for three
	// and reads indices 1 and 2, which came back `undefined` and blew up as "Cannot
	// mix BigInt and other types" far from this node. The node's fee model is flat,
	// so every percentile carries the SAME value and asserting the values would
	// measure nothing; the widths are the property, held for two different request
	// lengths so a hardcoded 3 fails as loudly as a hardcoded 1.
	//
	// THE NUMBER OF BLOCKS is not asserted as the count REQUESTED: this chain is
	// shorter than 4 blocks here, and the window is clamped at genesis as geth
	// clamps it. (It used to be padded with entries for blocks that do not exist.)
	const {threePercentiles, onePercentile} = s.feeHistoryRewardWidths;
	expect(threePercentiles.length).toBeGreaterThan(0);
	expect(threePercentiles.length).toBeLessThanOrEqual(4);
	expect(threePercentiles.every((w: number) => w === 3)).toBe(true);
	expect(onePercentile.length).toBeGreaterThan(0);
	expect(onePercentile.length).toBeLessThanOrEqual(2);
	expect(onePercentile.every((w: number) => w === 1)).toBe(true);

	// Methods viem RELIABLY emits in this lifecycle must be both emitted AND
	// answered (not -32601). NOTE: now that eth_fillTransaction is implemented,
	// viem fills gas/fees through it and no longer emits eth_estimateGas/
	// eth_gasPrice on the write path — those are still implemented (and covered by
	// conformance + the simulate calls) but not necessarily emitted here, so they
	// live in `mustAnswerIfSeen` below rather than `mustEmit`.
	const mustEmit = [
		'eth_chainId',
		'eth_blockNumber',
		'eth_getBlockByNumber',
		'eth_call',
		'eth_getBalance',
		'eth_getTransactionCount',
		'eth_getCode',
		'eth_feeHistory',
		'eth_fillTransaction',
		'eth_sendRawTransaction',
		'eth_getTransactionReceipt',
		'eth_getTransactionByHash',
		'eth_getLogs',
	];
	for (const m of mustEmit) {
		expect(s.methodsSeen).toContain(m); // viem actually emitted it
		expect(s.unsupported).not.toContain(m); // and the node answered it
	}
	// These are core methods that MUST answer cleanly if viem emits them, but which
	// viem may route around (e.g. via eth_fillTransaction). Never allow a -32601.
	const mustAnswerIfSeen = [
		'eth_estimateGas',
		'eth_gasPrice',
		'eth_maxPriorityFeePerGas',
	];
	for (const m of mustAnswerIfSeen) {
		expect(s.unsupported).not.toContain(m);
	}

	// Document (not fail on) any gaps viem happened to hit — surfaced in the log
	// above and asserted to be a SUBSET of the known-unimplemented list, so a NEW
	// unexpected gap (e.g. a core method regressing to -32601) fails the test.
	// eth_fillTransaction is now IMPLEMENTED — viem's prepareTransactionRequest uses
	// it to fill nonce/gas/fees in one round-trip; assert the node answered it.
	expect(s.methodsSeen).toContain('eth_fillTransaction');
	expect(s.unsupported).not.toContain('eth_fillTransaction');

	const knownGaps = new Set([
		'eth_newFilter',
		'eth_newBlockFilter',
		'eth_getFilterChanges',
		'eth_getFilterLogs',
		'eth_uninstallFilter',
		'eth_getBlockReceipts',
		'eth_createAccessList',
		'eth_simulateV1',
		'web3_clientVersion',
		'eth_syncing',
		'eth_coinbase',
	]);
	for (const m of s.unsupported as string[]) {
		expect(knownGaps.has(m), `unexpected unsupported method: ${m}`).toBe(true);
	}
});
