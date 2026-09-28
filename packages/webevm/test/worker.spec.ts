/**
 * worker.spec.ts — proves the OPTIONAL comlink Worker story for the slim node in
 * a real Chromium:
 *   - createWorkerNode() returns the SAME {request, mine, ...} API as createNode()
 *     (interchangeable one-liners; consumer picks the thread);
 *   - a viem walletClient/publicClient drives the node ACROSS the Worker boundary
 *     unchanged (signed eth_sendRawTransactionSync, eth_call);
 *   - the main thread stays NON-BLOCKING while the Worker runs heavy compute
 *     (heavy EVM compute that would otherwise stall the main thread);
 *   - the node's `engine` identity ROUND-TRIPS across the boundary (it is a
 *     plain value on purpose, and nothing else asserted it survived).
 *
 * The harness bundles the page (the `cut`) AND the package's worker-entry (the
 * comlink `expose()` side) with the same Node polyfills, serving the worker as
 * `worker.js`; we hand the page its URL via params.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const workerEntry = resolve(here, '../src/worker-entry.ts');
// ...and the worker module that gets `createEngine` WRONG, driven by the test
// below. A second mount, because a harness serves ONE worker entry point.
const misusedEngineWorker = resolve(here, './helpers/misused-engine-worker.ts');

test('slim-node over a comlink Worker: same API + main-thread non-blocking', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: workerEntry,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'worker', workerUrl, sumTo: 50000},
	});

	console.log('\n[worker] errors:', r.errors);
	console.log('[worker] results:', JSON.stringify(r.results));
	console.log('[worker] timings:', JSON.stringify(r.timings));

	expect(r.errors).toEqual([]);
	// 20 increments across the Worker boundary landed:
	expect(r.results.number).toBe('20');
	// the engine identity survived the comlink boundary as a plain value
	expect(r.results.engineId).toBe('@ethereumjs/evm');
	// ...and so did every OTHER plain SlimNode field the worker-entry proxy
	// forwards. `senderMode` was silently absent from that proxy until
	// 2026-08-01, reading as `undefined` on a property typed
	// `'recover' | 'trusted'`; worker-client's `as any` hid it from the compiler
	// and nothing here asserted it. Assert the CLASS, not just the instance.
	expect(r.results.senderMode).toBe('recover');
	expect(r.results.computeStateRoot).toBe(false);
	// ...and the SAME question with no field named at all: the Worker-backed node
	// is compared field for field against a main-thread `createNode()`, so a field
	// added to `SlimNode` after this line was written is covered by it. This is the
	// runtime half of the guard against the `senderMode` recurrence; the
	// compile-time half is that the ONE proxy (src/worker-host.ts) is typed
	// `SlimNode`, so dropping a field there stops building.
	expect(r.results.shapeGaps).toEqual([]);

	const t = Object.fromEntries(r.timings.map((x: any) => [x.label, x.ms]));
	console.log(
		'[worker] main-thread max gap during Worker compute (ms):',
		t.mainThreadMaxGap,
		'| samples:',
		r.results.mainThreadSampleCount,
		'| worker compute (ms):',
		t.workerCompute,
	);

	// THE PROPERTY: the heavy compute ran in the Worker, so the main thread kept
	// running throughout. A BLOCKED main thread cannot run the sampler at all, so
	// "the sampler fired many times during the compute" proves it on no clock at
	// all, which is what makes this load-invariant.
	//
	// We deliberately do NOT assert a raw millisecond bound on the max gap. WebKit
	// clamps `performance.now()` to 1 ms (and `setTimeout(…, 0)` is clamped too),
	// so the gap quantises to integers and a fixed bound sits one quantum away from
	// a coin flip: the previous `toBeLessThan(15)` returned exactly 15 on WebKit and
	// reddened the acceptance gate for a change that touched no executable code.
	// The repo's stance everywhere else (CI comments, benchmark config) is that
	// wall-clock numbers are reported, not asserted; this now matches it.
	expect(r.results.mainThreadSampleCount).toBeGreaterThan(10);
	// And the stall was nothing like the compute it overlapped: a wide-margin
	// RATIO of two figures measured in the SAME window on the SAME clock, so load
	// inflates both together (unlike a fixed bound, or a ratio across two runs).
	expect(t.mainThreadMaxGap).toBeLessThan(t.workerCompute / 3);

	await h.dispose();
});

/**
 * THE FAILURE THAT USED TO BE A NON-EVENT. A worker module that hands
 * `exposeNode()` an engine where its factory belongs was refused with a real
 * message, thrown while the module was still EVALUATING, so `expose()` never
 * ran, no message listener was ever registered, and the main thread's
 * `createWorkerNode()` stayed pending forever. The consumer saw a hang and the
 * explanation reached only the worker's console, which in a bundled app is easy
 * to miss entirely: the least legible failure available, from the refusal added
 * to make a failure legible.
 *
 * So the refusal is a VALUE now, not control flow: `exposeNode()` still exposes,
 * and `createNode()` rejects with the recorded reason. Both threads say
 * something, which is the bar: neither is left guessing.
 */
test('a misused createEngine REJECTS the main thread (it never hangs it)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: misusedEngineWorker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'engine-misuse', workerUrl},
	});

	console.log('\n[engine-misuse] errors:', r.errors);
	console.log('[engine-misuse]', JSON.stringify(r.results, null, 2));
	expect(r.errors).toEqual([]);

	const main = r.results.mainThread as {outcome: string; message: string};
	// THE REGRESSION BAR, stated as the ending rather than as a timeout: 'REJECTED'
	// is the only acceptable one. 'NEVER_SETTLED' is the hang coming back.
	expect(main.outcome).toBe('REJECTED');
	// ...and the reason CROSSED the boundary, rather than staying in the worker's
	// console. A caller reading this message knows what they did and what to write.
	expect(main.message).toContain('createEngine');
	expect(main.message).toContain('worker-host');
	expect(main.message).toMatch(/function/i);
	expect(main.message).toContain('() => createRevmEngine({wasm})');

	// The EARLY signal is still there: the worker reports the mistake at the moment
	// it is made, and (the part that fixes the hang) does not throw doing it.
	const early = r.results.early as {reported: string; threw: string};
	expect(early.threw).toBe('DID_NOT_THROW');
	expect(early.reported).toContain('createEngine');
	expect(early.reported).toContain('worker-host');

	await h.dispose();
});
