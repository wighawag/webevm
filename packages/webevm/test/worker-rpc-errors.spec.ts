/**
 * worker-rpc-errors.spec.ts: a node hosted in a Worker (`createWorkerNode`)
 * rejects with the SAME error a main-thread node (`createNode`) rejects with:
 * same `code`, `message` and `data`, and a real `RpcError` on the main thread.
 * comlink alone carries only an Error's message across, which lost every code
 * and every revert payload (`src/worker-rpc-error.ts` has why and how).
 *
 * The worker is the package's own `worker-entry`, as a consumer would use it.
 * The driver is ./helpers/worker-rpc-errors.ts.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const workerEntry = resolve(here, '../src/worker-entry.ts');

test('a worker-hosted node rejects with the same RpcError (code, message, data) as a main-thread node', async ({
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
		params: {mode: 'worker-rpc-errors', workerUrl},
	});

	console.log('\n[worker-rpc-errors] errors:', r.errors);
	const t = r.results.errors as any;
	console.log('[worker-rpc-errors]', JSON.stringify(t, null, 2));
	expect(r.errors).toEqual([]);

	// Each failure is really the RpcError it is meant to be on the MAIN THREAD
	// (not vacuous), and the worker's is the same error, field for field.
	const expectedCodes: Record<string, number> = {
		'reverted eth_call (custom error)': 3,
		'historical read below the head, no stateHistory': -32000,
		'unknown block hash': -32000,
		'unknown method': -32601,
		'malformed params': -32602,
		'getStateRoot without computeStateRoot': -32004,
	};
	expect(Object.keys(t.cases).sort()).toEqual(
		Object.keys(expectedCodes).sort(),
	);
	for (const [name, code] of Object.entries(expectedCodes)) {
		const {mainThread, worker} = t.cases[name];
		expect(mainThread.outcome, name).toBe('REJECTED');
		expect(mainThread.isRpcError, name).toBe(true);
		expect(mainThread.code, name).toBe(code);
		// THE PROPERTY: the worker-hosted node's refusal is the same RpcError.
		expect(worker, name).toEqual(mainThread);
		expect(worker.name, name).toBe('RpcError');
	}

	// The revert carries its payload across: the ABI-encoded custom error.
	const revert = t.cases['reverted eth_call (custom error)'];
	expect(revert.mainThread.data).toBe(t.expectedRevertData);
	expect(revert.worker.data).toBe(t.expectedRevertData);

	// ...so viem decodes the custom error through a worker node exactly as it
	// does through a main-thread one.
	expect(t.viem.mainThread).toEqual({
		reverted: true,
		errorName: 'Nope',
		args: ['42'],
		raw: t.expectedRevertData,
	});
	expect(t.viem.worker).toEqual(t.viem.mainThread);

	// A plain Error is still a plain Error with its message, not an RpcError.
	const plain = t.plainError;
	expect(plain.mainThread.outcome).toBe('REJECTED');
	expect(plain.mainThread.isRpcError).toBe(false);
	expect(plain.worker.outcome).toBe('REJECTED');
	expect(plain.worker.isError).toBe(true);
	expect(plain.worker.isRpcError).toBe(false);
	expect(plain.worker.code).toBeUndefined();
	expect(plain.worker.name).toBe(plain.mainThread.name);
	expect(plain.worker.message).toBe(plain.mainThread.message);

	await h.dispose();
});
