/**
 * hardforks-expected.ts: the assertions on the hardfork battery
 * (helpers/hardforks.ts), shared by the default-engine spec and the revm one, so
 * both engines are held to ONE set of literals. Same node, same fork, same
 * request: the same number, whichever EVM is installed. It lives in its own
 * module because Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

/** 1000 non-zero calldata bytes: 21000 + 16 * 1000 intrinsic. */
const HEAVY_INTRINSIC = '37000';
/** ...and EIP-7623's floor for them: 21000 + 10 * 4000 tokens. */
const HEAVY_FLOOR = '61000';
const CAP = 16_777_216n;
const mined = (gasUsed: string, type = '0x2') => ({
	status: '0x1',
	gasUsed,
	type,
});

export function assertHardforks(c: Record<string, any>, label: string) {
	const f = c.perFork;
	expect(Object.keys(f), label).toEqual(['cancun', 'prague', 'osaka']);

	// ---- EIP-7623, the calldata floor: absent on Cancun, binding from Prague ----
	expect(f.cancun.floor, `${label}: cancun floor`).toEqual({
		estimate: HEAVY_INTRINSIC,
		belowFloor: mined(HEAVY_INTRINSIC),
		atEstimate: mined(HEAVY_INTRINSIC),
		chargedGas: HEAVY_INTRINSIC,
		callBelowFloor: '0x',
		callDefault: '0x',
	});
	for (const fork of ['prague', 'osaka']) {
		expect(f[fork].floor, `${label}: ${fork} floor`).toEqual({
			// the estimate IS the floor (the call executes nothing)...
			estimate: HEAVY_FLOOR,
			// ...a limit covering intrinsic gas but not the floor is refused, in
			// geth's words and at -32000, before any engine sees it...
			belowFloor: {
				refused: `-32000: insufficient gas for floor data gas cost: have ${HEAVY_INTRINSIC}, want ${HEAVY_FLOOR}`,
			},
			// ...the transaction at the estimate is mined and CHARGED the floor, on
			// the receipt and on the sender's balance alike...
			atEstimate: mined(HEAVY_FLOOR),
			chargedGas: HEAVY_FLOOR,
			// ...and a read that cannot reach the floor is refused too (100 gas of
			// execution budget plus 37000 intrinsic), while a default one runs.
			callBelowFloor: `threw -32000: insufficient gas for floor data gas cost: have 37100, want ${HEAVY_FLOOR}`,
			callDefault: '0x',
		});
	}

	// ---- EIP-7825, the per-transaction gas cap: Osaka only ----
	for (const fork of ['cancun', 'prague']) {
		expect(f[fork].cap, `${label}: ${fork} has no cap`).toEqual({
			overCap: mined('21000'),
			atCap: mined('21000'),
			callOverCap: '0x',
			defaultBudget: '30000000',
			estimateCeiling: expect.stringContaining(
				'threw -32000: gas required exceeds allowance (30000000)',
			),
			fillOverCap: 'filled',
		});
	}
	expect(f.osaka.cap, `${label}: osaka cap`).toEqual({
		overCap: {
			refused: `-32000: transaction gas limit too high (cap: ${CAP}, tx: ${CAP + 1n})`,
		},
		atCap: mined('21000'),
		// A READ is not held to the cap, as on geth: 20,000,000 of execution budget
		// runs, and the default budget is the same 30,000,000 as on every fork. The
		// revm engine lifts the cap on its reads (`disableTxGasLimitCap`).
		callOverCap: '0x',
		defaultBudget: '30000000',
		estimateCeiling: expect.stringContaining(
			`threw -32000: gas required exceeds allowance (${CAP})`,
		),
		fillOverCap: `threw -32000: transaction gas limit too high (cap: ${CAP}, tx: ${CAP + 1n})`,
	});

	// ---- EIP-7702, set-code transactions: Prague on ----
	expect(f.cancun.setCode, `${label}: cancun has no type 4`).toEqual({
		estimateWithout: '21000',
		estimateWrongChain:
			"threw -32602: authorizationList is an EIP-7702 field, and this node runs 'cancun', which predates it",
		estimateWith:
			"threw -32602: authorizationList is an EIP-7702 field, and this node runs 'cancun', which predates it",
		skipped: {
			refused:
				"-32000: transaction type not supported: a type-4 (EIP-7702) transaction needs Prague or later, and this node runs 'cancun'",
		},
		codeAfterSkipped: '0x',
		delegated: {
			refused:
				"-32000: transaction type not supported: a type-4 (EIP-7702) transaction needs Prague or later, and this node runs 'cancun'",
		},
		authorityCode: '0x',
		authorityNonce: '0x0',
		authoritySlot1: '0x' + '00'.repeat(32),
		callAfter: '0x',
	});
	for (const fork of ['prague', 'osaka']) {
		expect(f[fork].setCode, `${label}: ${fork} set-code`).toEqual({
			// without the list the request is a bare transfer to an EOA...
			estimateWithout: '21000',
			// ...an authorization for another chain is charged (25000) and skipped...
			estimateWrongChain: '46000',
			// ...and with a valid one the estimate executes the DELEGATED code: the
			// cold SSTORE in the authority's storage, plus the 25000 per entry. It is
			// above what the mined transaction uses by the 12500 refunded for an
			// authority that already exists, which the estimate does not subtract.
			estimateWith: '68106',
			skipped: mined('46000', '0x4'),
			codeAfterSkipped: '0x',
			delegated: mined('55606', '0x4'),
			authorityCode: '0xef010000000000000000000000000000000000de1e6a7e',
			authorityNonce: '0x1',
			authoritySlot1:
				'0x000000000000000000000000000000000000000000000000000000000000002a',
			callAfter: '0x',
		});
	}

	// ---- Osaka's opcode and precompiles, priced the same by both engines ----
	const modexp =
		'0x02e05f7a834a73fcd5459f719e8267d7ff81aba96edafb1b5108a34aa7b39191';
	expect(f.cancun.osakaOpcodes, `${label}: cancun opcodes`).toEqual({
		clz: 'threw 3: execution reverted',
		modexpEstimate: '23820',
		modexpResult: modexp,
		// no precompile there: the call costs its calldata and nothing else
		p256Estimate: '23560',
		p256Result: '0x',
	});
	expect(f.prague.osakaOpcodes, `${label}: prague opcodes`).toEqual({
		clz: 'threw 3: execution reverted',
		modexpEstimate: '24650',
		modexpResult: modexp,
		// still no precompile, and EIP-7623's floor (21000 + 10 * 640) binds
		p256Estimate: '27400',
		p256Result: '0x',
	});
	expect(f.osaka.osakaOpcodes, `${label}: osaka opcodes`).toEqual({
		clz: '255',
		// EIP-7883 re-priced MODEXP
		modexpEstimate: '26540',
		modexpResult: modexp,
		// EIP-7951's P256VERIFY costs 6900 on top of the 23560, and an invalid
		// signature returns no data
		p256Estimate: '30460',
		p256Result: '0x',
	});

	// ---- EIP-2935 changes no opcode, and the history contract is absent ----
	for (const fork of ['cancun', 'prague', 'osaka'])
		expect(f[fork].blockHash, `${label}: ${fork} blockhash`).toEqual({
			head: '3',
			blockhashOfParentIsTheParent: true,
			historyContractCode: '0x',
		});

	// ---- the fork is part of the chain: recorded, reloaded, and enforced ----
	for (const [fork, other] of [
		['cancun', 'osaka'],
		['prague', 'osaka'],
		['osaka', 'prague'],
	])
		expect(f[fork].dump, `${label}: ${fork} dump`).toEqual({
			dumpHardfork: fork,
			minedAfterReload: '3',
			parentIsTheDumpedHead: true,
			refusedElsewhere: `webevm: this state was dumped from a node running hardfork '${fork}' and this node runs '${other}'`,
			refusedElsewhereNamesTheOption: true,
		});
}
