/**
 * state-history-expected.ts: the assertions on the state-history battery
 * (helpers/state-history.ts), shared by the default-engine spec and the revm one,
 * so both engines are held to ONE contract. It lives in its own module because
 * Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';
import {CHANGE_SET_BLOCKS} from './change-set-expected.js';

const HISTORICAL = 'historical state not available';

function expectRefusedBeyond(
	o: any,
	oldest: number,
	what: string,
	label: string,
) {
	expect(o, `${label}: ${what}`).toMatchObject({code: -32000});
	expect(o.message, `${label}: ${what}`).toContain(HISTORICAL);
	// The refusal names the oldest servable block and the option that widens it.
	expect(o.message, `${label}: ${what}`).toContain(`block ${oldest}`);
	expect(o.message, `${label}: ${what}`).toContain('stateHistory');
}

export function assertStateHistory(c: Record<string, any>, label: string) {
	// ---- THE DIFFERENTIAL: every read at every K equals K's snapshot ----
	const d = c.differential;
	expect(d.deterministic, `${label}: the two runs agree`).toBe(true);
	expect(Object.keys(d.receipts).length, label).toBe(
		CHANGE_SET_BLOCKS.length - 1,
	);
	expect(d.head, label).toBe(CHANGE_SET_BLOCKS.length);
	expect(d.mismatches, label).toEqual([]);
	expect(d.mismatchCount, label).toBe(0);
	// Not vacuous: many keys, every block by 4 references (+ earliest), and every
	// block's state differs from the one before it.
	expect(d.keyCount, label).toBeGreaterThan(40);
	expect(d.refsChecked, label).toBe((d.head + 1) * 4 + 1);
	expect(d.distinctSnapshots, label).toBe(d.head);
	// The cheats after the head really changed the head (and the sweep above
	// proved no older block saw them).
	expect(d.cheatsChangedTheHead.length, label).toBe(4);

	// ---- A CHEAT BETWEEN j-1 AND j: invisible at j-1, visible from j ----
	const k = c.cheats;
	const w = (n: number) => '0x' + n.toString(16).padStart(64, '0');
	expect(k.at1, label).toEqual({balance: '0x0', slot: w(0)});
	expect(k.at2, label).toEqual({balance: '0x5', slot: w(5)});
	// ...and one after the head is visible at the head only.
	expect(k.at3, label).toEqual({balance: '0x9', slot: w(9)});
	expect(k.latest, label).toEqual({balance: '0x9', slot: w(9)});

	// ---- THE WINDOW: head - N served, head - N - 1 refused, and it moves ----
	const win = c.window;
	const n = win.n;
	expect(win.young.earliest, label).toEqual({ok: '0x0'});
	expect(win.young.at0, label).toEqual({ok: '0x0'});
	expect(win.young.sealed, label).toEqual([1, 2]);
	expect(win.atHead6.edge, label).toEqual({ok: '0x' + (6 - n).toString(16)});
	expectRefusedBeyond(win.atHead6.beyond, 6 - n, 'head 6 beyond', label);
	expect(win.atHead6.all, label).toEqual([
		{ok: '0x4'},
		{ok: '0x5'},
		{ok: '0x6'},
	]);
	expect(win.atHead7.edge, label).toEqual({ok: '0x' + (7 - n).toString(16)});
	expectRefusedBeyond(win.atHead7.beyond, 7 - n, 'head 7 beyond', label);
	for (const [what, o] of Object.entries(win.beyondByMethod))
		expectRefusedBeyond(o, 7 - n, `beyond by ${what}`, label);
	// eth_call / eth_estimateGas inside the window are served (X has no code: an
	// empty return, and a plain transfer's 21000).
	expect(win.callInWindow, label).toEqual({ok: '0x'});
	expect(win.estimateInWindow, label).toEqual({ok: '0x5208'});
	expect(win.callAtHead, label).toHaveProperty('ok');

	// ---- MEMORY: exactly N sealed records, the N newest ----
	expect(win.atHead6.sealed, label).toEqual([4, 5, 6]);
	expect(win.atHead7.sealed, label).toEqual([5, 6, 7]);
	expect(win.atHead40.sealed, label).toEqual([38, 39, 40]);
	expect(win.atHead40.edge, label).toEqual({ok: '0x' + (40 - n).toString(16)});

	// ---- A BATCH THAT THROWS MID-BLOCK: its writes belong to the next block ----
	const m = c.midBlockThrow;
	expect(m.refused, label).toContain('nonce too high');
	expect(m.before, label).toEqual({
		head: '0x1',
		latest: '0x4d2',
		at0: '0x0',
		openHoldsTheWrite: true,
	});
	expect(m.after, label).toEqual({head: '0x2', at1: '0x0', at2: '0x4d2'});

	// ---- WITHOUT THE OPTION: nothing sealed, below the head refused ----
	const o = c.withoutHistory;
	// Recording is off without the option, EXCEPT with `computeStateRoot`, where
	// the derived trie consumes the change sets; either way nothing is sealed.
	expect(o.recording, label).toBe(c.computeStateRoot === true);
	expect(o.sealed, label).toEqual([]);
	expectRefusedBeyond(o.belowHead, 2, 'without history', label);
}
