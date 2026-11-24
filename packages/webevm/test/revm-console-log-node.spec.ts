/**
 * revm-console-log-node.spec.ts: the console-log delivery battery
 * (helpers/console-log-node.ts) with the `webevm/revm` engine installed, held
 * to the SAME entries as the default engine (./console-log-node-expected.ts):
 * transactions under every mining path, `eth_call`, a reverting read, the
 * sinks, gas / receipts / state root identical with console logging on and
 * off, failing consumers, no replay on reload, and the estimation opt-in.
 *
 * What revm adds is the engine's half: it records the console calls itself
 * (revm-wasm's `recordCallsTo`, outcome format 5) where the default engine
 * listens to `beforeMessage`, and the node above the seam is the same code.
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertConsoleLogNode} from './console-log-node-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('console.log on revm: the same entries as the default engine, and observed only', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'console-log-node'}});
	console.log('\n[revm-console-log-node] errors:', r.errors);
	const c = r.results.revmConsoleLogNode as Record<string, any>;
	console.log('[revm-console-log-node]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	// The battery really ran on revm, not silently on the default engine.
	expect(c.automine.engineId).toBe('revm-wasm');
	assertConsoleLogNode(c);

	await h.dispose();
});
