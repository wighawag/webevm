/**
 * historical-call-expected.ts: the assertions on the historical-call battery
 * (helpers/historical-call.ts), shared by the default-engine spec and the revm
 * one, so both engines are held to ONE contract. It lives in its own module
 * because Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

const ZERO_WORD = '0x' + '00'.repeat(32);
const w = (n: number) => '0x' + n.toString(16).padStart(64, '0');

export function assertHistoricalCall(c: Record<string, any>, label: string) {
	// ---- THE CONSUMER: logs up to N and a view at N describe one moment ----
	const u = c.consumer;
	expect(u.head, label).toBe(u.pinned + 2);
	expect(u.logCount, label).toBe(1);
	expect(u.lastLogValue, label).toBe('1');
	expect(u.valueAtPinned, label).toBe('1');
	// Not vacuous: the head moved on.
	expect(u.valueAtHead, label).toBe('3');

	// ---- K'S BLOCK ENVIRONMENT, BLOCKHASH AND STORAGE ----
	const b = c.blockEnvironment;
	expect(b.atK.env, label).toEqual(b.headerK.env);
	expect(b.atHead.env, label).toEqual(b.headerHead.env);
	// Every field differs between K and the head, so the two equalities above
	// cannot both hold for a call answered from the wrong block.
	for (const field of Object.keys(b.headerK.env))
		expect(b.headerK.env[field], `${label}: ${field}`).not.toBe(
			b.headerHead.env[field],
		);
	expect(b.atK.stored, label).toBe(w(0x0b));
	expect(b.atHead.stored, label).toBe(w(0x0d));
	expect(b.atK.blockHashOfK, label).toBe(ZERO_WORD);
	expect(b.atK.blockHashOfKPlus1, label).toBe(ZERO_WORD);
	expect(b.atK.blockHashOfKMinus1, label).toBe(b.headerKMinus1.hash);
	// ...and K's hash is real at the head, so the zero above is the horizon.
	expect(b.atHead.blockHashOfK, label).toBe(b.headerK.hash);

	// ---- RECONSTRUCTION: created, self-destructed, storage-cleared after K ----
	const r = c.reconstruction;
	expect(r.receipts.created, label).toEqual({
		status: '0x1',
		contractAddress: r.addresses.P,
	});
	expect(r.receipts.destroyed, label).toBe('0x1');
	expect(r.receipts.deployed, label).toEqual({
		status: '0x1',
		contractAddress: r.addresses.R,
	});
	// P at K: present (balance 7, no code) with ALL three slots, although its
	// storage was cleared by a creation since.
	expect(r.atK.P, label).toEqual({
		account: {balance: '0x7', size: '0x0', hash: r.emptyCodeHash},
		slots: [w(0xa0), w(0xa1), w(0xa2)],
		code: '0x',
	});
	expect(r.atHead.P.slots, label).toEqual([w(0x2a), w(0), w(0)]);
	expect(r.atHead.P.account.size, label).not.toBe('0x0');
	// Q at K: present with its slot, although it has been destroyed since.
	expect(r.atK.Q, label).toEqual({
		account: {balance: '0x5', size: '0x0', hash: r.emptyCodeHash},
		slot3: w(0x93),
	});
	expect(r.atHead.Q, label).toEqual({
		account: {balance: '0x0', size: '0x0', hash: ZERO_WORD},
		slot3: w(0),
	});
	// R at K: ABSENT (zero EXTCODEHASH, not the empty-code hash), no code, and
	// EXTCODESIZE 0, although a contract lives there now.
	expect(r.atK.R, label).toEqual({
		account: {balance: '0x0', size: '0x0', hash: ZERO_WORD},
		code: '0x',
	});
	expect(r.atHead.R.account.size, label).toBe('0x13');

	// ---- eth_estimateGas AT K reflects K's state ----
	expect(r.estimate.atK, label).toEqual({ok: '0x5208'});
	expect(BigInt(r.estimate.atHead.ok), label).toBeGreaterThan(21000n);

	// ---- STATE OVERRIDES ON TOP OF K ----
	const o = r.overrides;
	expect(o.absentGivenBalance, label).toEqual({
		balance: '0x99',
		size: '0x0',
		hash: r.emptyCodeHash,
	});
	expect(o.stateDiff, label).toEqual([w(0xa0), w(0x77)]);
	expect(o.state, label).toEqual([w(0), w(0x55)]);
	expect(o.codeOnAbsent, label).toBe(w(0));

	// ---- PURITY: nothing moved, including after failures ----
	const f = r.failures;
	expect(f.callReverts, label).toMatchObject({code: 3});
	expect(f.estimateThrows, label).toMatchObject({code: 3});
	expect(f.badOverride, label).toMatchObject({code: -32602});
	expect(r.pure, `${label}: the head is byte-identical`).toBe(true);
	expect(r.headStable, label).toBe(true);

	// ---- THE DIFFERENTIAL: every execution at every K equals K's own ----
	const d = c.differential;
	expect(d.snapshotErrors, label).toBe(0);
	expect(d.mismatches, label).toEqual([]);
	expect(d.mismatchCount, label).toBe(0);
	expect(d.keyCount, label).toBeGreaterThan(30);
	expect(d.refsChecked, label).toBe((d.head + 1) * 2);
	expect(d.distinctSnapshots, label).toBe(d.head);
	expect(d.cheatsChangedTheHead, label).toBe(true);
	expect(d.pure, `${label}: the sweep left the head byte-identical`).toBe(true);
}
