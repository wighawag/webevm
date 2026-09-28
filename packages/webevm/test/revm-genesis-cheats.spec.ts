/**
 * revm-genesis-cheats.spec.ts — a custom genesis and the runtime `evm_set*` cheats,
 * with the `webevm/revm` engine installed.
 *
 * The checks are the ones `genesis-cheats-perf.spec.ts` runs
 * (helpers/genesis-cheats-perf.ts) and the expectations are the same literals
 * (./genesis-cheats-expected.js). What changes is which EVM reads the genesis state
 * and executes the transaction against it.
 *
 * WHY IT IS WORTH RUNNING TWICE. `initialState` and the cheats write the node's own
 * state with no transaction anywhere, and on this engine that state is what revm
 * reads through its host callbacks (ADR 0010). An engine that had been handed a copy
 * of state at construction, or that read code from anywhere but the node, would boot
 * happily and execute against the WRONG genesis — the pre-deployed contract's
 * `number()` would answer 0 rather than 41, with no error at all.
 *
 * WHICH STATE MODE: `'none'`, the default. revm used to REFUSE `'trie'` (ADR
 * 0005); it serves both modes now that the trie is derived from the flat state
 * (ADR 0014), and trie mode on revm is covered by `revm-trie-derived.spec.ts`,
 * `revm-statetest.spec.ts` and `revm-conformance.spec.ts`. `'trie'` keeps its
 * default-engine coverage here in `genesis-cheats-perf.spec.ts`, which also keeps
 * the trie-vs-none perf comparison; engine performance belongs to
 * `packages/benchmarks`.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {GENESIS_CHEATS} from './genesis-cheats-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('custom genesis + runtime cheats on the revm engine', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'genesis-cheats'}});

	console.log('\n[revm-genesis-cheats] errors:', r.errors);
	const s = r.results.revmGenesisCheats as any;
	console.log('[revm-genesis-cheats]', JSON.stringify(s, null, 2));

	expect(r.errors).toEqual([]);

	// Both halves really ran ON REVM, in the mode asked for, and not silently on
	// the default engine, which `genesis-cheats-perf.spec.ts` already covers.
	expect(s.servedMode).toBe('none');
	expect(s.customGenesis.engineId).toBe('revm-wasm');
	expect(s.cheats.engineId).toBe('revm-wasm');

	// (1) custom genesis: the SAME readings the default engine produces.
	expect(s.customGenesis.eoaBalance).toBe(GENESIS_CHEATS.eoaBalance);
	expect(s.customGenesis.eoaNonce).toBe(GENESIS_CHEATS.eoaNonce);
	expect(s.customGenesis.preDeployedCodePresent).toBe(true);
	// seeded storage slot 0, read straight out of the genesis state
	expect(s.customGenesis.preDeployedNumber).toBe(
		GENESIS_CHEATS.preDeployedNumber,
	);
	// ...and the pre-deployed CODE executed on revm: 41 -> 42. This is the reading
	// an engine holding its own copy of state gets wrong.
	expect(s.customGenesis.numberAfterIncrement).toBe(
		GENESIS_CHEATS.numberAfterIncrement,
	);

	// (2) the four runtime cheats round-trip through the standard eth_get* reads.
	expect(s.cheats.balance).toBe(GENESIS_CHEATS.cheatBalance);
	expect(s.cheats.nonce).toBe(GENESIS_CHEATS.cheatNonce);
	expect(s.cheats.code).toBe(GENESIS_CHEATS.cheatCode);
	expect(s.cheats.storageSlot7).toBe(GENESIS_CHEATS.cheatStorageSlot7);

	await h.dispose();
});
