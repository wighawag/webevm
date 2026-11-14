/**
 * block-clock-expected.ts: the assertions on the block-clock battery
 * (helpers/block-clock.ts), shared by the default-engine spec and the revm one,
 * so both engines are held to ONE contract. It lives in its own module because
 * Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

/** Wall-clock slack, in seconds, for the checks that read the wall clock. */
const SLACK = 5;
/** FAR - TIMESTAMP in helpers/block-clock.ts: the offset a next timestamp leaves on a pinned clock. */
const PINNED_TO_FAR = 4_000_000_000 - 1_700_000_000;

export function assertBlockClock(c: Record<string, any>, label: string) {
	// ---- a next timestamp stamps the next block, header AND execution ----
	const n = c.next;
	expect(n.set, `${label}: evm_setNextBlockTimestamp returns null`).toBeNull();
	expect(n.block, `${label}: the block's header`).toBe(n.far);
	expect(n.executed, `${label}: TIMESTAMP inside the transaction`).toBe(n.far);
	// ...and the clock carries on from it rather than snapping back.
	expect(n.carriesOn, `${label}: carries on`).toBeGreaterThanOrEqual(0);
	expect(n.carriesOn, `${label}: carries on`).toBeLessThanOrEqual(SLACK);

	// ---- an interval: parent + interval, for every kind of block ----
	const i = c.interval;
	expect(
		i.set,
		`${label}: anvil_setBlockTimestampInterval returns null`,
	).toBeNull();
	expect(i.txBlock, `${label}: a transaction's block`).toBe(7);
	expect(i.txExecuted, `${label}: TIMESTAMP inside it`).toBe(7);
	expect(i.afterTwoEmpty, `${label}: two empty blocks`).toBe(21);
	expect(i.nextWins, `${label}: a next timestamp wins`).toBe(0);
	expect(i.resumesFromParent, `${label}: then parent + interval`).toBe(7);
	expect(i.zeroRepeats, `${label}: an interval of 0 repeats the parent's`).toBe(
		0,
	);
	expect(i.removed, `${label}: remove reports`).toEqual([true, false]);

	// ---- an interval chain is the same chain whenever it ran ----
	const s = c.sameChain;
	expect(s.differentSeconds, `${label}: the gap was forced`).toBe(true);
	expect(s.blocks, `${label}: a real chain ran`).toBe(4);
	expect(s.sameHeadHash, `${label}: identical heads`).toBe(true);

	// ---- evm_increaseTime: the total offset, a JSON number; the block moves ----
	const inc = c.increase;
	expect(inc.total, label).toBe(3600);
	expect(inc.delta, `${label}: moved by the hour`).toBeGreaterThanOrEqual(3600);
	expect(inc.delta, `${label}: moved by the hour`).toBeLessThanOrEqual(
		3600 + SLACK,
	);
	expect(inc.total2, `${label}: offsets accumulate`).toBe(3660);

	// ---- evm_mine ----
	const m = c.mine;
	expect(m.result, label).toBe('0x0');
	expect(m.minedOne, `${label}: one block`).toBe(1);
	expect(m.emptyTxs, `${label}: empty under auto mining`).toBe(0);
	expect(m.withTimestamp, `${label}: with a timestamp`).toBe(m.far);
	expect(m.object, `${label}: [{timestamp, blocks}]`).toEqual({
		result: '0x0',
		blocks: 3,
		first: 100,
	});
	expect(m.manual.pendingBefore, `${label}: pending until mined`).toBeNull();
	expect(m.manual.minedIn, `${label}: manual mining`).toBe(1);
	expect(m.manual.status, label).toBe('0x1');
	expect(m.manual.executed, `${label}: manual block's TIMESTAMP`).toBe(m.far);

	// ---- anvil_mine / hardhat_mine, on a pinned clock ----
	const a = c.anvilMine;
	expect([a.one, a.none], `${label}: anvil_mine returns null`).toEqual([
		null,
		null,
	]);
	expect(a.minedByDefaultAndZero, `${label}: [] mines one, [0] none`).toBe(1);
	expect(a.stamps, `${label}: [3, 60] then hardhat_mine [2, 0]`).toEqual([
		60, 120, 180, 180, 180,
	]);

	// ---- viem's own test actions, each mode's methods, on a pinned clock ----
	const v = c.viem;
	for (const mode of ['anvil', 'hardhat', 'ganache'])
		expect(v[mode].total, `${label}: viem ${mode} increaseTime`).toBe(
			PINNED_TO_FAR + 3600,
		);
	expect(v.anvil.stamps, `${label}: viem anvil`).toEqual([
		0, 3600, 3660, 3720, 3725, 3725,
	]);
	expect(v.hardhat.stamps, `${label}: viem hardhat`).toEqual([
		0, 3600, 3660, 3720,
	]);
	expect(v.ganache.stamps, `${label}: viem ganache`).toEqual([0, 3600]);

	// ---- a refused transaction does not spend the next timestamp ----
	const r = c.refusedKeepsNext;
	expect(r.replayRefused, `${label}: the replay was refused`).toBe(true);
	expect(r.minedAt, `${label}: the mined block carries it`).toBe(r.far);

	// ---- loadState drops a pending next timestamp ----
	expect(c.loadClears.minedAt, label).not.toBe(c.loadClears.far);

	// ---- blockEnv.timestamp: the default is unchanged ----
	const p = c.pinned;
	expect(p.txBlock, `${label}: pinned, a transaction's block`).toBe(p.pinned);
	expect(p.emptyBlock, `${label}: pinned, an empty block`).toBe(p.pinned);
	expect(
		BigInt(p.withInterval) - BigInt(p.pinned),
		`${label}: an interval counts from the pinned parent`,
	).toBe(5n);

	// ---- refusals ----
	const f = c.refusals;
	for (const k of [
		'setNextAtHead',
		'setNextBelowHead',
		'mineAtHead',
		'mineObjectAtHead',
	]) {
		expect(f[k].code, `${label}: ${k}`).toBe(-32000);
		expect(f[k].message, `${label}: ${k}`).toContain(
			"lower than or equal to previous block's timestamp",
		);
	}
	for (const k of [
		'setNextNotANumber',
		'setNextTooBig',
		'increaseNegative',
		'increaseFraction',
		'intervalNegative',
		'anvilMineNotANumber',
	])
		expect(f[k].code, `${label}: ${k}`).toBe(-32602);
	expect(f.headUnmoved, `${label}: refusals mine nothing`).toBe(true);
}
