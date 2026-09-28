/**
 * revm-storage-keys.spec.ts: THE TWO ROUTES INTO ONE SLOT AGREE ABOUT THE KEY.
 *
 * The node's storage key is PACKED: two bytes per UTF-16 code
 * unit, built by `src/storage-keys.ts` — because 83-84% of a cold revm storage
 * access was JS-side hex key building and this recovers HALF of the access
 * (`docs/spikes/revm-state-store-packed-storage-keys/measurements.md`). Owning
 * the key format is what ADR 0009 bought; this is what it is spent on.
 *
 * WHAT THIS SPEC IS FOR IS THE HAZARD THAT COMES WITH IT. `@ethereumjs/evm`,
 * genesis, `loadState` and the `evm_set*` cheats write storage through the ASYNC
 * `putStorage`; revm reads it through the SYNCHRONOUS `storageAt`, because the
 * interpreter is a synchronous loop inside wasm (ADR 0005). If those two
 * disagreed about the key, each half would be perfectly self-consistent and every
 * cross-route read would MISS — and a miss is a ZERO, not an error, at identical
 * gas. The cross-backend gas gate, the conformance differential's receipts and
 * every `dumpState` diff would all stay green.
 *
 * So the assertions here are ABSOLUTE VALUES, in BOTH directions, on BOTH
 * engines: what the reference `@ethereumjs/evm` node reads is what the revm node
 * reads, and both are the literal that was written. Its OWN cut
 * (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

const b32 = (hex: string) => `0x${hex.padStart(64, '0')}`;

/** Nothing has been written yet: the two transaction-written slots read ZERO. */
const AT_GENESIS: Record<string, string> = {
	'A.zero.call': b32('2a'),
	'A.zero.rpc': b32('2a'),
	'A.lastByte.call': b32('bb'),
	'A.lastByte.rpc': b32('bb'),
	'A.firstByte.call': b32('cc'),
	'A.firstByte.rpc': b32('cc'),
	'A.wide.call':
		'0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
	'A.wide.rpc':
		'0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
	'B.zero.call': b32('dd'),
	'B.zero.rpc': b32('dd'),
	'A.cheated.call': b32('0'),
	'A.cheated.rpc': b32('0'),
	'A.written.call': b32('0'),
	'A.written.rpc': b32('0'),
};

/**
 * After the two transactions and the cheat. `A.zero` was OVERWRITTEN by a
 * transaction (0x2a -> 0x2b), which is the reading that says the engine's write
 * landed on the SAME key genesis had used rather than beside it.
 */
const AT_END: Record<string, string> = {
	...AT_GENESIS,
	'A.zero.call': b32('2b'),
	'A.zero.rpc': b32('2b'),
	'A.cheated.call': b32('99'),
	'A.cheated.rpc': b32('99'),
	'A.written.call':
		'0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
	'A.written.rpc':
		'0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
};

/** The `loadState` arrival, read by an `SLOAD` on the revm engine. */
const AFTER_LOAD_STATE: Record<string, string> = Object.fromEntries(
	Object.entries(AT_END).filter(([k]) => k.endsWith('.call')),
);

test('revm storage keys: the packed key is the SAME key on the async and the synchronous route, in both directions', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'storage-keys'}});

	console.log('\n[revm-storage-keys] errors:', r.errors);
	const c = r.results.revmStorageKeys as Record<string, any>;
	console.log('[revm-storage-keys]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The battery really ran two DIFFERENT engines against each other, which is the
	// premise every assertion below rests on.
	expect(c.referenceEngineId).toBe('@ethereumjs/evm');
	expect(c.engineId).toBe('revm-wasm');

	// 1) THE ABSOLUTE STATEMENT, per route, per engine. This is what a key
	// disagreement fails: the `.call` column (an `SLOAD` on the engine) goes to
	// zeroes on the revm node while everything else stays green.
	expect(c.reads.genesis.reference).toEqual(AT_GENESIS);
	expect(c.reads.genesis.underTest).toEqual(AT_GENESIS);
	expect(c.reads.final.reference).toEqual(AT_END);
	expect(c.reads.final.underTest).toEqual(AT_END);

	// 2) ...and the same statement as a DIFFERENTIAL, which names the reading that
	// moved rather than the whole table.
	expect(c.mismatches).toEqual([]);

	// 3) THE SLOT COUNT. A transaction that overwrote `A.zero` through a different
	// key than genesis used would leave the account holding SIX slots where it
	// holds five, with both readings above still plausible.
	const EXPECTED_COUNTS = {
		'0x00000000000000000000000000000000000000e0': 6, // 4 genesis + written + cheated
		'0xe000000000000000000000000000000000000000': 1,
	};
	expect(c.slotCounts.reference).toEqual(EXPECTED_COUNTS);
	expect(c.slotCounts.underTest).toEqual(EXPECTED_COUNTS);

	// 4) THE SERIALISED FORMAT IS ENGINE-INDEPENDENT. `dumpState` is persisted data
	// (`test/storage-overlay.spec.ts` pins it byte-identical against a fixture
	// captured before the layout ever changed); here it is pinned to be the same
	// dump whichever engine wrote the storage, in `0x`-hex, key for key.
	expect(c.dumpStorage.underTest).toBe(c.dumpStorage.reference);
	// ...and it really is hex, in full 32-byte slot keys, not the packed internal
	// key leaking out through `liveStorage()`.
	//
	// The VALUES are verbatim what each writer stored, which is a property of the
	// node and not of this change: the EVM strips a value's leading zeros before
	// `putStorage` (so the transaction-written `A.zero` is `0x2b`), while genesis
	// and `evm_setStorageAt` hand over 32 padded bytes and the dump serialises
	// those. It is pinned here so the next reader does not take the asymmetry for a
	// key-encoding artefact.
	expect(JSON.parse(c.dumpStorage.underTest)).toEqual({
		'0x00000000000000000000000000000000000000e0': {
			[b32('0')]: '0x2b',
			[b32('1')]: b32('bb'),
			'0x0100000000000000000000000000000000000000000000000000000000000000':
				b32('cc'),
			'0x808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f':
				'0xf0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f',
			[b32('c0de')]:
				'0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
			[b32('7')]: b32('99'),
		},
		'0xe000000000000000000000000000000000000000': {[b32('0')]: b32('dd')},
	});

	// 5) `loadState` INTO A FRESH REVM NODE: storage that arrived through the async
	// route, in bulk, read back by an `SLOAD` on the synchronous one. This is the
	// arrival a persisted node makes on every page load.
	expect(c.afterLoadState).toEqual(AFTER_LOAD_STATE);

	await h.dispose();
});
