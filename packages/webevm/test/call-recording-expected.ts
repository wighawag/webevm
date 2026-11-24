/**
 * call-recording-expected.ts: the assertions on the engine seam's call-recording
 * scenario (`runCallRecordingScenarios` in helpers/engine-call-recording.ts),
 * shared by the default-engine spec and the revm one, so both engines are held
 * to ONE set of recorded lists (ADR 0018: "Both engines match the same way").
 * It lives in its own module because Playwright refuses to let one spec file
 * import another.
 */
import {expect} from '@playwright/test';

/** The marker bytes `CallRecordingProbe.callEveryKind` sends, in order. */
const EVERY_KIND = ['0x01', '0x02', '0x03', '0x04', '0x05', '0x07'];

/** The recorded list of every scenario step, the one both engines must give. */
export const EXPECTED_RECORDINGS = {
	deploy: [],
	readEveryKind: EVERY_KIND,
	readTopLevel: ['0xabcd'],
	readUnaffordableTopLevel: [],
	readCreateThenCall: ['0x09'],
	readTopLevelCreate: [],
	txEveryKind: EVERY_KIND,
	txRevertsWhole: ['0x08'],
	txTopLevel: ['0xbeef'],
	txCreateThenCall: ['0x09'],
};

export function assertCallRecording(c: Record<string, any>, label: string) {
	// ---- what is recorded ----
	// CALL 01, STATICCALL 02, DELEGATECALL 03, CALLCODE 04, the CALL inside a
	// reverting sub-call 05, and 07 after them; NOT 06, whose value the probe
	// cannot afford, so the frame is refused before it runs.
	expect(c.recording.readEveryKind, label).toEqual(EVERY_KIND);
	expect(c.recording.txEveryKind, label).toEqual(EVERY_KIND);
	expect(c.statuses.txEveryKind, label).toBe(1);
	// a transaction that reverts as a whole still reports the call it made
	expect(c.recording.txRevertsWhole, label).toEqual(['0x08']);
	expect(c.statuses.txRevertsWhole, label).toBe(0);
	// the request's own top-level call, when `to` is the address
	expect(c.recording.readTopLevel, label).toEqual(['0xabcd']);
	expect(c.recording.txTopLevel, label).toEqual(['0xbeef']);
	// a top-level read refused before execution: present, and EMPTY (its error
	// is each engine's own words, asserted by each spec)
	expect(c.readUnaffordableTopLevelError, label).toBeTruthy();
	expect(c.recording.readUnaffordableTopLevel, label).toEqual([]);
	// CREATE is never recorded: the CREATE2 frame that makes the address is
	// absent, the call into it afterwards is not; and a top-level CREATE recording
	// its own address records nothing (nor does the deploy recording the target)
	expect(c.recording.readCreateThenCall, label).toEqual(['0x09']);
	expect(c.recording.txCreateThenCall, label).toEqual(['0x09']);
	expect(c.recording.readTopLevelCreate, label).toEqual([]);
	expect(c.recording.deploy, label).toEqual([]);
	// ...and that is EVERY step, so no step can go unasserted
	expect(c.recording, label).toEqual(EXPECTED_RECORDINGS);

	// ---- without `recordCallsTo`, no field at all ----
	for (const [key, value] of Object.entries(c.plain)) {
		expect(value, `${label}: ${key}`).toBe('ABSENT');
	}

	// ---- gas identity: recording changes nothing it observes ----
	expect(c.shapesRecording, label).toEqual(c.shapesPlain);
	expect(c.shapesIdentical, label).toBe(true);
	// ...and the comparison covers a real log (and so a non-zero bloom)
	expect(c.txEveryKindLogCount, label).toBe(1);
	expect(c.postStateIdentical, label).toBe(true);
}
