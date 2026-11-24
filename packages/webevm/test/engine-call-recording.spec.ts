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
 * The recording half is held to ./call-recording-expected.ts, which
 * revm-call-recording.spec.ts holds `webevm/revm` to as well.
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertCallRecording} from './call-recording-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

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

	// ---- what is recorded, and gas identity (shared with the revm spec) ----
	expect(c.engineId).toBe('@ethereumjs/evm');
	assertCallRecording(c, 'default');
	expect(c.readUnaffordableTopLevelError).toBe('insufficient balance');

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
