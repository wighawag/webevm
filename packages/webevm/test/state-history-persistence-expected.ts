/**
 * state-history-persistence-expected.ts: the assertions on the
 * state-history-persistence battery (helpers/state-history-persistence.ts),
 * shared by the default-engine spec and the revm one, so both engines are held
 * to ONE contract. Its own module because Playwright refuses to let one spec
 * file import another.
 */
import {expect} from '@playwright/test';
import {CHANGE_SET_BLOCKS} from './change-set-expected.js';

const HISTORICAL = 'historical state not available';
const range = (from: number, to: number) =>
	Array.from({length: to - from + 1}, (_, i) => from + i);

function expectRefused(o: any, oldest: number, what: string) {
	expect(o, what).toMatchObject({code: -32000});
	expect(o.message, what).toContain(HISTORICAL);
	expect(o.message, what).toContain(`block ${oldest}`);
}

/**
 * X's balance at block K is K (a cheat before each block), and a cheat after
 * the head set it to 0x99: blocks `oldest .. head - 1` answer K, the head and
 * `latest` 0x99, every block below `oldest` is refused naming it.
 */
function expectSurvey(
	survey: Record<string, any>,
	oldest: number,
	what: string,
) {
	for (let k = 0; k <= 8; k++) {
		const at = `${what} at ${k}`;
		if (k < oldest) expectRefused(survey[k], oldest, at);
		else if (k === 8) expect(survey[k], at).toEqual({ok: '0x99'});
		else expect(survey[k], at).toEqual({ok: '0x' + k.toString(16)});
	}
	expect(survey.latest, `${what} latest`).toEqual({ok: '0x99'});
}

export function assertStateHistoryPersistence(
	c: Record<string, any>,
	label: string,
) {
	// ---- THE ROUND TRIP: every answer at every K is the writer's ----
	const r = c.roundTrip;
	const head = CHANGE_SET_BLOCKS.length;
	expect(r.head, label).toBe(head);
	expect(r.loadedHead, label).toBe(head);
	expect(r.mismatches, label).toEqual([]);
	expect(r.mismatchCount, label).toBe(0);
	// The whole chain's history crossed, and the loaded node holds all of it.
	expect(r.historyBlocks, label).toEqual(range(1, head));
	expect(r.writerSealed, label).toEqual(range(1, head));
	expect(r.loadedSealed, label).toEqual(range(1, head));
	// Not vacuous: many answers, no error among them, every block different.
	expect(r.answersCompared, label).toBeGreaterThan((head + 1) * 50);
	expect(r.errorsBefore, label).toBe(0);
	expect(r.distinctBlocks, label).toBe(head);
	// The writes since the head were folded into the head's record...
	expect(r.cheatedInHeadRecord, label).toBe(true);
	// ...and dump -> load -> dump changes nothing, history included.
	expect(r.fixedPoint, label).toBe(true);

	// ---- CHANGING N: at most N, and never more than the dump holds ----
	const w = c.windows;
	expect(w.dumpHistory, label).toEqual(range(3, 8));
	expectSurvey(w.writerSurvey, 2, `${label}: writer`);

	// Smaller window: truncated to N on load.
	expect(w.smaller.sealed, label).toEqual([6, 7, 8]);
	expectSurvey(w.smaller.survey, 5, `${label}: smaller`);
	expect(w.smaller.call, label).toEqual({ok: '0x'});
	expect(w.smaller.afterMine.sealed, label).toEqual([7, 8, 9]);
	expectSurvey(w.smaller.afterMine.survey, 6, `${label}: smaller mined`);
	expect(w.smaller.dumpHasHistory, label).toBe(true);

	// Same window: exactly what the writer served.
	expect(w.same.sealed, label).toEqual(range(3, 8));
	expectSurvey(w.same.survey, 2, `${label}: same`);
	expect(w.same.afterMine.sealed, label).toEqual(range(4, 9));
	expectSurvey(w.same.afterMine.survey, 3, `${label}: same mined`);

	// Larger window: serves what the dump has, and says where history starts.
	expect(w.larger.sealed, label).toEqual(range(3, 8));
	expectSurvey(w.larger.survey, 2, `${label}: larger`);
	expect(w.larger.survey[1].message, label).toContain(
		'history starts at block 2',
	);
	expect(w.larger.afterMine.sealed, label).toEqual(range(3, 9));
	expectSurvey(w.larger.afterMine.survey, 2, `${label}: larger mined`);

	// No option: the field is ignored (head only), and not written back.
	expect(w.none.sealed, label).toEqual([]);
	expectSurvey(w.none.survey, 8, `${label}: none`);
	expectRefused(w.none.call, 8, `${label}: none call`);
	expect(w.none.afterMine.sealed, label).toEqual([]);
	expectSurvey(w.none.afterMine.survey, 9, `${label}: none mined`);
	expect(w.none.dumpHasHistory, label).toBe(false);

	// ---- OLD DUMPS: they load, with history starting at their head ----
	const o = c.oldDumps;
	expect(o.fixture.hadHistory, label).toBe(false);
	expect(o.fixture.head, label).toBe(4);
	expect(o.fixture.sealed, label).toEqual([]);
	expect(o.fixture.atHead, label).toHaveProperty('ok');
	expectRefused(o.fixture.belowHead, 4, `${label}: fixture below head`);
	expect(o.fixture.belowHead.message, label).toContain(
		'history starts at block 4',
	);
	expect(o.fixtureAfterMine.sealed, label).toEqual([5]);
	expect(o.fixtureAfterMine.at4, label).toHaveProperty('ok');
	expectRefused(o.fixtureAfterMine.at3, 4, `${label}: fixture mined`);
	expect(o.stripped.writerHadHistory, label).toEqual([1, 2, 3]);
	expect(o.stripped.sealed, label).toEqual([]);
	expect(o.stripped.atHead, label).toEqual({ok: '0x3'});
	expectRefused(o.stripped.belowHead, 3, `${label}: stripped below head`);

	// ---- WITHOUT THE OPTION: no field at all (the format is additive) ----
	expect(c.withoutHistory.hasHistoryKey, label).toBe(false);
}
