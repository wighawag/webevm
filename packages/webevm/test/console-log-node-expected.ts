/**
 * console-log-node-expected.ts: the assertions on the console-log delivery
 * battery (helpers/console-log-node.ts), shared by the default-engine spec and
 * the revm one, so both engines are held to ONE set of entries: the same
 * fixture logs the same things, delivered at the same moments, with gas,
 * receipts and state identical with console logging on and off. It lives in
 * its own module because Playwright refuses to let one spec file import
 * another. The engine-free cases (an engine that declares recording and
 * returns none, the worker-entry refusal, the estimation stub, the option
 * refusals) stay in console-log-node.spec.ts.
 */
import {expect} from '@playwright/test';

export function assertConsoleLogNode(c: Record<string, any>) {
	// ---- 1. every place a contract logs, under automine ----
	const a = c.automine;
	const sender = a.sender as string;
	const tx = (
		x: {hash: string; blockNumber: number; blockHash: string},
		txIndex = 0,
	) => ({
		source: 'transaction',
		txHash: x.hash,
		blockNumber: x.blockNumber,
		blockHash: x.blockHash,
		txIndex,
	});
	// the constructor
	expect(a.deploy.entries).toEqual([
		{
			args: ['deployed by %s', sender],
			message: `deployed by ${sender}`,
			...tx(a.deploy),
		},
	]);
	// a transaction, including the sub-call that reverts, in execution order
	expect(a.work.status).toBe('0x1');
	expect(a.work.eventLogs).toBe(1);
	expect(a.work.entries).toEqual([
		{args: ['work', '5n', '5n'], message: 'work 5 5', ...tx(a.work)},
		{
			args: ['inside a sub-call that reverts, n =', '5n'],
			message: 'inside a sub-call that reverts, n = 5',
			...tx(a.work),
		},
		{
			args: ['after the failed sub-call', true],
			message: 'after the failed sub-call true',
			...tx(a.work),
		},
	]);
	// a transaction that reverts as a whole still delivers what it logged
	expect(a.failWhole.status).toBe('0x0');
	expect(a.failWhole.entries).toEqual([
		{
			args: ['about to revert:', 'nope'],
			message: 'about to revert: nope',
			source: 'transaction',
			txHash: a.failWhole.hash,
			blockNumber: 3,
			blockHash: a.failWhole.blockHash,
			txIndex: 0,
		},
	]);
	// a view read: `source: 'eth_call'`, and no transaction fields
	expect(a.peek.entries).toEqual([
		{
			args: ['peek by', sender, 'count', '5n'],
			message: `peek by ${sender} count 5`,
			source: 'eth_call',
		},
	]);
	// a REVERTING eth_call delivers before its revert is thrown
	expect(a.revertingCall.outcome).toMatch(/^THREW execution reverted/);
	expect(a.revertingCall.entries).toEqual([
		{
			args: ['about to revert:', 'in a read'],
			message: 'about to revert: in a read',
			source: 'eth_call',
		},
	]);
	// estimation prints nothing
	expect(a.estimate.entries).toEqual([]);
	// malformed console calldata delivers nothing and fails nothing
	expect(a.malformed.status).toBe('0x1');
	expect(a.malformed.entries).toEqual([]);
	expect(BigInt(a.countAfter)).toBe(6n);
	expect(a.sinkMatchesSubscriber).toBe(true);
	expect(a.total).toBe(7);

	// ---- 1. manual mining: one block of several transactions, then evm_mine ----
	const m = c.manual;
	// nothing is delivered before the block is mined
	expect(m.beforeDeployMine).toBe(0);
	expect(m.beforeMine).toBe(0);
	expect(m.batch.map((e: any) => [e.message, e.txHash, e.txIndex])).toEqual([
		['work 1 1', m.hashes[0], 0],
		['inside a sub-call that reverts, n = 1', m.hashes[0], 0],
		['after the failed sub-call true', m.hashes[0], 0],
		['work 2 3', m.hashes[1], 1],
		['inside a sub-call that reverts, n = 2', m.hashes[1], 1],
		['after the failed sub-call true', m.hashes[1], 1],
		['work 3 6', m.hashes[2], 2],
		['inside a sub-call that reverts, n = 3', m.hashes[2], 2],
		['after the failed sub-call true', m.hashes[2], 2],
	]);
	for (const e of m.batch) {
		expect(e.source).toBe('transaction');
		expect(e.blockNumber).toBe(m.mined.blockNumber);
		expect(e.blockHash).toBe(m.mined.blockHash);
	}
	expect(m.beforeEvmMine).toBe(0);
	expect(m.evmMine.entries.map((e: any) => e.message)).toEqual([
		'work 10 16',
		'inside a sub-call that reverts, n = 10',
		'after the failed sub-call true',
	]);
	for (const e of m.evmMine.entries) expect(e).toMatchObject(tx(m.evmMine));

	// ---- 1. interval mining ----
	expect(c.interval.entries).toEqual([
		{
			args: ['deployed by %s', sender],
			message: `deployed by ${sender}`,
			...tx(c.interval),
		},
	]);

	// ---- 2. sinks, subscribers, unsubscribe, dispose ----
	const s = c.sinks;
	// the default sink prints each message once, prefixed, through console.log
	expect(s.defaultSink.entries).toHaveLength(4);
	expect(s.defaultSink.printed).toEqual(
		s.defaultSink.entries.map((m: string) => ['[webevm console.log]', m]),
	);
	// a custom onLog replaces it: nothing printed, the subscriber still gets all
	expect(s.onLog.printed).toBe(0);
	expect(s.onLog.sunk).toHaveLength(10);
	expect(s.onLog.got).toEqual(s.onLog.sunk.slice(0, 7));
	// unsubscribe stopped the second subscriber after work(1)
	expect(s.onLog.second).toEqual(s.onLog.sunk.slice(1, 4));
	// dispose dropped the third before it got anything; the sink carries on
	expect(s.onLog.third).toEqual([]);
	expect(s.onLog.sunkAfterDispose).toBe(3);

	// ---- 3. gas and outcome identity, on and off ----
	const i = c.identity;
	expect(i.entriesOn).toBeGreaterThan(0);
	expect(i.receiptStatuses).toEqual(['0x1', '0x1', '0x0', '0x1']);
	expect(i.receiptsIdentical).toBe(true);
	expect(i.peekOn).toBe(i.peekOff);
	expect(i.revertingOn).toBe(i.revertingOff);
	expect(i.estimateOn).toBe(i.estimateOff);
	expect(i.estimateEntries).toBe(0);
	expect(i.stateRootOn).toMatch(/^0x[0-9a-f]{64}$/);
	expect(i.stateRootOn).not.toBe('0x' + '00'.repeat(32));
	expect(i.stateRootOn).toBe(i.stateRootOff);
	// ---- 7. not chain state: a dump carries no log ----
	expect(i.dumpsIdentical).toBe(true);

	// ---- 4. failing consumers ----
	for (const [kind, why] of [
		['sink', 'the sink throws'],
		['subscriber', 'the subscriber throws'],
		['rejecting', 'the subscriber rejects'],
	] as const) {
		const f = c.failures[kind];
		expect(f.status, kind).toBe('0x1');
		expect(BigInt(f.peek), kind).toBe(0n);
		// the deploy's entry and the read's: each reported once
		expect(f.errors, kind).toBe(2);
		for (const msg of f.messages) {
			expect(msg, kind).toContain('webevm: a console.log');
			expect(msg, kind).toContain(why);
		}
		expect(f.after, kind).toEqual([
			expect.stringMatching(/^deployed by /),
			expect.stringMatching(/^peek by .* count 0$/),
		]);
	}

	// ---- 5. without the option ----
	expect(c.without.onConsoleLog).toMatch(/^THREW .*`consoleLog` option/);
	expect(c.without.deployStatus).toBe('0x1');
	expect(c.without.refusedFlag).toMatch(
		/^THREW webevm: consoleLog must be the object consoleLog\(\) returns/,
	);
	expect(c.without.refusedFunction).toMatch(/a function \(call it/);

	// ---- 7. no entry replayed by loadState or a persistence reload ----
	expect(c.reload.dumpBlocks).toBe(3);
	expect(c.reload.loadedBlock).toBe('0x2');
	expect(c.reload.loadedEntries).toBe(0);
	expect(c.reload.reloadedBlock).toBe('0x2');
	expect(c.reload.reloadedEntries).toBe(0);

	// ---- 9. estimation: silent unless asked, then the first execution only ----
	const e = c.estimation;
	const work1 = (source: string) => [
		{args: ['work', '1n', '1n'], message: 'work 1 1', source},
		{
			args: ['inside a sub-call that reverts, n =', '1n'],
			message: 'inside a sub-call that reverts, n = 1',
			source,
		},
		{
			args: ['after the failed sub-call', true],
			message: 'after the failed sub-call true',
			source,
		},
	];
	for (const key of ['omitted', 'none']) {
		const d = e.real[key];
		expect(d.estimate.entries, key).toEqual([]);
		expect(d.fill.entries, key).toEqual([]);
		expect(d.reverting.entries, key).toEqual([]);
		expect(d.reverting.out, key).toMatch(/^THREW execution reverted/);
		expect(d.refused.entries, key).toEqual([]);
	}
	const f = e.real.first;
	expect(f.estimate.entries).toEqual(work1('eth_estimateGas'));
	expect(f.fill.entries).toEqual(work1('eth_fillTransaction'));
	// the estimate is the same on and off
	expect(f.estimate.out).toBe(e.real.none.estimate.out);
	expect(f.estimate.out).toBe(e.real.omitted.estimate.out);
	expect(f.fill.out).toBe(e.real.none.fill.out);
	// a reverting estimation delivers its first execution's entries, then throws
	expect(f.reverting.out).toMatch(/^THREW execution reverted/);
	expect(f.reverting.entries).toEqual([
		{
			args: ['about to revert:', 'in an estimate'],
			message: 'about to revert: in an estimate',
			source: 'eth_estimateGas',
		},
	]);
	expect(f.revertingOrder).toEqual([
		'entry about to revert: in an estimate',
		'settled',
	]);
	// refused before any probe executes: nothing ran, nothing is delivered
	expect(f.refused.out).toMatch(/^THREW gas required exceeds allowance/);
	expect(f.refused.entries).toEqual([]);
}
