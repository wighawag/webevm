/**
 * console-log-node.spec.ts: `createNode({consoleLog: consoleLog()})` delivers
 * every console call made during a mined transaction or an `eth_call` to the
 * sink and to `onConsoleLog`, as a structured entry, and changes nothing about
 * execution. Driven through the public surface (helpers/console-log-node.ts):
 * the precompiled `ConsoleLogProbe` deployed and called with viem-signed
 * transactions. The engine-dependent assertions are in
 * ./console-log-node-expected.ts, which revm-console-log-node.spec.ts holds
 * `webevm/revm` to as well; the re-entrancy case is in concurrency.spec.ts.
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertConsoleLogNode} from './console-log-node-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const workerEntry = resolve(here, '../src/worker-entry.ts');

test('console.log is delivered from transactions and eth_call, and observed only', async ({
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
		params: {mode: 'console-log-node', workerUrl},
	});
	console.log('\n[console-log-node] errors:', r.errors);
	const c = r.results.consoleLogNode as Record<string, any>;
	console.log('[console-log-node]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	// ---- 1-5, 7 and 9 (the real fixture): shared with the revm spec ----
	expect(c.automine.engineId).toBe('@ethereumjs/evm');
	assertConsoleLogNode(c);

	// ---- 6. an engine that declares recording and returns none ----
	for (const key of ['call', 'send']) {
		expect(c.lyingEngine[key], key).toMatch(
			/^THREW webevm: the engine 'test-records-nothing' declares that it records calls/,
		);
	}

	// ---- 8. a worker-hosted node refuses, synchronously ----
	expect(c.worker.threw).toMatch(
		/^webevm\/worker-client: onConsoleLog .*`consoleLog` option/,
	);
	expect(c.worker.threw).toContain('exposeNode({createConsoleLog:');
	expect(c.worker.returnedSomething).toBe(false);

	// ---- 9. estimation on a stub whose search takes many probes ----
	const e = c.estimation;
	// a search of many probes: ONE recorded execution, the first, at the top
	for (const method of ['eth_estimateGas', 'eth_fillTransaction']) {
		const none = e.stub.none[method];
		const first = e.stub.first[method];
		expect(first.calls, method).toBeGreaterThan(5);
		expect(first.calls, method).toBe(none.calls);
		expect(first.gas, method).toBe(e.stubAnswerExpected);
		expect(none.gas, method).toBe(e.stubAnswerExpected);
		expect(none.recordedAt, method).toEqual([]);
		expect(none.entries, method).toEqual([]);
		expect(first.recordedAt, method).toEqual([1]);
		expect(first.entries, method).toEqual([
			{
				args: ['probe with budget', first.topBudget],
				message: `probe with budget ${first.topBudget.slice(0, -1)}`,
				source: method,
			},
		]);
	}
	// any other value is refused, by consoleLog() and by the node
	expect(e.refusedValue).toMatch(
		/^THREW webevm: consoleLog\(\{estimateGas\}\) must be 'none' \(the default\) or 'first'; got 'all'/,
	);
	expect(e.refusedObject).toMatch(
		/^THREW webevm: consoleLog must be the object consoleLog\(\) returns.*estimateGas of 'none' or 'first'/,
	);
});
