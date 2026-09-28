/**
 * statetest.spec.ts — TRACK B conformance: run real `ethereum/tests`
 * GeneralStateTests (vendored under tests/fixtures, pinned tag v17.0) against the
 * slim node's opt-in `computeStateRoot: true` in real Chromium, asserting the post-state
 * Merkle-Patricia ROOT and `keccak(RLP(logs))` match each fixture's expected
 * Cancun values. This is the strongest spec-conformance signal — it verifies
 * exactly what the canonical fixtures verify, and is only possible because that
 * option produces a real state root (the default computes none, by design).
 *
 * The fixture JSONs are read here in Node and handed to the page via params; the
 * in-browser runner (src/statetest.ts) loads each `pre` via the node's
 * initialState option, applies `env` via blockEnv, submits the case `txbytes`,
 * and compares node.getStateRoot() + the logs hash.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {readFile} from 'node:fs/promises';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const fixturesDir = resolve(here, 'fixtures/GeneralStateTests/stExample');

// The vendored handful (see tests/fixtures/README.md for the pinned source tag).
const FIXTURE_FILES = [
	'add11.json',
	'eip1559.json',
	'accessListExample.json',
	'solidityExample.json',
];

let fixtures: {name: string; json: any}[];

test.beforeAll(async () => {
	fixtures = await Promise.all(
		FIXTURE_FILES.map(async (f) => ({
			name: f.replace('.json', ''),
			json: JSON.parse(await readFile(join(fixturesDir, f), 'utf8')),
		})),
	);
});

test('slim-node computeStateRoot passes real ethereum/tests GeneralStateTests (post-state root + logs)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'statetest', fixtures}});

	console.log('\n[statetest] errors:', r.errors);
	const s = r.results.stateTests as any;
	console.log(
		`[statetest] ${s.passed}/${s.total} cases passed (${s.failed} failed)`,
	);
	for (const c of s.cases) {
		const tag = c.rootMatch && c.logsMatch && !c.error ? 'OK ' : 'XX ';
		console.log(
			`  ${tag}${c.test} case#${c.caseIndex} d/g/v=${c.indexes.data}/${c.indexes.gas}/${c.indexes.value} ` +
				`root=${c.rootMatch} logs=${c.logsMatch} status=${c.txStatus}` +
				(c.error ? ` ERROR=${c.error}` : '') +
				(!c.rootMatch
					? `\n      gotRoot=${c.gotRoot}\n      wantRoot=${c.wantRoot}`
					: ''),
		);
	}

	expect(r.errors).toEqual([]);
	// Every vendored fixture must have produced at least some Cancun cases.
	expect(s.total).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
	// And every case's post-state root + logs hash must match the fixture.
	expect(s.failed).toBe(0);
	expect(s.passed).toBe(s.total);
});
