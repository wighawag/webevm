/**
 * revm-call-recording.spec.ts: `webevm/revm` and the declared call-recording
 * capability, in real browsers. Until it moves onto revm-wasm outcome format 5
 * (task `console-log-on-the-revm-engine`) the engine does not declare
 * `recordsCalls`, so `connectEngine` requiring it REFUSES, quoting the engine's
 * own reason: the outcome format its artifact has, and the one it needs. See
 * docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
// Its OWN cut: this bundle carries the revm `.wasm` (see helpers/cut-revm.ts).
const cut = resolve(here, './helpers/cut-revm.ts');

test('revm engine: call recording is not declared yet, and the refusal says why', async ({
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
	console.log('[revm-call-recording]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	const reason =
		"console logging needs revm-wasm outcome format 5 (revm-wasm 0.6.0 or later); this engine's artifact has outcome format 4";
	// the engine declares the capability UNAVAILABLE, with its own reason
	expect(c.declared).toEqual({unavailable: reason});
	// ...connectEngine requiring it refuses, naming the engine and the
	// capability, and quoting that reason verbatim
	expect(c.required).toMatch(/^REFUSED: /);
	expect(c.required).toContain(`'${c.engineId}'`);
	expect(c.engineId).toBe('revm-wasm');
	expect(c.required).toContain('recordsCalls');
	expect(c.required).toContain(reason);
	// ...before binding it: the same engine still connects without the
	// requirement (it refuses a SECOND node, so a bound engine would not)
	expect(c.notRequired).toBe('CONNECTED');
	// createNode({engine: <webevm/revm>, consoleLog}) is refused at
	// construction, naming the engine, the capability and the engine's reason
	expect(c.node).toMatch(
		/^REFUSED: webevm: the engine 'revm-wasm' does not record calls/,
	);
	expect(c.node).toContain('recordsCalls');
	expect(c.node).toContain(reason);

	await h.dispose();
});
