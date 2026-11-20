/**
 * state-cheat-aliases-expected.ts: the assertions on the state-cheat-alias
 * battery (helpers/state-cheat-aliases.ts), shared by the default-engine spec
 * and the revm one, so both engines are held to ONE contract. It lives in its
 * own module because Playwright refuses to let one spec file import another.
 *
 * The return values and the validation are pinned against the two nodes' own
 * source, cited at the cheats in src/node.ts: anvil
 * (crates/anvil/core/src/eth/mod.rs and crates/anvil/src/eth/api.rs) and Hardhat
 * (EDR, crates/edr_provider/src/requests/hardhat/state.rs and
 * crates/edr_provider/src/data.rs, plus Hardhat Network's JSON-RPC reference).
 */
import {expect} from '@playwright/test';

const WORD =
	'0x000000000000000000000000000000000000000000000000000000000000002a';
const ZERO =
	'0x0000000000000000000000000000000000000000000000000000000000000000';
const READER_CODE = '0x60005460005260206000f3';

export function assertStateCheatAliases(c: Record<string, any>, label: string) {
	// ---- the same effect as the `evm_*` cheat, under every name ----
	const e = c.sameEffect;
	expect(e.evm.results, `${label}: evm_* return true`).toEqual([
		true,
		true,
		true,
		true,
	]);
	for (const ns of ['hardhat', 'anvil']) {
		const r = e[ns];
		const l = `${label}: ${ns}_*`;
		// anvil's answers, under both names: () for balance/nonce/code, true for
		// storage. Hardhat itself answers true for all four (src/node.ts).
		expect(r.results, `${l} return anvil's results`).toEqual([
			null,
			null,
			null,
			true,
		]);
		expect(r.rootMoved, `${l} move getStateRoot()`).toBe(true);
		expect(r.rootAfterCheats, `${l} getStateRoot() as evm_*`).toBe(
			e.evm.rootAfterCheats,
		);
		expect(r.minedRoot, `${l} the next block's root as evm_*`).toBe(
			e.evm.minedRoot,
		);
		expect(r.minedHash, `${l} the next block as evm_*`).toBe(e.evm.minedHash);
		expect(r.history, `${l} the change set as evm_*`).toEqual(e.evm.history);
		expect(r.dumpHasHistory, `${l} the dump carries the undo log`).toBe(true);
		expect(r.sameDumpAsEvm, `${l} the whole dump as evm_*`).toBe(true);
		expect(r.txStatus, `${l} a tx at the cheated nonce`).toBe('0x1');
		expect(r.call, `${l} the engine runs the cheated code`).toBe(WORD);
	}
	// What the evm_* run itself shows, so the comparison is not of two nothings.
	const h = e.evm.history;
	expect(h.balanceBefore, `${label}: before the cheats`).toBe('0x0');
	expect(h.balanceAt, `${label}: at the cheats' block`).toBe(
		'0x' + (10n ** 21n).toString(16),
	);
	expect(h.nonceBefore, label).toBe('0x0');
	expect(h.nonceAt, label).toBe('0x5');
	expect(h.codeBefore, label).toBe('0x');
	expect(h.codeAt, label).toBe(READER_CODE);
	expect(h.slotBefore, label).toBe(ZERO);
	expect(h.slotAt, label).toBe(WORD);
	expect(e.evm.minedRoot, `${label}: the block's root is real`).toBe(
		e.evm.rootAfterCheats,
	);
	expect(e.evm.txStatus, label).toBe('0x1');
	expect(e.evm.call, label).toBe(WORD);

	// ---- persistence: saved by the mine, not the cheat, as for evm_* ----
	const p = c.persistence;
	expect(p.evm.afterCheats, `${label}: an evm_* cheat does not save`).toBe(0);
	expect(p.evm.afterMine, `${label}: the mine saves`).toBe(1);
	for (const ns of ['hardhat', 'anvil']) {
		expect(
			{afterCheats: p[ns].afterCheats, afterMine: p[ns].afterMine},
			`${label}: ${ns}_* save as evm_*`,
		).toEqual({afterCheats: 0, afterMine: 1});
		expect(p[ns].sameSavedAsEvm, `${label}: ${ns}_* save the same state`).toBe(
			true,
		);
	}

	// ---- viem's test client in hardhat and anvil modes ----
	for (const mode of ['hardhat', 'anvil']) {
		const v = c.viem[mode];
		const l = `${label}: viem ${mode} mode`;
		expect(v.results, `${l} actions resolve`).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(v.balance, l).toBe('0x' + (10n ** 21n).toString(16));
		expect(v.nonce, l).toBe('0x5');
		expect(v.code, l).toBe(READER_CODE);
		expect(v.slot, l).toBe(WORD);
		expect(v.sameRootAsEvm, `${l} leaves the evm_* root`).toBe(true);
		expect(v.txStatus, l).toBe('0x1');
		expect(v.call, l).toBe(WORD);
	}

	// ---- the aliases' validation ----
	for (const ns of ['hardhat', 'anvil']) {
		const r = c.refusals[ns];
		const l = `${label}: ${ns}_*`;
		for (const [name, o] of Object.entries(r.refused) as [string, any][]) {
			expect(o.code, `${l} refuses ${name} with -32602`).toBe(-32602);
			expect(o.message, `${l} names the method (${name})`).toContain(`${ns}_`);
		}
		expect(r.stateUnmoved, `${l} a refusal writes nothing`).toBe(true);
		const a = r.accepted;
		expect(a.balanceMax, l).toEqual({accepted: null});
		expect(a.balanceDecimal, l).toEqual({accepted: null});
		expect(a.balanceNumber, l).toEqual({accepted: null});
		expect(a.nonceMax, l).toEqual({accepted: null});
		// anvil lowers a nonce; Hardhat would refuse it (src/node.ts).
		expect(a.nonceLowered, `${l} lowers a nonce, as anvil`).toEqual({
			accepted: null,
		});
		expect(a.nonceAfterLowering, l).toBe('0x3');
		expect(a.codeEmpty, l).toEqual({accepted: null});
		expect(a.storageWordSlot, `${l} a 32-byte slot`).toEqual({accepted: true});
		expect(a.storageWordSlotRead, l).toBe(WORD);
	}
	expect(c.refusals.evmShortValue, `${label}: evm_* still pads`).toEqual({
		result: {accepted: true},
		read: WORD,
	});
}
