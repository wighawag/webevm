/**
 * revm-call-recording.spec.ts: `webevm/revm` records calls, in real browsers.
 * On revm-wasm outcome format 5 the engine declares `recordsCalls` and passes
 * the seam's `recordCallsTo` through to revm-wasm, so the seam's recording
 * scenario gives the SAME recorded lists on revm as on the default engine
 * (./call-recording-expected.ts), with gas identity; an artifact older than
 * format 5 is refused at construction on a console-logging node, quoting the
 * engine's reason (the format it has and the one it needs).
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {
	assertCallRecording,
	EXPECTED_RECORDINGS,
} from './call-recording-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
// Its OWN cut: this bundle carries the revm `.wasm` (see helpers/cut-revm.ts).
const cut = resolve(here, './helpers/cut-revm.ts');

test('revm engine: records calls exactly as the default engine does, and refuses an older artifact at construction', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'call-recording'}});
	console.log('\n[revm-call-recording] errors:', r.errors);
	const c = r.results.revmCallRecording as Record<string, any>;
	const summary = {
		...c,
		revm: c?.revm?.recording,
		reference: c?.reference?.recording,
	};
	console.log('[revm-call-recording]', JSON.stringify(summary, null, 2));
	expect(r.errors).toEqual([]);

	// ---- 1. declared on outcome format 5, and connected when required ----
	expect(c.current.engineId).toBe('revm-wasm');
	expect(c.current.declared).toBe(true);
	expect(c.current.required).toBe('CONNECTED');

	// ---- 2. the same recorded lists on both engines, for the same fixture ----
	expect(c.revm.engineId).toBe('revm-wasm');
	expect(c.reference.engineId).toBe('@ethereumjs/evm');
	assertCallRecording(c.revm, 'revm');
	assertCallRecording(c.reference, 'default');
	expect(c.revm.recording).toEqual(c.reference.recording);
	expect(c.revm.recording).toEqual(EXPECTED_RECORDINGS);
	expect(c.revm.plain).toEqual(c.reference.plain);
	// the refused top-level read is each engine's own words: revm's names the
	// refusal, never a revert
	expect(c.revm.readUnaffordableTopLevelError).toMatch(
		/^webevm\/revm: the call is invalid and was NOT executed/,
	);
	// the same execution, gas included, whichever engine ran it (but the
	// refused read, whose error text is each engine's own)
	const {readUnaffordableTopLevel: _rr, ...revmShapes} = c.revm.shapesRecording;
	const {readUnaffordableTopLevel: _dr, ...defaultShapes} =
		c.reference.shapesRecording;
	expect(revmShapes).toEqual(defaultShapes);

	// ---- 3. an artifact below outcome format 5 ----
	const reason =
		"console logging needs revm-wasm outcome format 5 (revm-wasm 0.6.0 or later); this engine's artifact has outcome format 4";
	expect(c.old.declared).toEqual({unavailable: reason});
	// connectEngine requiring it refuses, naming the engine and the capability,
	// and quoting that reason verbatim (both formats)
	expect(c.old.required).toMatch(/^REFUSED: /);
	expect(c.old.required).toContain("'revm-wasm'");
	expect(c.old.required).toContain('recordsCalls');
	expect(c.old.required).toContain(reason);
	// ...before binding it, and without the requirement it connects
	expect(c.old.notRequired).toBe('CONNECTED');
	// createNode({engine: <old artifact>, consoleLog}) is refused at
	// construction, naming the engine, the capability and the engine's reason
	expect(c.old.node).toMatch(
		/^REFUSED: webevm: the engine 'revm-wasm' does not record calls/,
	);
	expect(c.old.node).toContain('recordsCalls');
	expect(c.old.node).toContain(reason);
	// ...while a node that does not log is built on the same artifact
	expect(c.oldNodeWithoutLogging).toBe('CONNECTED');

	// ---- 4. a console-logging node on the current artifact is built ----
	expect(c.node).toBe('CONNECTED');

	await h.dispose();
});
