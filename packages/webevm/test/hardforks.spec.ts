/**
 * hardforks.spec.ts: the `hardfork` option, and what each fork it offers
 * changes, on the DEFAULT `@ethereumjs/evm` engine. The battery is
 * helpers/hardforks.ts and the contract both engines are held to is
 * ./hardforks-expected.ts; `revm-hardforks.spec.ts` runs the same battery with
 * `webevm/revm` installed and asserts the same literals.
 *
 * Also here, because no engine is involved: the option's construction refusals
 * (a typo must not silently become the default fork) and the refusal of a dump
 * taken on another fork, an unlabelled dump being a Cancun one.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertHardforks} from './hardforks-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('hardfork: Cancun, Prague and Osaka, each costed and refused in the node words', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'hardforks'}});

	console.log('\n[hardforks] errors:', r.errors);
	const c = r.results.hardforks as Record<string, any>;
	console.log('[hardforks]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);
	expect(c.battery.engineId).toBe('@ethereumjs/evm');
	assertHardforks(c.battery, 'default');

	// ---- the option ----
	const k = c.construction;
	// absent means the latest fork the node can cost
	expect(k.defaultFork).toBe('osaka');
	expect(k.offered).toEqual({
		cancun: 'cancun',
		prague: 'prague',
		osaka: 'osaka',
	});
	// ...and anything else is refused at construction, naming the option and the
	// forks it takes, rather than quietly becoming the default
	for (const [bad, outcome] of Object.entries(k.refused) as [string, string][])
		expect(`${bad}: ${outcome}`).toBe(
			`${bad}: threw: webevm: hardfork must be one of 'cancun', 'prague', 'osaka' (default 'osaka'), got ${
				bad === '7' || bad === 'null' ? bad : JSON.stringify(bad)
			}. Those are the forks whose gas rules this node implements on every engine; an earlier one is not offered, and a later one is not costed yet.`,
		);
	// an unlabelled dump (taken before the field existed) is a Cancun dump: it
	// loads into a Cancun node and is refused by any other, saying why
	expect(k.unlabelled).toEqual({
		cancun: 'loaded',
		prague:
			"webevm: this state was dumped from a node running hardfork 'cancun' (it carries no hardfork, so it predates the option, when every node ran Cancun) and this node runs 'prague'",
		osaka:
			"webevm: this state was dumped from a node running hardfork 'cancun' (it carries no hardfork, so it predates the option, when every node ran Cancun) and this node runs 'osaka'",
	});

	await h.dispose();
});
