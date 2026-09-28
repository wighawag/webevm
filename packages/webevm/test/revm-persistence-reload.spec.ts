/**
 * revm-persistence-reload.spec.ts — IndexedDB persistence + `eth_getLogs` survive a
 * REAL page reload with the `webevm/revm` engine installed.
 *
 * The flow is the one `persistence-reload.spec.ts` runs
 * (helpers/persistence-reload.ts): write + persist, reload the page (which wipes
 * every trace of JS state), then a FRESH node auto-loads from IndexedDB and
 * re-queries storage, a balance and the logs. The assertions are the same ones, on
 * the same numbers — that is the point. Story 13 of `revm-engine-behind-runtx` is a
 * regression bar: adopting revm must cost a consumer none of the node's existing
 * features, and persistence is the feature a browser session depends on most.
 *
 * WHAT IT ADDS OVER THE DEFAULT-ENGINE RUN: everything read back here was written
 * by revm through host callbacks into the node's own state (ADR 0010), and the
 * reload leaves nothing else to read. A write half that had kept anything on the
 * wasm side would persist an incomplete chain and fail here, after passing every
 * same-session state assertion in the repo.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('IndexedDB persistence + eth_getLogs survive a real page reload (revm)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});

	// 1) write + persist to IndexedDB, with revm executing every transaction
	const w = await h.run({phase: 'write', params: {mode: 'persist-reload'}});
	console.log(
		'\n[revm persist-reload] write:',
		JSON.stringify(w.results.write),
	);
	expect(w.errors).toEqual([]);
	const write = w.results.write as any;
	expect(write.engineId).toBe('revm-wasm'); // not a silent default-engine run
	expect(write.number).toBe('3');
	expect(write.logCount).toBe(3); // 3 Incremented events
	expect(write.feedBalance).toBe('7777');

	// 2) REAL reload — wipes JS state; IndexedDB survives.
	await h.reload();

	// 3) read from a fresh revm-backed node that auto-loaded from IndexedDB
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
		'[revm persist-reload] read:',
		JSON.stringify(r.results.read, null, 2),
	);
	expect(r.errors).toEqual([]);
	const read = r.results.read as any;

	expect(read.engineId).toBe('revm-wasm');
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
