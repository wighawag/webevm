/**
 * change-set-expected.ts: the assertions on the change-set battery
 * (helpers/change-set.ts), shared by the default-engine spec and the revm one, so
 * both engines are held to ONE contract. It lives in its own module because
 * Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

/** The blocks the differential mines, in order: one shape each. */
export const CHANGE_SET_BLOCKS = [
	'transfer',
	'creationOverStorage',
	'nestedCreation',
	'nestedFrames',
	'revertedTx',
	'eip161Removal',
	'selfdestruct',
	'cheatsThenEmptyBlock',
	'survivorDeploy',
	'survivorKill',
];

export function assertChangeSets(c: Record<string, any>, label: string) {
	// ---- THE INVARIANT, block by block, against dumpState ----
	const d = c.differential;
	expect(
		d.blocks.map((b: any) => b.label),
		label,
	).toEqual(CHANGE_SET_BLOCKS);
	for (const b of d.blocks) {
		// Every key the block changed is in its record, with the value from the end
		// of the previous block; every other recorded key carries that value too.
		expect(b.violations, `${label}: ${b.label}`).toEqual([]);
		// ...and the block really changed something, so the check was not vacuous.
		expect(b.changedKeys, `${label}: ${b.label}`).toBeGreaterThan(0);
		// The record was TAKEN at the block: nothing is left open behind it.
		expect(b.openEmptyAfterMining, `${label}: ${b.label}`).toBe(true);
	}
	// The shapes happened as named: the reverted transaction reverted, the rest
	// succeeded, and the creation landed on the address the cheat pre-loaded.
	for (const [name, status] of Object.entries(d.receipts))
		expect(status, `${label}: ${name} status`).toBe(
			name === 'revertedTx' ? '0x0' : '0x1',
		);
	expect(d.createdAddress, label).toBe(d.expectedCreationAddress);
	// A storage CLEAR marks the account (a trie must rebuild its storage).
	expect(d.creationCleared, label).toBe(true);
	expect(d.selfdestructCleared, label).toBe(true);

	// ---- NO TRACE: a reverted transaction, eth_call, eth_estimateGas, overrides ----
	expect(d.revertedSlotKeys, label).toEqual([]);
	expect(d.overriddenInAnyRecord, label).toBe(false);
	expect(d.openEmptyAfterPureReads, label).toBe(true);

	// ---- EACH CHEAT, AT THE BOTTOM LEVEL, RECORDS THE VALUE BEFORE IT ----
	const k = c.cheats;
	const x = k.x;
	const steps = [
		'setBalance',
		'setBalanceFresh',
		'setNonce',
		'setCode',
		'setStorageAt',
		'setAccount',
	];
	for (const s of steps)
		expect(k[s].sameInBlock, `${label}: ${s} belongs to the next block`).toBe(
			true,
		);
	expect(k.setBalance.open.accounts[x], label).toMatchObject({
		balance: '0x5',
		nonce: '0x3',
		codeHash: k.codeHash.c1,
	});
	expect(k.setBalanceFresh.open.accounts, label).toEqual({[k.fresh]: null});
	expect(k.setNonce.open.accounts[x], label).toMatchObject({
		balance: '0x64',
		nonce: '0x3',
	});
	// evm_setCode: the account's codeHash is rewritten by upstream's
	// modifyAccountFields route, i.e. the in-place mutation case.
	expect(k.setCode.open.accounts[x], label).toMatchObject({
		nonce: '0x7',
		codeHash: k.codeHash.c1,
	});
	expect(k.setCode.open.code, label).toEqual({[x]: '0x6001'});
	expect(k.setStorageAt.open.storage, label).toEqual({[k.slot1]: '0x9'});
	expect(k.setStorageAt.open.accounts, label).toEqual({});
	expect(k.setAccount.open.accounts[x], label).toMatchObject({
		balance: '0x64',
		nonce: '0x7',
		codeHash: k.codeHash.c2,
	});
	expect(k.setAccount.open.code, label).toEqual({[x]: '0x6002'});
	expect(k.setAccount.open.storage, label).toEqual({
		[k.slot1]: '0x2a',
		[k.slot2]: null,
	});

	// ---- BASELINES ARE NOT HISTORY ----
	const b = c.baselines;
	expect(b.afterConstruction.recording, label).toBe(true);
	expect(b.afterConstructionEmpty, label).toBe(true);
	expect(b.afterConstruction.headBlock, label).toBeNull();
	expect(b.beforeLoadEmpty, label).toBe(false);
	expect(b.afterLoadEmpty, label).toBe(true);
	expect(b.afterLoad.headBlock, label).toBeNull();
	expect(
		Object.keys(b.afterLoadAndMine.headBlock.accounts),
		`${label}: recording resumes after loadState`,
	).toEqual(['0x0000000000000000000000000000000000007777']);
	expect(b.afterPersistedLoadEmpty, label).toBe(true);

	// ---- FLAG OFF: nothing recorded ----
	expect(c.flagOff, label).toEqual({
		recording: false,
		headBlockIsUndefined: true,
		openIsUndefined: true,
	});
}
