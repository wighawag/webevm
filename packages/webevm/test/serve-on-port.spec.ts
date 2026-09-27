/**
 * serve-on-port.spec.ts: a node SERVES its EIP-1193 `request` on a `MessagePort`
 * it is handed (`node.serveOn(port)`), so a consumer in ANOTHER worker (an
 * indexer, say) uses it through `@eip-1193/over-port`'s `providerOverPort`,
 * worker to worker, with the page relaying nothing after the hand-off.
 *
 * One worker module plays both the node worker and the consumer worker
 * (./helpers/serve-on-port-worker.ts), because a harness serves one worker entry.
 * The page-side driver (./helpers/serve-on-port.ts) runs the same battery against
 * a worker-hosted node and a main-thread node, since the call exists on
 * `SlimNode` precisely so the two stay interchangeable.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const worker = resolve(here, './helpers/serve-on-port-worker.ts');

const CHAIN_ID_HEX = '0x7a69';

function expectTheBattery(r: any) {
	// Answered over the handed port.
	expect(r.firstAnswer).toEqual({outcome: 'ANSWERED', result: CHAIN_ID_HEX});
	// An error the node raises crosses with its code and message.
	expect(r.unsupported.outcome).toBe('REJECTED');
	expect(r.unsupported.code).toBe(-32601);
	expect(r.unsupported.message).toContain('method not found: eth_notAMethod');
	// Two ports served at once: both answer.
	expect(r.twoPorts.first).toEqual({outcome: 'ANSWERED', result: '0x0'});
	expect(r.twoPorts.second).toEqual({outcome: 'ANSWERED', result: '0x0'});
	// A served port can be stopped, and stopping one leaves the other served.
	expect(r.afterStop.stopped).toEqual({outcome: 'NO_ANSWER'});
	expect(r.afterStop.stillServed).toEqual({
		outcome: 'ANSWERED',
		result: CHAIN_ID_HEX,
	});
}

test('a node serves EIP-1193 on a handed MessagePort, worker-hosted and main-thread alike', async ({
	page,
	browserName,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'serve-on-port', workerUrl},
	});

	console.log('\n[serve-on-port] errors:', r.errors);
	console.log('[serve-on-port]', JSON.stringify(r.results, null, 2));
	expect(r.errors).toEqual([]);

	const fromWorker = r.results.worker as any;
	expectTheBattery(fromWorker);
	// WORKER TO WORKER: the consumer was answered over and over while not one
	// message crossed the page's handles on either worker. The page relays nothing.
	expect(fromWorker.answeredWhilePageFree).toBeGreaterThan(10);
	expect(fromWorker.pageMessagesWhileServing).toBe(0);
	expect(fromWorker.pageMessagesBefore).toBeGreaterThan(0);
	expect(fromWorker.loopResults).toEqual([CHAIN_ID_HEX]);
	// ...and on Chromium, the stronger form: answers kept coming while the page's
	// thread was held in a busy loop. WebKit routes worker-to-worker port traffic
	// through the main thread INSIDE the engine (no page code involved), so there a
	// blocked page stalls it; the figure is reported, not asserted. See
	// ./helpers/serve-on-port.ts.
	console.log(
		`[serve-on-port] ${browserName}: answered while page blocked:`,
		fromWorker.answeredWhilePageBlocked,
	);
	if (browserName === 'chromium') {
		expect(fromWorker.answeredWhilePageBlocked).toBeGreaterThan(1);
	}

	const fromMainThread = r.results.mainThread as any;
	expectTheBattery(fromMainThread);
	// `dispose()` stops every port the node was serving.
	expect(fromMainThread.afterDispose).toEqual({outcome: 'NO_ANSWER'});

	await h.dispose();
});
