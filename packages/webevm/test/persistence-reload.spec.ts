/**
 * persistence-reload.spec.ts — prove the slim node's IndexedDB persistence (and
 * eth_getLogs) survive a REAL page reload, in real Chromium.
 *
 * Flow (the harness's purpose-built write -> reload -> read):
 *   1. phase 'write': a node wired to createIndexedDBPersistence() deploys a
 *      Counter, sends 3 increments (each emits Incremented) + a value transfer;
 *      persistence auto-saves to IndexedDB after each mined tx.
 *   2. page.reload() WIPES all JS state (the node object is gone) — but IndexedDB,
 *      being browser storage, survives.
 *   3. phase 'read': a FRESH node with the same persistence adapter auto-loads
 *      from IndexedDB; we re-query contract storage, a balance, AND eth_getLogs
 *      (all/address-filtered/topic-filtered) to prove logs survived with correct
 *      logIndex ordering + block numbers + decodable event args.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('IndexedDB persistence + eth_getLogs survive a real page reload', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});

	// 1) write + persist to IndexedDB
	const w = await h.run({phase: 'write', params: {mode: 'persist-reload'}});
	console.log('\n[persist-reload] write:', JSON.stringify(w.results.write));
	expect(w.errors).toEqual([]);
	const write = w.results.write as any;
	expect(write.number).toBe('3');
	expect(write.logCount).toBe(3); // 3 Incremented events
	expect(write.feedBalance).toBe('7777');

	// 2) REAL reload — wipes JS state; IndexedDB survives.
	await h.reload();

	// 3) read from a fresh node that auto-loaded from IndexedDB
	const r = await h.run({
		phase: 'read',
		params: {
			mode: 'persist-reload',
			address: write.address,
			pinned: write.pinned,
			beforeTransfer: write.beforeTransfer,
		},
	});
	console.log(
		'[persist-reload] read:',
		JSON.stringify(r.results.read, null, 2),
	);
	expect(r.errors).toEqual([]);
	const read = r.results.read as any;

	// state survived the reload (came ENTIRELY from IndexedDB — no initialBalances)
	expect(read.loaded).toBe(true);
	expect(read.blockNumber).toBe(write.blockNumber);
	expect(read.number).toBe('3'); // contract STORAGE survived
	expect(read.feedBalance).toBe('7777'); // account balance survived

	// eth_getLogs works AFTER reload:
	expect(read.logCount).toBe(3); // all logs restored
	expect(read.addressFilteredCount).toBe(3); // address filter works
	expect(read.topicFilteredCount).toBe(3); // topic0 filter works
	expect(read.logIndexesOrdered).toBe(true); // logIndex ordering preserved
	expect(read.logBlockNumbersPresent).toBe(true); // block numbers intact
	expect(read.lastEventValue).toBe('3'); // event args still decode (newValue==number)

	// The BLOCK HEADER survived too, and the read node was configured with no
	// `blockEnv` of its own: a `miner` / `mixHash` it can still report came out of
	// IndexedDB. The bloom of the block carrying a log survived with them, so a
	// consumer's bloom pre-filter does not start finding nothing after a reload.
	expect(read.headMiner).toBe(write.headMiner);
	expect(read.headMixHash).toBe(write.headMixHash);
	expect(read.logBlockLogsBloom).toBe(write.logBlockLogsBloom);
	expect(read.headMiner).not.toBe('0x0000000000000000000000000000000000000000');
	expect(read.headMixHash).not.toBe('0x' + '00'.repeat(32));
	expect(read.logBlockLogsBloom).not.toBe('0x' + '00'.repeat(256));

	// The stateHistory WINDOW survived too: reads pinned below the head answer
	// after the reload exactly as before it (the undo log is in the dump). The
	// write side is pinned to literals first, so agreement is not vacuous.
	expect(write.historical.pinned).toBeLessThan(write.blockNumber);
	expect(write.historical.numberAtPinned).toBe('1');
	expect(write.historical.slot0AtPinned).toBe('0x' + '1'.padStart(64, '0'));
	expect(write.historical.feedBalanceBeforeTransfer).toBe('0x0');
	expect(write.historical.codeAtGenesis).toBe('0x');
	expect(read.historical).toEqual(write.historical);

	await h.dispose();
});
