/**
 * change-set.spec.ts: the per-block CHANGE SET (src/state-manager.ts) holds, for
 * every key a block changed, the value it had at the end of the block before, on
 * the DEFAULT engine. The battery is helpers/change-set.ts (a dumpState
 * differential through the public surface); the revm half is
 * revm-change-set.spec.ts, held to the same assertions (change-set-expected.ts).
 * The state-manager-only checks (the shape guard, checkpoint semantics) run here
 * once, since they involve no engine.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {assertChangeSets} from './change-set-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('the change set records every changed key with its previous value (default engine)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'change-set'}});

	console.log('\n[change-set] errors:', r.errors);
	const c = r.results.changeSet as Record<string, any>;
	console.log('[change-set]', JSON.stringify(c, null, 2));
	expect(r.errors).toEqual([]);

	expect(c.battery.differential.engineId).toBe('@ethereumjs/evm');
	assertChangeSets(c.battery, '@ethereumjs/evm');

	const s = c.stateManager;
	// assertStateShape refuses a manager lacking the synchronous writers, by name.
	expect(s.shapeAcceptsNodeManager).toBe('accepted');
	expect(s.shapeRefusesWithoutSetAccountAt).toContain('setAccountAt()');
	expect(s.shapeRefusesWithoutSetCodeAt).toContain('setCodeAt()');
	expect(s.shapeRefusesWithoutRemoveAccountAt).toContain('removeAccountAt()');
	for (const name of ['setAccountAt()', 'setCodeAt()', 'removeAccountAt()'])
		expect(s.shapeRefusesWithoutAll).toContain(name);
	// A reverted level leaves nothing; committed levels record the value from
	// before the OUTERMOST level opened, despite the in-place mutation inside.
	expect(s.revertedLevelLeavesNoRecord).toEqual({
		accounts: {},
		code: {},
		storage: {},
		storageCleared: [],
	});
	expect(s.committedLevelsRecordTheOuterPrior).toBe('0x1');
	expect(s.committedLevelsLiveValue).toBe('3');
	expect(s.suspendedCommitIntoBottomRefused).toContain('suspended');
	expect(s.depthAfterRefusal).toBe(2);
	expect(s.depthAfterRevert).toBe(1);
	expect(s.takeWithCheckpointOpen).toContain('checkpoint open');
	expect(s.bottomLevelReadIsACopy).toBe(true);

	await h.dispose();
});
