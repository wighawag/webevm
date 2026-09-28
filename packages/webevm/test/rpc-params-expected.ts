/**
 * rpc-params-expected.ts: the assertions on the state-override battery
 * (helpers/rpc-params.ts), shared by the default-engine spec (run without AND
 * with `computeStateRoot`) and the revm one, so the three runs are held to ONE contract.
 */
import {expect} from '@playwright/test';

const ZERO_WORD = '0x' + '00'.repeat(32);

export function assertStateOverrides(c: Record<string, any>, label: string) {
	// The probe returns [slot0, slot1, selfbalance]. Real state: 9, 8, 100.
	expect(c.probeBefore, label).toEqual(['9', '8', '100']);
	// stateDiff PATCHES one slot, state REPLACES the whole storage, balance is
	// the balance. Before the fix, all three read ['9', '8', '100'].
	expect(c.probeStateDiff, label).toEqual(['9', '3', '100']);
	expect(c.probeState, label).toEqual(['0', '3', '100']);
	expect(c.probeBalance, label).toEqual(['9', '8', '1000']);
	// ...and none of them is left behind.
	expect(c.probeAfter, label).toEqual(['9', '8', '100']);

	// Code, balance, nonce and storage on an EMPTY address: all seen, none kept.
	expect(c.fresh, label).toEqual(['5', '7', '1000']);
	expect(c.freshAfter, label).toEqual({
		code: '0x',
		balance: '0x0',
		nonce: '0x0',
		slot0: ZERO_WORD,
	});

	// A real contract's storage, overridden, then plain again.
	expect(c.counterOverridden, label).toBe('42');
	expect(c.counterAfter, label).toBe('1');

	// An overridden call that REVERTS still unwinds its overrides.
	expect(c.reverted, label).toMatchObject({code: 3});
	expect(c.afterRevert, label).toEqual({number: '1', codeUnchanged: true});

	// eth_estimateGas sees the override too.
	expect(c.estimatePlain, label).toEqual({ok: '0x5208'});
	expect(BigInt(c.estimateOverridden.ok), label).toBeGreaterThan(21000n);

	// Refused loudly, never run without the part it could not honour, and the
	// refusal leaves nothing applied.
	expect(c.unsupportedField, label).toMatchObject({code: -32602});
	expect(c.unsupportedField.message).toContain('movePrecompileToAddress');
	expect(c.bothStateAndDiff, label).toMatchObject({code: -32602});
	expect(c.blockOverrides, label).toMatchObject({code: -32602});
	for (const [name, o] of Object.entries(c.malformed as Record<string, any>))
		expect(o, `${label}: malformed ${name}`).toMatchObject({code: -32602});
	expect(c.probeAfterRefusals, label).toEqual(['9', '8', '100']);

	// The chain keeps mining against the real state afterwards.
	expect(c.counterAfterMining, label).toBe('2');
}
