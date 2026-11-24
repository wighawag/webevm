/**
 * console-log.spec.ts: `onConsoleLog` and the `consoleLog` option pass through
 * the dev node unchanged (ADR 0017: every member the layer does not override
 * delegates). The battery is helpers/console-log-checks.ts, on the default
 * engine (the only one that records calls today).
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {getAddress} from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('onConsoleLog and the consoleLog option pass through the dev node', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'console-log'}});
	console.log('\n[console-log] errors:', r.errors);
	const c = r.results.consoleLog as Record<string, any>;
	console.log(
		'[console-log]',
		JSON.stringify(c ?? null, null, 2).slice(0, 4000),
	);
	expect(r.errors).toEqual([]);

	const sender = getAddress(c.sender);
	const tx = (x: {
		hash: string;
		blockNumber: number;
		blockHash: string;
		txIndex: number;
	}) => ({
		source: 'transaction',
		txHash: x.hash,
		blockNumber: x.blockNumber,
		blockHash: x.blockHash,
		txIndex: x.txIndex,
	});

	// ---- 1. a dev account's eth_sendTransaction, and an eth_call ----
	expect(c.deploy.status).toBe('0x1');
	expect(c.deploy.entries).toEqual([
		{
			args: ['deployed by %s', sender],
			message: `deployed by ${sender}`,
			...tx(c.deploy),
		},
	]);
	expect(c.work.status).toBe('0x1');
	expect(c.work.blockNumber).toBe(c.deploy.blockNumber + 1);
	expect(c.work.entries).toEqual([
		{args: ['work', '5n', '5n'], message: 'work 5 5', ...tx(c.work)},
		{
			args: ['inside a sub-call that reverts, n =', '5n'],
			message: 'inside a sub-call that reverts, n = 5',
			...tx(c.work),
		},
		{
			args: ['after the failed sub-call', true],
			message: 'after the failed sub-call true',
			...tx(c.work),
		},
	]);
	expect(BigInt(c.peek.result)).toBe(5n);
	expect(c.peek.entries).toEqual([
		{
			args: ['peek by', sender, 'count', '5n'],
			message: `peek by ${sender} count 5`,
			source: 'eth_call',
		},
	]);
	// the option reached the node: its sink received what the subscriber did
	expect(c.subscriberCount).toBe(5);
	expect(c.sinkCount).toBe(5);

	// ---- 2. as on the bare node: the very entries the wrapped node delivers ----
	expect(c.wrap.innerCount).toBe(5);
	expect(c.wrap.wrappedCount).toBe(5);
	expect(c.wrap.sameObjects).toBe(true);
	expect(c.wrap.sources).toEqual([
		'transaction',
		'transaction',
		'transaction',
		'transaction',
		'eth_call',
	]);

	// ---- 3. no console logging: the node's own error, unchanged ----
	expect(c.notEnabled.devIsError).toBe(true);
	expect(c.notEnabled.devMessage).toBe(c.notEnabled.bareMessage);
	expect(c.notEnabled.devMessage).toContain('consoleLog');
	expect(c.notEnabled.sameAsNode).toBe(true);

	// ---- 4. unsubscribing through the dev node stops delivery ----
	expect(c.unsubscribed.afterUnsub.status).toBe('0x1');
	expect(c.unsubscribed.receivedAfter).toBe(0);
	// while a subscriber still on delivers the same transaction and read
	expect(
		c.unsubscribed.keptAfter.map((e: {message: string}) => e.message),
	).toEqual([
		'work 1 6',
		'inside a sub-call that reverts, n = 1',
		'after the failed sub-call true',
		`peek by ${sender} count 6`,
	]);

	await h.dispose();
});
