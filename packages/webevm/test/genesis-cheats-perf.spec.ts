/**
 * genesis-cheats-perf.spec.ts — in real Chromium:
 *  1. custom genesis via `initialState` (funded EOAs + a pre-deployed contract
 *     with seeded storage) is visible to a viem client immediately;
 *  2. runtime `evm_set*` cheats round-trip in BOTH state modes;
 *  3. measure + report the trie-vs-none perf delta (the price of a real
 *     Merkle-Patricia root).
 *
 * (1) and (2) also run on `webevm/revm` (`revm-genesis-cheats.spec.ts`),
 * against the SAME literals (./genesis-cheats-expected.ts). (3) does not: it is a
 * comparison BETWEEN the state modes, and engine performance belongs to
 * `packages/benchmarks`.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {GENESIS_CHEATS} from './genesis-cheats-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('custom genesis + runtime cheats + trie-vs-none perf', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'genesis-cheats-perf'}});

	console.log('\n[gcp] errors:', r.errors);
	const s = r.results.genesisCheatsPerf as any;
	console.log('[gcp] customGenesis:', JSON.stringify(s.customGenesis, null, 2));
	console.log('[gcp] cheats:', JSON.stringify(s.cheats, null, 2));
	console.log('[gcp] perf (trie vs none):', JSON.stringify(s.perf, null, 2));

	expect(r.errors).toEqual([]);

	// (1) custom genesis
	expect(s.customGenesis.eoaBalance).toBe(GENESIS_CHEATS.eoaBalance);
	expect(s.customGenesis.eoaNonce).toBe(GENESIS_CHEATS.eoaNonce);
	expect(s.customGenesis.preDeployedCodePresent).toBe(true);
	// seeded storage slot 0
	expect(s.customGenesis.preDeployedNumber).toBe(
		GENESIS_CHEATS.preDeployedNumber,
	);
	// increment() worked
	expect(s.customGenesis.numberAfterIncrement).toBe(
		GENESIS_CHEATS.numberAfterIncrement,
	);

	// (2) runtime cheats, both modes
	for (const mode of ['none', 'trie'] as const) {
		const c = s.cheats[mode];
		expect(c.balance).toBe(GENESIS_CHEATS.cheatBalance);
		expect(c.nonce).toBe(GENESIS_CHEATS.cheatNonce);
		expect(c.code).toBe(GENESIS_CHEATS.cheatCode);
		expect(c.storageSlot7).toBe(GENESIS_CHEATS.cheatStorageSlot7);
	}

	// (3) perf: both produce correct outputs; trie has a real root, none throws.
	expect(s.perf.none.getRootThrows).toBe(true);
	expect(s.perf.trie.rootIsReal).toBe(true);
	// Sanity bounds: timings are positive, and trie is not GROSSLY faster than
	// none (which would mean the two modes got swapped, or one never ran).
	//
	// The bound is deliberately slack. This is a RATIO of two short wall-clock
	// measurements taken in separate runs, so on a loaded machine it inverts:
	// `toBeGreaterThanOrEqual(1)` failed once on Chromium during a full parallel
	// `pnpm test` while measuring 1.62x when the file ran alone, reddening the
	// whole acceptance gate. The real trie-vs-none cost is REPORTED below and
	// belongs in the benchmark package, which is where this repo keeps numbers it
	// looks at rather than asserts on.
	expect(s.perf.none.avgCallMs).toBeGreaterThan(0);
	expect(s.perf.trie.avgCallMs).toBeGreaterThan(0);
	expect(s.perf.callSlowdownX).toBeGreaterThan(0.5);
	console.log(
		`[gcp] trie is ~${s.perf.callSlowdownX}x slower per call, ~${s.perf.deploySlowdownX}x on deploy`,
	);
});
