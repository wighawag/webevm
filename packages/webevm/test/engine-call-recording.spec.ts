/**
 * engine-call-recording.spec.ts: the engine seam's CALL RECORDING, in real
 * browsers, on the default `@ethereumjs/evm` engine driven at the seam:
 *   - `recordCallsTo` records the input of every CALL, STATICCALL, DELEGATECALL
 *     and CALLCODE frame into the address, in execution order, on reads and
 *     transactions alike, including frames that revert and the top-level call;
 *     never a CREATE, never a frame refused before it runs
 *   - without it, no `recordedCalls` key at all
 *   - with and without it, identical results and post-state (gas identity)
 *   - `connectEngine` refuses, when recording is required, an engine that does
 *     not declare `recordsCalls`, quoting the engine's own reason
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

/** The marker bytes `CallRecordingProbe.callEveryKind` sends, in order. */
const EVERY_KIND = ['0x01', '0x02', '0x03', '0x04', '0x05', '0x07'];

test('engine call recording (recordCallsTo / recordedCalls / recordsCalls)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'engine-call-recording'},
	});
	console.log('\n[engine-call-recording] errors:', r.errors);
	const c = r.results.engineCallRecording as Record<string, any>;
	const {shapesRecording: _r, shapesPlain: _p, ...summary} = c ?? {};
	console.log('[engine-call-recording]', JSON.stringify(summary, null, 2));
	expect(r.errors).toEqual([]);

	// ---- what is recorded ----
	// CALL 01, STATICCALL 02, DELEGATECALL 03, CALLCODE 04, the CALL inside a
	// reverting sub-call 05, and 07 after them; NOT 06, whose value the probe
	// cannot afford, so the frame is refused before it runs.
	expect(c.recording.readEveryKind).toEqual(EVERY_KIND);
	expect(c.recording.txEveryKind).toEqual(EVERY_KIND);
	expect(c.statuses.txEveryKind).toBe(1);
	// a transaction that reverts as a whole still reports the call it made
	expect(c.recording.txRevertsWhole).toEqual(['0x08']);
	expect(c.statuses.txRevertsWhole).toBe(0);
	// the request's own top-level call, when `to` is the address
	expect(c.recording.readTopLevel).toEqual(['0xabcd']);
	expect(c.recording.txTopLevel).toEqual(['0xbeef']);
	// a top-level read refused before execution: present, and EMPTY
	expect(c.readUnaffordableTopLevelError).toBe('insufficient balance');
	expect(c.recording.readUnaffordableTopLevel).toEqual([]);
	// CREATE is never recorded: the CREATE2 frame that makes the address is
	// absent, the call into it afterwards is not; and a top-level CREATE recording
	// its own address records nothing (nor does the deploy recording the target)
	expect(c.recording.readCreateThenCall).toEqual(['0x09']);
	expect(c.recording.txCreateThenCall).toEqual(['0x09']);
	expect(c.recording.readTopLevelCreate).toEqual([]);
	expect(c.recording.deploy).toEqual([]);

	// ---- without `recordCallsTo`, no field at all ----
	for (const [key, value] of Object.entries(c.plain)) {
		expect(value, key).toBe('ABSENT');
	}

	// ---- gas identity: recording changes nothing it observes ----
	expect(c.shapesRecording).toEqual(c.shapesPlain);
	expect(c.shapesIdentical).toBe(true);
	// ...and the comparison covers a real log (and so a non-zero bloom)
	expect(c.txEveryKindLogCount).toBe(1);
	expect(c.postStateIdentical).toBe(true);

	// ---- the declared capability, enforced by connectEngine ----
	const k = c.connect as Record<string, any>;
	expect(k.silentRequired).toMatch(/^REFUSED: /);
	expect(k.silentRequired).toContain("'silent-stub'");
	expect(k.silentRequired).toContain('recordsCalls');
	expect(k.silentRequired).toContain('does NOT fall back');
	// refused BEFORE connect, so the engine was never bound to this node
	expect(k.silentConnectedWhenRefused).toBe(0);
	expect(k.explainedRequired).toMatch(/^REFUSED: /);
	expect(k.explainedRequired).toContain("'explained-stub'");
	expect(k.explainedRequired).toContain('recordsCalls');
	expect(k.explainedRequired).toContain(
		'this stub was built without its frame tracer (reason 42)',
	);
	expect(k.explainedConnectedWhenRefused).toBe(0);
	// without the requirement nothing new is checked
	expect(k.silentNotRequired).toBe('CONNECTED');
	expect(k.explainedNotRequired).toBe('CONNECTED');
	// the default engine declares it and passes
	expect(k.defaultDeclares).toBe(true);
	expect(k.defaultRequired).toBe('CONNECTED');

	await h.dispose();
});
