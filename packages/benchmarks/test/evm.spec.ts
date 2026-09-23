/**
 * evm.spec.ts — drives each in-browser EVM backend in a real Chromium under
 * Playwright via playwright-browser-harness, asserts correctness, and prints the
 * measured timings. It also measures per-backend bundle size by building each
 * cut alone with esbuild and weighing the output (gzipped + raw).
 *
 * Build + serve ONCE for the whole file (the cut bundles all backends), reusing
 * the harness's `buildBundle` (with the `nodePolyfills` preset for ethereumjs/
 * tevm's buffer/process needs) + its COOP/COEP server via the `prebuilt` mount.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {mkdtemp, copyFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {gzipSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {
	mountHarness,
	buildBundle,
	startServer,
} from 'playwright-browser-harness';
import esbuild from 'esbuild';

const require = createRequire(import.meta.url);

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

const BACKENDS = [
	'ethereumjs-tuned',
	'ethereumjs-default',
	'tevm',
	'webevm',
	'webevm-trusted',
	'webevm-fabricated',
	// The node WITH the optional `webevm/revm` engine installed, on BOTH
	// halves of the seam: the configuration a consumer actually ships when they opt
	// into revm, and therefore the one the README's frame number has to come from.
	// Distinct from both neighbours: `webevm` is the same node on
	// `@ethereumjs/evm` (so the delta between them IS the engine swap), and `revm`
	// below is RAW revm owning its own state with no node in the path at all.
	'webevm-revm-engine',
	'revm',
] as const;

// The revm-wasm module ships prebuilt inside the `revm-wasm` package, so there is
// nothing to build and nothing to vendor: this is where the served copy comes
// from, and where the bundle-size row weighs it.
const revmWasmPath = require.resolve('revm-wasm/revm.wasm');

const TX_COUNT = 20;
const SUM_TO = 2000;
const EXPECTED_SUM = ((SUM_TO - 1) * SUM_TO) / 2; // 1999000
const KECCAK_ITERS = 2000;
// One simulated on-chain-game frame = this many small view reads back to back.
const FRAME_CALLS = 100;
const FRAME_BUDGET_MS = 16.6; // 60fps
// Cross-backend keccak correctness: every backend must produce the SAME chained
// keccak256 result. We don't hardcode the value — we assert all backends agree
// (and the first run pins it), which catches any keccak/abi.encodePacked drift.
let keccakReference: string | undefined;
// Cross-backend GAS equality. Every backend implements the same spec, so the same
// call MUST cost the same execution gas. This is the gate for ever replacing the
// interpreter (e.g. with a Rust/Zig wasm EVM): engines that disagree on gas
// disagree on where execution runs OUT of gas, so a client that replays the chain
// would fork. Matching return values is NOT sufficient — gas must match too.
const gasReference: Record<string, string> = {};

const collected: Record<string, unknown>[] = [];

/**
 * THE DEFAULT ENTRY POINT'S BUNDLE BASELINE, pinned deliberately.
 *
 * Story 3 of `work/specs/tasked/revm-engine-behind-eth-call.md` is "I pay
 * nothing for a feature I do not use": a consumer who imports
 * `webevm` and never `webevm/revm` must ship no revm. That
 * promise is only worth what enforces it, so these numbers are an ASSERTION and
 * not a printed row — measured with the esbuild config below, by
 * `revm-engine-subpath`, the change that added the subpath.
 *
 * WHAT THEY SAY, precisely: the same measurement immediately BEFORE that change
 * was 412.3 KB raw / 124.0 KB gzip, so adding a whole second EVM engine to the
 * package cost the default entry 0.1 KB — and that 0.1 KB is not revm. It is the
 * node-side `getBlockHash` accessor added to `EngineContext` (real core code,
 * a few lines in `node.ts`). Zero bytes of `revm-wasm` are in this graph, which
 * is what the metafile check below states directly.
 *
 * Re-pin DELIBERATELY when the default entry legitimately grows, in the same
 * change that grows it, and say why in the changeset. A red assertion here means
 * either that or an accidental import into the core graph.
 *
 * RE-PINNED FIFTEEN TIMES SINCE. Most recent first:
 *
 * 424.7 -> 424.8 KB raw / 128.4 -> 128.1 KB gzip, by
 * `one-request-at-a-time-the-node-serialises-its-whole-public-surface`: the node
 * now serves ONE request at a time. Reads and transactions open checkpoint levels
 * on the one state manager a node owns, `commit()` merges the top level down and
 * `revert()` discards it, and neither knows who opened it, so two overlapping
 * executions destroyed each other's writes while BOTH reported success (a lost
 * nonce that then refused every later transaction from that sender, state torn at
 * a message-frame boundary, an `eth_call` committing its own `SSTORE`, two
 * transactions handed the same block number). The 0.1 KB is the whole fix: a
 * promise-chain serialisation point in `src/node.ts` (`serialise`, the `swallow`
 * that keeps the chain alive across a failed request, the five wrappers on the
 * returned node, and a coalescing interval timer). It is in the CORE graph
 * because the dispatcher is, on every engine, and a lock inside either engine
 * would have covered only half of it. Note the gzip bound moved DOWN while raw
 * moved up: both are the measured numbers from a fresh build, and the change
 * deletes as well as adds (`persistIfNeeded` and the `mine` wrapper both got
 * smaller). It buys every consumer, JS-only included, the property a receipt is
 * supposed to have: if it is not reverted, the state moved, and it moved
 * CONSISTENTLY. See
 * `docs/adr/0012-one-request-at-a-time-the-node-serialises-its-whole-public-surface.md`.
 * Still zero bytes of `revm-wasm`.
 *
 * 422.5 -> 424.7 KB raw / 127.6 -> 128.4 KB gzip, by
 * `estimategas-returns-a-gas-limit-not-the-gas-consumed`: `eth_estimateGas` no
 * longer reports what a request CONSUMES, it SEARCHES for the smallest gas limit
 * the request succeeds at, because EIP-150's 63/64 rule makes consumption an
 * unusable limit for anything that calls out or creates (a deployment through the
 * standard CREATE2 factory mined `status: 0x0` at an estimate-sized limit). The
 * 2.2 KB is the search itself in `src/node.ts` (an upper-bound run, a
 * short-circuit probe at consumption, then a bracket-and-bisect loop), the
 * `Error(string)` revert-reason decoder that puts WHY into the failure, and the
 * prose of the two refusals it can now throw. It is in the CORE graph because
 * `eth_estimateGas` is, and it is the feature twice over: every consumer,
 * JS-only included, gets a number their transaction survives, and a request that
 * cannot succeed at any limit gets an error instead of one that cannot. Still
 * zero bytes of `revm-wasm`.
 *
 * (Pinned at 424.0 in that change and corrected to 424.7 immediately after, when
 * CI failed on it: the pin had been measured against a `dist/` predating the same
 * change's review round — the -32000 "gas required exceeds allowance" branch and
 * the revert-decoder's ABI head check, 0.7 KB of the 2.2. See the note on the
 * constant itself, which now says how to avoid repeating it.)
 *
 * 422.0 -> 422.5 KB raw / 127.4 -> 127.6 KB gzip, by
 * `the-rpc-block-and-the-evm-disagree-about-coinbase-and-prevrandao`: the RPC
 * block now reports the block the EVM actually ran. `miner` and `mixHash` are the
 * block's real coinbase and prevRandao instead of a constant zero and an absent
 * field, and `logsBloom` is the OR of the block's receipt blooms instead of 256
 * hard-coded zero bytes, so pre-filtering blocks by the header bloom stops
 * silently finding nothing. The 0.5 KB is `bloomOfReceipts` in `src/node.ts` (the
 * OR loop, reached from `storeBlock` and again from `loadState` to rebuild the
 * bloom of a dump too old to carry one), the three fields on the way into
 * `SerializedBlock` and out through `blockToRpc`, and the coinbase/mixHash
 * restoration in `loadState` — which is not cosmetic: `eth_call` executes against
 * the STORED block object, so before it a reloaded node handed contracts a zero
 * COINBASE / PREVRANDAO while its own mined blocks used the configured ones. It is
 * in the CORE graph because block construction and the RPC layer are the node's on
 * every engine, and it buys every consumer, JS-only included, a block that says
 * what it ran. Still zero bytes of `revm-wasm`.
 *
 * 421.9 -> 422.0 KB raw (gzip unchanged at 127.4), by
 * `prune-bottom-overlay-tombstones-and-align-the-quoted-speedup`: the BOTTOM
 * storage overlay now keeps no tombstones. One hides the slots overlays BELOW it
 * hold, and the bottom has none below, so the entry hid nothing and nothing ever
 * removed it — while `@ethereumjs/evm` calls `clearStorage` on every contract
 * creation, so a long-lived in-browser node kept one packed address key per
 * CREATE ever executed and re-walked all of them in `liveStorage()`, i.e. in
 * every `dumpState`. The 0.1 KB is two depth tests in `src/state-manager.ts`,
 * one in `commit()` and one in `clearStorageAt()` (the site the revm engine
 * reaches, since it commits through synchronous callbacks with no checkpoint
 * open). It is in the CORE graph for the same reason the four `state-manager.ts`
 * re-pins below are, and it buys that same default consumer a `'none'`-mode node
 * whose memory does not grow with the number of contracts it has ever created.
 * Still zero bytes of `revm-wasm`.
 *
 * 421.1 -> 421.9 KB raw / 127.1 -> 127.4 KB gzip, by
 * `revm-state-store-packed-storage-keys`: the `stateMode:'none'` storage key is
 * now PACKED (two bytes per UTF-16 code unit) instead of `0x`-hex, which takes a
 * cold revm storage access from 1.31-1.33 µs to 0.36-0.39 µs
 * (`docs/spikes/revm-state-store-packed-storage-keys/measurements.md`). The 0.8
 * KB is `src/storage-keys.ts`: two unrolled encoders (10 and 16 `String.fromCharCode`
 * arguments, which is most of the bytes), the inverse pair `liveStorage()` uses to
 * keep `dumpState` in hex, and a 256-entry hex table. It is in the CORE graph for
 * the same reason the three `state-manager.ts` re-pins below are — this IS the
 * default state manager's key format, so the async `putStorage` the DEFAULT engine
 * drives builds keys with it too, and it must be the SAME module the revm store
 * uses or the two routes into a slot could disagree silently. The JS-only consumer
 * pays 0.8 KB and gets a slightly cheaper `getStorage`; the revm consumer gets the
 * 3.4x. Still zero bytes of `revm-wasm`.
 *
 * 420.0 -> 421.1 KB raw / 126.7 -> 127.1 KB gzip, by
 * `sender-recovery-uses-the-engines-ecrecover`: in `senderMode:'recover'`, the
 * node now derives the sender with the ENGINE's `ecrecover` when the installed
 * engine offers one (`webevm/revm` does — the `0x01` precompile's own
 * secp256k1, already in the wasm module), and with `tx.getSenderAddress()` when it
 * does not. The 1.1 KB is `src/sender-recovery.ts`: the message hash, EIP-2's
 * low-`s` rule, the wire `v` -> 0/1 recovery id conversion, and the refusals for
 * each. It is in the CORE graph because deciding WHO SENT A TRANSACTION is the
 * node's on every engine — an engine is lent the curve step and never the
 * decision (`Engine.ecrecover` in `src/types.ts`) — and because a JS-only consumer
 * reaches the same module the moment they pass an engine that has one. What it
 * buys is 2.0 -> 0.66 ms per isolated transaction on a revm-backed node, ~3.0x,
 * with the recover-versus-trusted gap narrowing from ~6.2x to ~2.8x
 * (`docs/spikes/sender-recovery-uses-the-engines-ecrecover/measurements.md`).
 * Still zero bytes of `revm-wasm`.
 *
 * 419.7 -> 420.0 KB raw / 126.6 -> 126.7 KB gzip, by
 * `eip-2930-access-lists-are-charged-and-warmed`: `eth_estimateGas` now charges a
 * request's EIP-2930 access list (2,400 per address, 1,900 per storage key), as
 * geth does. It had ignored the field, so it answered 21,000 for a type-1
 * transaction whose intrinsic floor is 27,200 while the node's own intrinsic-gas
 * refusal was telling callers that `eth_estimateGas` reports what a transaction
 * needs: the node refused the number it had just recommended
 * (`docs/spikes/eip-2930-access-lists-are-charged-and-warmed/measurements.md`).
 * The 0.3 KB is the new `accessListGas` in `src/intrinsic-gas.ts` (a loop over the
 * request's entries), one term at the `eth_estimateGas` case, and the clause the
 * refusal gained. It is in the CORE graph because `eth_estimateGas` is, it is paid
 * by every consumer including the JS-only one, and it buys them an estimate their
 * client can use as a gas limit without being refused. Still zero bytes of
 * `revm-wasm`.
 *
 * 417.9 -> 419.7 KB raw / 126.0 -> 126.6 KB gzip, by
 * `replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors`: the
 * node now REFUSES a replayed nonce, a nonce it will never reach, a transaction
 * the sender cannot afford and a gas limit below intrinsic gas ITSELF, above the
 * seam, instead of letting whichever EVM is installed answer in its own words
 * (`Transaction(NonceTooLow { tx: 0, state: 1 })` on revm; the same rejection
 * plus a dump of the whole block on `@ethereumjs/vm`). The 1.8 KB is those four
 * refusals' prose in `src/node.ts` — the cause in geth's vocabulary, the numbers
 * behind it, and what to do about it — plus the three-line checks that produce
 * them. Prose in the core bundle, paid by every consumer including the JS-only
 * one, and it IS the feature, exactly as in the block-gas-limit re-pin below:
 * the alternative is a wasm-shaped string reaching a client. Still zero bytes of
 * `revm-wasm`.
 *
 * 417.8 -> 417.9 KB raw (gzip unchanged at 126.0), by
 * `revm-write-callbacks-reproduce-the-post-state`:
 * `OverlayStorageStateManager.deleteAccount` now clears the account's storage as
 * well, so a `SELFDESTRUCT` (or an EIP-161 empty-account clearing) in
 * `stateMode:'none'` stops leaving a dead contract's slots readable at its
 * address. The 0.1 KB is a two-line override; it is in the CORE graph for the
 * same reason the two `state-manager.ts` re-pins below are (this IS the default
 * state manager for `stateMode:'none'`, i.e. every consumer who passes no
 * options), and it buys that consumer post-state that agrees with a trie and with
 * the revm engine instead of disagreeing with both
 * (`docs/adr/0007-...`, amended 2026-08-10). Still zero bytes of `revm-wasm`.
 *
 * 417.2 -> 417.8 KB raw / 125.7 -> 126.0 KB gzip, by
 * `the-block-gas-limit-relaxation-diverges-by-engine`: the node now REFUSES a
 * transaction whose gas limit exceeds the block's, in its own words, instead of
 * telling `@ethereumjs/vm` to skip that check (the relaxation the revm engine
 * could not reproduce while committing, so the two engines answered differently).
 * The 0.6 KB is almost entirely that refusal's prose in `src/node.ts`: it names
 * the transaction's gas limit, the block gas limit it exceeded and
 * `blockGasLimit` as the knob that raises it, because neither EVM's own error
 * carries a number or knows the node option exists. Prose in the core bundle,
 * paid by every consumer including the JS-only one, and it IS the feature, for
 * the same reason the engine-refusal re-pin below was. Still zero bytes of
 * `revm-wasm`.
 *
 * 417.1 -> 417.2 KB raw (gzip unchanged at 125.7), by
 * `revm-executes-the-first-transaction-with-commit`: `Engine.transact` became
 * REQUIRED, so `src/engine.ts` lost the `transacts()` capability test and the
 * `TransactingEngine` type while `connectEngine` gained the refusal that replaces
 * them, and `src/node.ts` lost its `transacts(engine) ? engine : defaultEngine`
 * fallback. The 0.1 KB is net: deleted code minus a longer refusal message, which
 * is prose in the core bundle and is the feature (a node now runs ONE EVM, so
 * `node.engine` names the engine that answered its reads AND executed its
 * transactions). `src/state-manager.ts`'s two new synchronous storage-write
 * accessors are in the same graph and are a few lines each. Still zero bytes of
 * `revm-wasm`.
 *
 * 416.3 -> 417.1 KB raw / 125.4 -> 125.7 KB gzip, by
 * `re-widen-the-engine-seam-to-cover-transactions`: the engine seam widened from
 * reads to reads AND transactions, so `src/engine.ts` now also holds the default
 * engine's transaction operation (the `runTx` call the node used to make inline,
 * its result mapped into the seam's neutral `TransactionResult`, and the
 * legacy-safe `effectiveGasPrice` that moved down from `node.ts`) plus one more
 * construction refusal (an engine whose `transact` is present but is not a
 * function). The 0.8 KB is that mapping and that prose; the `runTx` import itself
 * is not new to the graph, because `node.ts` already had it. It is paid by every
 * consumer including the JS-only one, and it buys them the seam a second EVM plugs
 * into. Still zero bytes of `revm-wasm`.
 *
 * 413.7 -> 416.3 KB raw / 124.6 -> 125.4 KB gzip, by
 * `re-layer-storage-as-per-account-maps-with-per-frame-diffs`:
 * `src/state-manager.ts` re-layers `stateMode:'none'` storage as per-account maps
 * with per-checkpoint OVERLAYS, so a checkpoint stops copying the whole storage
 * map (four transactions at 100,000 slots: 18-28x across two runs, and FLAT in
 * state size — ~12 ms whether state holds 1,000 slots or 100,000). Read the
 * FLATNESS rather than either ratio: the 100,000-slot cell is the
 * allocation-heaviest in the file and moves tens of percent between runs, which
 * is why ADR 0009, the changeset and
 * `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/measurements.md`
 * all quote the range and say in as many words not to quote the single cell. The
 * 2.6 KB is the overlay walk, the commit merge, the two synchronous accessors the
 * revm store and `dumpState` read through, and the error text for the retired
 * flat `storageStack`. It has to be in the CORE graph for the same reason the
 * previous re-pin did: this IS the default state manager for `stateMode:'none'`,
 * which is every consumer who passes no options — and the growth buys that same
 * consumer that flatness. Still zero bytes of `revm-wasm`.
 *
 * 413.5 -> 413.7 KB raw (gzip unchanged at 124.6), by the `clearStorage` fix:
 * `src/state-manager.ts` subclasses `SimpleStateManager` to implement the
 * `clearStorage(address)` that `@ethereumjs/statemanager@10.1.2` ships as an empty
 * no-op, so a contract created at an address that already held storage no longer
 * inherits it. 0.2 KB, and it is a loop over the storage map plus its comment. It
 * has to be in the CORE graph because it is the default state manager for
 * `stateMode:'none'`, which is every consumer who passes no options. Still zero
 * bytes of `revm-wasm`.
 *
 * `engine-seam-docs-and-honest-edges`: 412.4 -> 413.5 KB
 * raw / 124.1 -> 124.6 KB gzip. The 1.1 KB is the text of the node's engine
 * refusals (`connectEngine` in `src/engine.ts`: a bad engine object, and an
 * engine whose `connect` throws, both fail construction rather than silently
 * falling back to the default engine). It is prose in the core bundle, paid by
 * every consumer including the JS-only one, and it is the feature: an error that
 * does not say what happened is the thing that change exists to remove. Still
 * zero bytes of `revm-wasm`.
 *
 * Raw bytes are esbuild-deterministic, so that bound is exact. The gzip bound
 * carries 1% of slack because the zlib shipped with different Node builds does
 * not compress byte-identically, which is noise rather than growth.
 *
 * MEASURE IT AGAINST A FRESH BUILD, and this is a trap that has already been
 * sprung once. The entry below is `import {createNode} from 'webevm'`,
 * which resolves through the package's `exports` map to **`dist/`** — not `src/`.
 * So a `src` change that has not been rebuilt is INVISIBLE here, and re-pinning
 * against a stale `dist` pins a number CI will not reproduce (it builds first).
 * That is exactly what happened to the 424.0 pin below: it was measured after
 * the estimate-gas search landed but before that change's review round, and CI
 * read 424.7. Run `pnpm build` before trusting this test, which is why the repo's
 * `verify` is `format:check && build && test`, in that order.
 */
const DEFAULT_ENTRY_BASELINE = {rawKB: 424.8, gzipKB: 128.1};
const GZIP_SLACK = 1.01;

// Build + serve once for the whole file (the cut contains all backends).
let prebuilt: {outdir: string; serverUrl: string};
let closeServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	const outdir = await mkdtemp(join(tmpdir(), 'evm-harness-'));
	await buildBundle({
		cut,
		outdir,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	// The backend fetches the module at runtime, so the .wasm has to sit next to
	// the bundle in the served directory.
	await copyFile(revmWasmPath, join(outdir, 'revm.wasm'));
	const srv = await startServer({root: outdir, coi: false});
	prebuilt = {outdir, serverUrl: srv.url};
	closeServer = srv.close;
});

test.afterAll(async () => {
	if (closeServer) await closeServer();
});

for (const backend of BACKENDS) {
	test(`backend ${backend}: deploy + ${TX_COUNT} state transitions + read + compute`, async ({
		page,
	}) => {
		const h = await mountHarness(page, {cut, coi: false, prebuilt});
		const r = await h.run({
			phase: 'once',
			params: {
				backend,
				txCount: TX_COUNT,
				sumTo: SUM_TO,
				keccakIters: KECCAK_ITERS,
				frameCalls: FRAME_CALLS,
				repeat: 7,
			},
		});

		console.log(`\n[${backend}] errors:`, r.errors);
		console.log(`[${backend}] results:`, JSON.stringify(r.results));
		console.log(`[${backend}] timings:`, JSON.stringify(r.timings));

		expect(r.errors).toEqual([]);
		expect(r.results.finalNumber).toBe(String(TX_COUNT));
		expect(r.results.computeResult).toBe(String(EXPECTED_SUM));

		// keccak256 chain result must be a 32-byte hash and IDENTICAL across all
		// backends (they all run the same EVM spec — divergence = a real bug).
		const keccak = r.results.keccakResult as string;
		expect(keccak).toMatch(/^0x[0-9a-f]{64}$/);
		if (keccakReference === undefined) keccakReference = keccak;
		else expect(keccak).toBe(keccakReference);

		// GAS EQUALITY across backends — the interpreter-swap gate (see gasReference).
		// Backends that don't expose execution gas simply skip; those that do must all
		// agree, exactly, for every probed call.
		for (const key of ['computeGas', 'keccakGas', 'readGas'] as const) {
			const got = r.results[key] as string | undefined;
			if (got === undefined) continue;
			expect(BigInt(got) > 0n).toBe(true);
			if (gasReference[key] === undefined) gasReference[key] = got;
			else
				expect(
					`${key}=${got}`,
					`backend ${backend} charged different gas for ${key} than the first backend — ` +
						`the engines disagree on the spec, which is a state-fork risk`,
				).toBe(`${key}=${gasReference[key]}`);
		}

		// NOTE: webevm's own honesty/correctness/conformance assertions
		// live in the library package's test suite (slim-node-checks, conformance,
		// statetest, viem-surface, persistence-reload). This benchmark only measures
		// the cross-backend perf + asserts keccak-chain equality above.

		const t = Object.fromEntries(r.timings.map((x) => [x.label, x.ms]));
		collected.push({
			backend,
			...t,
			framePerCallMs: t.frame != null ? t.frame / FRAME_CALLS : undefined,
			frameFitsIn60fps:
				t.frame != null ? t.frame <= FRAME_BUDGET_MS : undefined,
			computeMGasPerSec: r.results.computeMGasPerSec,
			keccakMGasPerSec: r.results.keccakMGasPerSec,
			computeGas: r.results.computeGas,
			keccakGas: r.results.keccakGas,
			keccakResult: r.results.keccakResult,
			legacyTxReceiptBite: r.results.legacyTxReceiptBite,
		});

		await h.dispose();
	});
}

// EVERY backend must actually RUN. A backend that silently drops out takes its
// gas row out of the gate above without failing anything, which is how a gate
// quietly stops being one. The revm row used to skip whenever its wasm was not
// vendored on the machine; it is an ordinary npm dependency now, so nothing here
// is conditional and this test says so out loud.
test('every backend contributed to the gate', () => {
	expect(collected.map((c) => c.backend)).toEqual([...BACKENDS]);
	const revm = collected.find((c) => c.backend === 'revm');
	expect(revm?.computeGas).toBe(gasReference.computeGas);
	expect(revm?.keccakGas).toBe(gasReference.keccakGas);
	expect(revm?.keccakResult).toBe(keccakReference);

	// THE NODE ON REVM is an ordinary backend under the same gate, and named
	// explicitly here for the same reason the raw `revm` row is: a swapped
	// interpreter is exactly the change this gate exists to catch, and the row it
	// runs in must not be able to drop out quietly. Its gas is compared against
	// the JS node and raw revm alike — they all sit in `gasReference`.
	const onRevm = collected.find((c) => c.backend === 'webevm-revm-engine');
	const jsNode = collected.find((c) => c.backend === 'webevm');
	expect(onRevm?.computeGas).toBe(gasReference.computeGas);
	expect(onRevm?.keccakGas).toBe(gasReference.keccakGas);
	expect(onRevm?.keccakResult).toBe(keccakReference);
	// ...stated the other way round too, because THIS is the pair a consumer
	// switches between with one option: the node on revm and the node on
	// @ethereumjs/evm must charge identical gas, or the swap forks a replay.
	expect(onRevm?.computeGas).toBe(jsNode?.computeGas);
	expect(onRevm?.keccakGas).toBe(jsNode?.keccakGas);
	expect(onRevm?.computeGas).toBe(revm?.computeGas);
	expect(onRevm?.keccakGas).toBe(revm?.keccakGas);
	expect(onRevm?.keccakResult).toBe(jsNode?.keccakResult);
});

test('bundle size per backend (raw + gzip)', async () => {
	const bufferEntry = require.resolve('buffer/');
	const sizes: Record<string, {rawKB: number; gzipKB: number}> = {};
	// The default entry's module graph, kept for the "revm is not in it" check.
	let defaultEntryInputs: string[] = [];
	for (const backend of BACKENDS) {
		// the trusted/fabricated rows are the SAME entry point as
		// 'webevm' (only a node option and the send path differ), so they
		// add no bytes and need no separate size entry. The revm-engine row DOES
		// import a second entry point (`webevm/revm`), but what it costs
		// is the `.wasm` — already weighed in its own row below, and fetched at
		// runtime, which esbuild cannot weigh anyway.
		if (backend.startsWith('webevm-')) continue;
		// revm's cost is the .wasm itself, reported separately below; esbuild cannot
		// weigh a module that is fetched at runtime.
		if (backend === 'revm') continue;
		const entry =
			backend === 'tevm'
				? `import {makeTevmBackend} from '${resolve(here, './helpers/backend-tevm.ts')}'; console.log(makeTevmBackend);`
				: backend === 'ethereumjs-default'
					? `import {makeEthereumjsDefaultBackend} from '${resolve(here, './helpers/backend-ethereumjs.ts')}'; console.log(makeEthereumjsDefaultBackend);`
					: backend === 'webevm'
						? `import {createNode} from 'webevm'; console.log(createNode);`
						: `import {makeEthereumjsTunedBackend} from '${resolve(here, './helpers/backend-ethereumjs.ts')}'; console.log(makeEthereumjsTunedBackend);`;
		const out = await esbuild.build({
			stdin: {contents: entry, resolveDir: here, loader: 'ts'},
			bundle: true,
			format: 'esm',
			target: 'es2022',
			platform: 'browser',
			minify: true,
			write: false,
			plugins: [
				{
					name: 'buf',
					setup(b) {
						b.onResolve({filter: /^(node:)?buffer$/}, () => ({
							path: bufferEntry,
						}));
						b.onResolve({filter: /^(node:)?process$/}, () => ({
							path: 'p',
							namespace: 's',
						}));
						b.onLoad({filter: /^p$/, namespace: 's'}, () => ({
							contents: 'export default {env:{},browser:true};',
							loader: 'js',
						}));
					},
				},
			],
			define: {global: 'globalThis'},
			metafile: true,
		});
		if (backend === 'webevm')
			defaultEntryInputs = Object.keys(out.metafile.inputs);
		const raw = out.outputFiles[0].contents;
		const gz = gzipSync(raw);
		sizes[backend] = {
			rawKB: +(raw.byteLength / 1024).toFixed(1),
			gzipKB: +(gz.byteLength / 1024).toFixed(1),
		};
	}
	const wasm = await readFile(revmWasmPath);
	sizes['revm (wasm module only)'] = {
		rawKB: +(wasm.byteLength / 1024).toFixed(1),
		gzipKB: +(gzipSync(wasm).byteLength / 1024).toFixed(1),
	};
	expect(sizes['revm (wasm module only)'].rawKB).toBeGreaterThan(0);

	console.log('\n=== bundle sizes ===\n', JSON.stringify(sizes, null, 2));

	// THE DEFAULT ENTRY HAS NOT GROWN. `webevm/revm` is a separate
	// entry point and the core references only the `Engine` TYPE (erased at
	// build time), so a consumer who does not opt in ships exactly what they
	// shipped before revm existed.
	expect(
		sizes['webevm'].rawKB,
		`the default entry point grew to ${sizes['webevm'].rawKB} KB raw (baseline ${DEFAULT_ENTRY_BASELINE.rawKB} KB) — ` +
			'either something was imported into the core graph, or the growth is intended and this baseline must be re-pinned in the same change',
	).toBeLessThanOrEqual(DEFAULT_ENTRY_BASELINE.rawKB);
	expect(sizes['webevm'].gzipKB).toBeLessThanOrEqual(
		DEFAULT_ENTRY_BASELINE.gzipKB * GZIP_SLACK,
	);
	// ...and revm is not in its dependency graph AT ALL. The size bound alone
	// would not catch a small accidental import; this names the thing.
	const revmInputs = defaultEntryInputs.filter((p) => p.includes('revm-wasm'));
	expect(
		revmInputs,
		"`revm-wasm` reached the default entry point's module graph; it belongs to the `webevm/revm` subpath only",
	).toEqual([]);
	expect(defaultEntryInputs.length).toBeGreaterThan(0);
	console.log(
		'\n=== collected timings ===\n',
		JSON.stringify(collected, null, 2),
	);

	// Throughput table. MGas/s is the backend-independent unit: comparable across
	// engines AND to published evmone/revm/geth figures, unlike wall-clock ms which
	// only means something for this exact contract.
	console.log('\n=== interpreter throughput + frame budget ===');
	console.log(
		'backend'.padEnd(20) +
			'compute'.padStart(14) +
			'keccak'.padStart(14) +
			'frame/call'.padStart(13) +
			'floor/call'.padStart(13) +
			'  60fps?',
	);
	for (const c of collected) {
		const n = (v: unknown, d = 2) =>
			typeof v === 'number' ? v.toFixed(d) : String(v ?? '-');
		console.log(
			String(c.backend).padEnd(20) +
				`${n(c.computeMGasPerSec)} MGas/s`.padStart(14) +
				`${n(c.keccakMGasPerSec)} MGas/s`.padStart(14) +
				`${n(c.framePerCallMs, 3)} ms`.padStart(13) +
				`${n(c.floor, 3)} ms`.padStart(13) +
				`  ${c.frameFitsIn60fps ? 'yes' : 'NO'}`,
		);
	}
	console.log(
		`\nframe = ${FRAME_CALLS} small view reads back to back; 60fps budget = ${FRAME_BUDGET_MS} ms/frame`,
	);

	// THE FRAME NUMBER THE README CITES, spelled out rather than left to be read
	// off the table above. The figures this whole feature is justified by were
	// measured on RAW backends; what a consumer actually gets is the `embedded-
	// eth-node-revm-engine` row, because the node's own dispatch overhead becomes
	// the dominant term once the interpreter stops being it.
	//
	// REPORTED, NOT ASSERTED. Timing rows are load-sensitive, this suite runs on a
	// shared runner, and WebKit clamps `performance.now()` to 1 ms. Only gas
	// equality, keccak equality and the scenario results are assertions here.
	console.log(
		'\n=== frame budget: the number to cite (REPORTED, not asserted) ===',
	);
	for (const key of ['webevm', 'webevm-revm-engine', 'revm'] as const) {
		const c = collected.find((x) => x.backend === key);
		const ms = typeof c?.frame === 'number' ? c.frame : undefined;
		console.log(
			`${key.padEnd(32)}${ms === undefined ? '     -' : ms.toFixed(1).padStart(6)} ms / ${FRAME_BUDGET_MS} ms` +
				(ms === undefined
					? ''
					: `  (${((ms / FRAME_BUDGET_MS) * 100).toFixed(0)}% of the frame budget)`),
		);
	}
});
