/**
 * snapshots-expected.ts: the assertions on the snapshot battery
 * (helpers/snapshots.ts), shared by the default-engine spec and the revm one, so
 * both engines are held to ONE contract. It lives in its own module because
 * Playwright refuses to let one spec file import another.
 *
 * The id format, the results and the consumption rule are pinned against the
 * two nodes' own source, cited at the methods in src/node.ts: anvil (foundry
 * crates/anvil/src/eth/api.rs, crates/anvil/src/eth/backend/mem/mod.rs and
 * crates/evm/core/src/state_snapshot.rs) and Hardhat (EDR,
 * crates/edr_provider/src/data.rs).
 */
import {expect} from '@playwright/test';

const COUNTER_CODE = '0x6000546001018060005560005260206000a000';
const word = (n: number) => '0x' + n.toString(16).padStart(64, '0');

export function assertSnapshots(c: Record<string, any>, label: string) {
	// ---- ids: anvil's counter, one for both names, never reused ----
	const i = c.ids;
	expect(
		[i.first, i.second, i.third],
		`${label}: ids count from 0x0 under both names`,
	).toEqual(['0x0', '0x1', '0x2']);
	expect(i.revertSecond, `${label}: a held id reverts`).toBe(true);
	expect(i.revertThird, `${label}: a later snapshot is consumed`).toBe(false);
	expect(i.revertSecondAgain, `${label}: the id itself is consumed`).toBe(
		false,
	);
	expect(i.afterConsumption, `${label}: ids are not reused`).toBe('0x3');
	expect(i.neverIssued, `${label}: an id never issued`).toBe(false);
	expect(i.asNumber, `${label}: a JSON number id`).toBe(true);
	for (const [k, r] of Object.entries(i.refused as Record<string, any>))
		expect(r.code, `${label}: ${k} is -32602`).toBe(-32602);

	// ---- consumption: that snapshot and every later one ----
	const k = c.consumption;
	expect(k.atThree, `${label}: three calls ran`).toBe(3);
	expect(k.toS1, label).toBe(true);
	expect(k.atS1, `${label}: back to one call`).toBe(1);
	expect(k.toS2, `${label}: s2 was taken after s1`).toBe(false);
	expect(k.toS0, `${label}: s0 was taken before s1`).toBe(true);
	expect(k.atS0, `${label}: back to none`).toBe(0);
	expect(k.toS1Again, label).toBe(false);

	// ---- restore: everything a consumer can read ----
	const r = c.restore;
	expect(r.reverted, label).toBe(true);
	expect(r.movedDiffers, `${label}: the reverted work moved the reads`).toBe(
		true,
	);
	expect(r.movedHead, `${label}: blocks were mined after`).not.toBe(
		r.snapshotHead,
	);
	expect(r.atRevert, `${label}: every read is the snapshot's`).toEqual(
		r.atSnapshot,
	);
	expect(r.sameReads, label).toBe(true);
	expect(r.atSnapshot.latest.counterCode, label).toBe(COUNTER_CODE);
	expect(r.atSnapshot.latest.slot, `${label}: two calls`).toBe(word(2));
	expect(r.atSnapshot.latest.freshBalance, label).toBe('0x0');
	expect(r.atSnapshot.latest.lateCode, label).toBe('0x');
	expect(r.atSnapshot.logs.length, `${label}: two logs`).toBe(2);
	expect(r.atSnapshot.receipts.length, label).toBe(2);
	expect(r.gone.receipts, `${label}: later receipts are gone`).toEqual([
		null,
		null,
		null,
	]);
	expect(r.gone.transactions, `${label}: later transactions are gone`).toEqual([
		null,
		null,
		null,
	]);
	expect(r.gone.blocks, `${label}: later blocks are gone`).toEqual([
		null,
		null,
		null,
	]);
	expect(r.sameDump, `${label}: dumpState is the snapshot's`).toBe(true);
	// ...and the chain carries on exactly as one that never ran the work.
	expect(
		r.continuation.slot1AtHead,
		`${label}: the pre-snapshot cheat is in the next block`,
	).toBe(word(7));
	expect(
		r.continuation.slot1AtPrevious,
		`${label}: and not in the head it was issued on top of`,
	).toBe(word(0));
	expect(r.continuation, `${label}: continues as the control`).toEqual(
		r.continuationControl,
	);
	expect(r.sameContinuation, label).toBe(true);
	expect(r.sameDumpAsControl, `${label}: byte-identical dump`).toBe(true);
	expect(r.sameRootAsControl, label).toBe(true);

	// ---- the clock: next timestamp and offset restored, interval kept ----
	const t = c.clock;
	expect(t.next.spent, `${label}: the next timestamp was spent`).toBe(5000);
	expect(t.next.afterRevert, `${label}: and is pending again`).toBe(5000);
	expect(t.offset.totalAfterRevert, `${label}: the offset is restored`).toBe(
		1000,
	);
	expect(t.offset.block, `${label}: and stamps the block`).toBe(1000);
	expect(t.interval.step, `${label}: an interval set after is kept`).toBe(7);
	expect(t.removed.removedResult, label).toBe(true);
	expect(t.removed.stillRemoved, `${label}: a removal after is kept`).toBe(
		false,
	);

	// ---- pending transactions are restored ----
	const p = c.pending;
	expect(p.pendingBefore, label).toBe('0x2');
	expect(p.pendingAfter, `${label}: only the first is queued`).toBe('0x1');
	expect(p.mined, `${label}: the next block mines only it`).toEqual([p.a]);
	expect(p.bReceipt, label).toBeNull();

	// ---- persistence saves the reverted chain ----
	const s = c.persistence;
	expect(s.afterSnapshot, `${label}: a snapshot saves nothing`).toBe(0);
	expect(s.afterTx, label).toBe(1);
	expect(s.refused, label).toBe(false);
	expect(s.afterRefused, `${label}: a refused revert saves nothing`).toBe(1);
	expect(s.reverted, label).toBe(true);
	expect(s.afterRevert, `${label}: a revert saves`).toBe(2);
	expect(s.savedIsReverted, `${label}: the reverted chain`).toBe(true);
	expect(s.reloadedSlot, `${label}: a reload is the reverted chain`).toBe(
		word(1),
	);

	// ---- viem's test client, every mode ----
	for (const mode of ['anvil', 'hardhat', 'ganache']) {
		const v = c.viem[mode];
		const l = `${label}: viem ${mode}`;
		expect(v.id, l).toBe('0x0');
		expect(v.slotMoved, `${l}: the work ran`).toBe(word(1));
		expect(v.revertResult, `${l}: revert() resolves`).toBeUndefined();
		expect(v.slot, `${l}: storage restored`).toBe(word(0));
		expect(v.fresh, `${l}: a cheated balance restored`).toBe('0x0');
		expect(v.blockNumber, `${l}: the head restored`).toBe('0x0');
	}
}
