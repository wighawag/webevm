/**
 * cheat-expected.ts: what ./helpers/cheat-checks.ts must observe, on every
 * engine. Shared by the three runs in cheat.spec.ts.
 *
 * The values pinned are the core's (packages/webevm, the done records of
 * `hardhat-and-anvil-names-for-the-state-cheats` and `snapshots-in-the-core`):
 * the aliased state cheats return `null` (as anvil does), except
 * `*_setStorageAt`, which returns `true`; `evm_mine` returns "0x0";
 * `anvil_mine` / `hardhat_mine` return `null`; a snapshot id is a quantity
 * from "0x0", and a revert returns `true`, then `false` for the consumed id.
 */
import {expect} from '@playwright/test';

const BALANCE = '0x1234';
const NONCE = '0x7';
const CODE = '0x602a60005260206000f3';
const WORD = `0x${'00'.repeat(31)}99`;
const FORTY_TWO = `0x${'00'.repeat(31)}2a`;

function assertScript(s: any) {
	for (const dialect of ['hardhat', 'anvil']) {
		const d = s[dialect];
		expect(d.results, dialect).toEqual({
			setBalance: {result: null},
			setNonce: {result: null},
			setCode: {result: null},
			setStorageAt: {result: true},
		});
		expect(d.after, dialect).toEqual({
			balance: BALANCE,
			nonce: NONCE,
			code: CODE,
			storage: WORD,
			call: FORTY_TWO,
		});
	}

	const m = s.mining;
	const moved = (r: any) => BigInt(r.after) - BigInt(r.before);
	expect(m.evmMine.result).toEqual({result: '0x0'});
	expect(moved(m.evmMine)).toBe(1n);
	expect(m.anvilMine.result).toEqual({result: null});
	expect(moved(m.anvilMine)).toBe(3n);
	expect(m.hardhatMine.result).toEqual({result: null});
	expect(moved(m.hardhatMine)).toBe(2n);

	// One counter for both names, as anvil has it.
	expect(s.snapshots.evm.id).toBe('0x0');
	expect(s.snapshots.anvil.id).toBe('0x1');
	for (const name of ['evm', 'anvil']) {
		const p = s.snapshots[name];
		expect(p.reverted, name).toEqual({result: true});
		expect(p.restored, name).toBe(true);
		expect(p.blockAfter, name).toBe(p.blockBefore);
		expect(p.again, name).toEqual({result: false});
	}
}

export function assertCheats(c: Record<string, any>, engineId: string) {
	// The battery really ran on the engine named, not silently on the default.
	expect(c.engineId).toBe(engineId);

	// 1. Each method has, through the dev node, the effect it has on the bare
	// node: the same answers and the same reads, call for call.
	expect(c.dev).toEqual(c.bare);
	// And that effect is the one the core defines (so two no-ops cannot match).
	assertScript(c.dev);

	// 2. A snapshot before a dev-account send, reverted after it, lets the same
	// account send again at the earlier nonce.
	const s = c.send;
	expect(s.first.status).toBe('0x1');
	expect(s.first.nonce).toBe('0x0');
	expect(s.nonceAtSnapshot).toBe('0x1');
	expect(s.inWindow.nonce).toBe('0x1');
	expect(s.inWindow.status).toBe('0x1');
	expect(s.nonceBeforeRevert).toBe('0x2');
	expect(s.reverted).toBe(true);
	expect(s.nonceAfterRevert).toBe('0x1');
	expect(s.inWindowAfterRevert).toBeNull();
	expect(s.balanceAfterRevert).toBe(s.balanceAtSnapshot);
	expect(s.again.nonce).toBe('0x1');
	expect(s.again.status).toBe('0x1');
	expect(s.nonceAfterAgain).toBe('0x2');
	expect(BigInt(s.recipientAfterAgain)).toBe(2n);
}
