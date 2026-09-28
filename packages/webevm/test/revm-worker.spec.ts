/**
 * revm-worker.spec.ts: the ONE combination the README recommends and nothing
 * used to run: `webevm/revm` INSIDE a Worker, driven from the main
 * thread by the ordinary `createWorkerNode()` client.
 *
 * `createWorkerNode({engine})` is refused (an engine is a function-bearing object
 * holding thread-bound live state, and the options are structured-cloned), so the
 * supported shape is the consumer's OWN worker module: build the engine there and
 * hand it to `exposeNode({createEngine})` from `webevm/worker-host`,
 * which supplies the node, the `SlimNode` proxy and the comlink `expose()` that
 * this file used to have to hand-copy. That module is ./helpers/revm-worker.ts,
 * now four lines, and it imports `webevm/worker-host` /
 * `webevm/revm` BY PACKAGE NAME, so this spec also exercises the
 * published export map the way a consumer resolves it.
 *
 * The SECOND test here drives the same recipe MISTYPED (the promise where the
 * factory belongs), because the option this recipe rests on is only as good as
 * what it does when a consumer gets it wrong.
 *
 * What is proven here, and why each part is needed:
 *   - the engine identity crossing the boundary reads `revm-wasm`, not the
 *     default engine's id (necessary, but weak on its own: it is what the node
 *     was BUILT with);
 *   - the REFERENCE GAS measured THROUGH the Worker is exact. That is the strong
 *     evidence: those figures are identical across backends and a silent fall
 *     back to `@ethereumjs/evm` would still produce them, but a revm engine that
 *     failed to come up cannot produce them at all, because `createNode()` has no
 *     fallback path, so the recipe either runs revm or throws;
 *   - a committing TRANSACTION lands across the boundary and the state it wrote
 *     is readable back through the node's own surface;
 *   - the main thread stays responsive while the Worker computes, asserted as a
 *     load-invariant RATIO in one window on one clock (never a fixed millisecond
 *     bound, since WebKit clamps `performance.now()` to 1 ms; see worker.spec.ts).
 *
 * The integration risk this spec was written to find: the harness bundles the
 * page and the worker SEPARATELY (two esbuild entry points), and the revm `.wasm`
 * needs the `binary` loader to be an asset rather than a module the browser
 * refuses. It reaches BOTH entry points (one `esbuild.build()` call, one loader
 * map), so the bundler-resolved delivery shape works unchanged inside a Worker.
 * Recorded in docs/spikes/prove-the-revm-in-a-worker-recipe-the-readme-recommends/.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
// The revm cut (this bundle carries the `.wasm`; see helpers/cut-revm.ts)...
const cut = resolve(here, './helpers/cut-revm.ts');
// ...and the CONSUMER'S own worker module, which is what makes revm reachable
// from a Worker at all. `src/worker-entry.ts` deliberately builds no engine.
const workerEntry = resolve(here, './helpers/revm-worker.ts');
// ...and the same module with the recipe's one plausible typo in it, driven by
// the second test. A separate mount, because a harness serves ONE worker entry.
const misusedEngineWorker = resolve(
	here,
	'./helpers/revm-misused-engine-worker.ts',
);

/**
 * Reference execution gas, identical on `@ethereumjs/evm` and revm-wasm, and
 * therefore identical on whichever THREAD runs them. Pinned here as well as in
 * revm-engine.spec.ts on purpose: these numbers are what say revm EXECUTED,
 * rather than merely loaded, so this spec must state them itself.
 */
const REF = {
	number: '2446',
	sumTo2000: '498689',
	keccakLoop2000: '1107052',
	keccakResult:
		'0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a',
};

test('revm in a Worker: the README recipe, executed', async ({page}) => {
	const h = await mountHarness(page, {
		cut,
		worker: workerEntry,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// THE UNKNOWN THIS SPEC EXISTS TO SETTLE: the same `.wasm` loader the
		// main-thread revm specs use, applied to a build whose SECOND entry point is
		// the Worker. The harness's built-in loader is `copy`, which leaves a real
		// module import the browser refuses to execute (`MIME type application/wasm`).
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'revm-worker', workerUrl, sumTo: 50000},
	});

	console.log('\n[revm-worker] errors:', r.errors);
	const c = r.results.revmWorker as Record<string, any>;
	console.log('[revm-worker]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// ---- the engine that answered lives in the WORKER, and it is revm ----
	expect(c.engineId).toBe('revm-wasm');
	expect(c.computeStateRoot).toBe(false);
	expect(c.senderMode).toBe('recover');
	// ...and a `computeStateRoot` node built INSIDE the Worker is revm too, with a real
	// root crossing the boundary (revm used to refuse it, as trie mode; the trie is now
	// derived from the flat state, ADR 0014).
	expect(c.trieServed.engineId).toBe('revm-wasm');
	expect(c.trieServed.computeStateRoot).toBe(true);
	expect(c.trieServed.root).toMatch(/^0x[0-9a-f]{64}$/);
	expect(BigInt(c.trieServed.root)).not.toBe(0n);

	// ---- IT RAN: the reference gas, measured THROUGH the Worker ----
	// An engine id is what the node was built with; these are what it computed.
	expect(c.executionGas.number).toBe(REF.number);
	expect(c.executionGas.sumTo2000).toBe(REF.sumTo2000);
	expect(c.executionGas.keccakLoop2000).toBe(REF.keccakLoop2000);
	expect(c.callResults.keccakLoop2000).toBe(REF.keccakResult);

	// ---- a COMMITTING transaction crossed the boundary ----
	// Not only an `eth_call`: a signed transaction was executed and committed by
	// revm in the Worker, and its state is readable back through the node's own
	// surface afterwards (three independent readings of the same commit).
	expect(c.deployStatus).toBe('0x1');
	expect(c.txStatus).toBe('0x1');
	expect(c.numberAfterTx).toBe('20');
	expect(BigInt(c.storageAfterTx)).toBe(20n);
	expect(BigInt(c.senderNonceAfterTx)).toBe(21n);
	// ...and the money moved, which no receipt field can fake: the sender paid
	// for every one of those transactions.
	expect(c.senderPaid).toBe(true);

	// ---- the main thread stayed responsive while revm computed ----
	const t = Object.fromEntries(r.timings.map((x: any) => [x.label, x.ms]));
	console.log(
		'[revm-worker] main-thread max gap during Worker compute (ms):',
		t.mainThreadMaxGap,
		'| samples:',
		c.mainThreadSampleCount,
		'| worker compute (ms):',
		t.workerCompute,
	);
	// THE PROPERTY, exactly as worker.spec.ts states it: a BLOCKED main thread
	// cannot run the sampler at all, so "the sampler fired many times during the
	// compute" proves it on no clock at all. The companion bar is a RATIO of two
	// figures measured in the SAME window on the SAME clock, never a fixed
	// millisecond bound (WebKit clamps `performance.now()` to 1 ms and a fixed
	// bound reddened this gate before).
	expect(c.mainThreadSampleCount).toBeGreaterThan(10);
	expect(t.mainThreadMaxGap).toBeLessThan(t.workerCompute / 3);

	await h.dispose();
});

/**
 * THE RECIPE MISTYPED, on the engine whose factory makes the typo likely: the
 * parentheses are already in `createRevmEngine({wasm})`, so dropping the arrow
 * reads harmless and passes the PROMISE where the factory belongs. That misuse
 * used to leave `createWorkerNode()` pending forever (the refusal threw before
 * `expose()` could register a listener, so the worker answered nothing), with the
 * explanation confined to the worker's console. It must reach the caller.
 *
 * The `await` form of the same mistake is NOT tested here and cannot be fixed
 * here: a top-level `await` before `exposeNode()` loses the main thread's first
 * message on Chromium and WebKit alike, whatever the refusal does. See
 * `work/notes/observations/a-top-level-await-in-a-worker-module-loses-the-first-message.md`,
 * and the hazard is documented on `exposeNode` and in the README's Worker section.
 */
test('revm in a Worker: the recipe mistyped rejects the caller, and does not hang it', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: misusedEngineWorker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'engine-misuse', workerUrl},
	});

	console.log('\n[revm engine-misuse] errors:', r.errors);
	console.log('[revm engine-misuse]', JSON.stringify(r.results, null, 2));
	expect(r.errors).toEqual([]);

	const main = r.results.mainThread as {outcome: string; message: string};
	expect(main.outcome).toBe('REJECTED');
	expect(main.message).toContain('createEngine');
	expect(main.message).toContain('worker-host');
	// The PROMISE case is named as itself: a consumer who wrote
	// `createEngine: createRevmEngine({wasm})` is told that is what they did, and
	// shown both forms, rather than being told "not a function" about a value they
	// can see is one call away from being right.
	expect(main.message).toMatch(/promise/i);
	expect(main.message).toContain('() => createRevmEngine({wasm})');

	// The worker still says it at the moment it happens, without throwing (a throw
	// there is exactly what used to strand the main thread).
	const early = r.results.early as {reported: string; threw: string};
	expect(early.threw).toBe('DID_NOT_THROW');
	expect(early.reported).toMatch(/promise/i);

	await h.dispose();
});
