/**
 * worker-node-factory.spec.ts: `exposeNode({createNode})`, the worker host's
 * optional NODE FACTORY, in a real browser.
 *
 * WHY IT EXISTS: a layer that funds dev accounts AT GENESIS (`@webevm/devnode`,
 * ADR 0017) must take part in creating the node inside the worker, and must do
 * it without a second worker host, since the thread-crossing proxy is singular
 * (CONTEXT.md, *worker host*). So the factory is held to the same bars as the
 * default worker: the node it returns is what the main thread drives, member for
 * member, and a misuse of it is a VALUE that rejects the main thread (both
 * signals), never a hang. Without the option nothing changes, which
 * `worker.spec.ts` keeps proving untouched.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const factoryWorker = resolve(here, './helpers/node-factory-worker.ts');

test('a createNode factory makes the node the main thread drives, and its misuse rejects (never hangs)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: factoryWorker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'node-factory', workerUrl},
	});

	console.log('\n[node-factory] errors:', r.errors);
	console.log('[node-factory]', JSON.stringify(r.results, null, 2));
	expect(r.errors).toEqual([]);

	// 1. THE FACTORY'S NODE IS THE ONE DRIVEN. Every method reached the decorator
	// the factory returned (dispose is called after the probe, so it is not listed),
	// its own `engine` value crossed, and the parity check finds no gap.
	const members = r.results.members as any;
	expect(members.beforeDispose.called).toEqual(
		[
			'dumpState',
			'getStateRoot',
			'loadState',
			'mine',
			'onNewHead',
			'request',
			'serveOn',
		].sort(),
	);
	expect(members.engineId).toBe('factory:@ethereumjs/evm');
	expect(members.senderMode).toBe('recover');
	expect(members.computeStateRoot).toBe(false);
	expect(members.chainId).toBe('0x7a69');
	// The genesis the main thread asked for, created by the factory's call.
	expect(BigInt(members.balance)).toBe(10n ** 18n);
	expect(r.results.shapeGaps).toEqual([]);

	// 2. WHAT THE FACTORY RECEIVED: the main thread's options, and the engine only
	// when `createEngine` is set (then exactly the one it built).
	expect(r.results.withoutEngine).toEqual({
		chainId: 31337,
		initialBalances: ['0x00000000000000000000000000000000000000f1'],
		hasEngine: false,
		engineId: null,
		engineIsTheBuiltOne: false,
	});
	expect(r.results.withEngine).toEqual({
		chainId: 31337,
		initialBalances: ['0x00000000000000000000000000000000000000f1'],
		hasEngine: true,
		engineId: 'sentinel-engine',
		engineIsTheBuiltOne: true,
	});

	// 3. THE FAILURES REJECT, never hang. 'NEVER_SETTLED' would be the hang.
	const notAFunction = r.results.notAFunction as {
		outcome: string;
		message: string;
	};
	expect(notAFunction.outcome).toBe('REJECTED');
	expect(notAFunction.message).toContain('worker-host');
	expect(notAFunction.message).toContain('`createNode` must be a FUNCTION');
	expect(notAFunction.message).toContain('an object');

	const rejects = r.results.rejects as {outcome: string; message: string};
	expect(rejects.outcome).toBe('REJECTED');
	expect(rejects.message).toContain(
		'node-factory-worker: this factory rejects',
	);

	// ...and the non-function one is said EARLY too, without a throw.
	const early = r.results.early as {reported: string; threw: string};
	expect(early.threw).toBe('DID_NOT_THROW');
	expect(early.reported).toContain('`createNode` must be a FUNCTION');
	expect(early.reported).toContain('worker-host');

	await h.dispose();
});
