/**
 * revm-engine.spec.ts — `webevm/revm` in real browsers:
 *   - the node runs its READ path on revm-wasm and says so
 *   - results and gas are IDENTICAL to the default `@ethereumjs/evm` engine
 *   - revm reads the node's own state (a mined tx is visible with no sync step)
 *   - an `eth_call` on revm cannot mutate state (it reaches no write callback)
 *   - a signed value transfer EXECUTES ON REVM and COMMITS, with a receipt and a
 *     post-state `@ethereumjs/evm` cannot be told apart from, no simulation
 *     switch anywhere near it, and the nonce check on
 *   - a read from an UNFUNDED address and from an address HOLDING CODE works on
 *     both engines, with the same result and the same gas
 *   - a VALUE-BEARING read succeeds or fails IDENTICALLY on both engines: the
 *     simulation switches relax a transaction's validity rules, never the value
 *     transfer itself — and the failure is checked for its SHAPE (it starts at
 *     exactly `balance + 1`, returns no callee answer, and names a shortfall of
 *     funds in each engine's own words), never merely for having happened
 *   - the `data` an `eth_call` failure carries is IDENTICAL on both engines: `0x`
 *     for a refused transfer (no engine text forwarded as a revert payload) and
 *     the callee's own bytes when a contract really reverted
 *   - the BLOCK ENVIRONMENT a contract reads (BASEFEE / PREVRANDAO / COINBASE /
 *     NUMBER / TIMESTAMP / GASLIMIT) is the node's own, and identical on both
 *   - BLOCKHASH answers with the node's real block hashes
 *   - both wasm delivery shapes (bundler-resolved asset, runtime-fetched URL)
 *   - `stateMode:'trie'` is SERVED (a real root in the header and from
 *     `getStateRoot()`), since the trie is derived from the flat state
 *   - an engine asked for a read BEFORE a node bound it refuses, rather than
 *     costing that read at a fork the caller never chose
 *   - the two exported hardfork tables cannot be EDITED by a consumer, so the
 *     construction guard cannot be assigned away from outside
 *   - a hardfork the node cannot cost CORRECTLY is refused at construction,
 *     naming the EIP and where to look — whether revm enforces a rule the node
 *     does not implement, or the two implement one the protocol does not have
 *   - on every hardfork the engine DOES admit, what the node hands it is
 *     accepted: the estimate for a calldata-heavy call and the default read
 *     budget both survive revm's own transaction validation, AND the node
 *     charges EVERY term of the shared intrinsic-gas formula exactly what the
 *     protocol charges there — with the formula's LOWER bound (EIP-2028,
 *     Istanbul) measured from both sides, since no admitted fork spans it
 *   - a CREATE-shaped `eth_estimateGas` returns the SAME number on both engines
 *     at every admitted fork, pre-Shanghai ones included, and that number is
 *     what the protocol charges
 *   - one engine instance serves one node (a second `createNode()` is refused)
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {mountHarness} from 'playwright-browser-harness';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// Its OWN cut: this bundle carries the revm `.wasm`, and the shared cut must
// keep costing the other specs nothing (see helpers/cut-revm.ts).
const cut = resolve(here, './helpers/cut-revm.ts');
// Served next to the bundle so the RUNTIME-FETCHED delivery shape has a URL to
// fetch. The bundler-resolved shape needs no help: the cut imports it.
const revmWasm = require.resolve('revm-wasm/revm.wasm');

/** Reference execution gas — identical on `@ethereumjs/evm` and revm-wasm. */
const REF = {
	number: '2446',
	sumTo2000: '498689',
	keccakLoop2000: '1107052',
	keccakResult:
		'0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a',
};

test('revm engine: same results + same gas as @ethereumjs/evm, on the node own state', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The BUNDLER-RESOLVED delivery shape: `import ... from 'revm-wasm/revm.wasm'`
		// in the cut, built into the bundle as bytes. The harness's built-in `.wasm`
		// loader is `copy`, which leaves a real module import the browser then refuses
		// to execute (`MIME type application/wasm`), so the suite picks the asset
		// loader a consumer's bundler would give it.
		esbuild: {loader: {'.wasm': 'binary'}},
		// ...and the RUNTIME-FETCHED shape needs the same file served next to the
		// bundle, exactly as a consumer would host it.
		assets: [revmWasm],
	});
	const r = await h.run({
		phase: 'once',
		params: {
			mode: 'revm-engine',
			runtimeWasmUrl: new URL('revm.wasm', h.serverUrl).href,
		},
	});

	console.log('\n[revm-engine] errors:', r.errors);
	const c = r.results.revmEngine as Record<string, any>;
	console.log('[revm-engine]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// the node reports which EVM ran its reads
	expect(c.defaultEngineId).toBe('@ethereumjs/evm');
	expect(c.revmEngineId).toBe(c.revmEngineIdExpected);
	expect(c.sameDeployAddress).toBe(true);

	// identical results and identical gas, engine against engine
	expect(c.resultsMatch).toBe(true);
	expect(c.gasMatches).toBe(true);
	// ...and the reference numbers, so a wrong answer is obvious
	expect(c.executionGas['number.revm']).toBe(REF.number);
	expect(c.executionGas['sumTo2000.revm']).toBe(REF.sumTo2000);
	expect(c.executionGas['keccakLoop2000.revm']).toBe(REF.keccakLoop2000);
	expect(c.callResults['keccakLoop2000.revm']).toBe(REF.keccakResult);

	// the engine reads the node's AUTHORITATIVE state — no sync step
	expect(c.txStatus).toBe('success');
	expect(c.numberAfterTx).toBe('1');

	// a read cannot mutate: eth_call increment() left slot 0 alone, and it is
	// STRUCTURAL rather than careful — a `Revm#call` asked to commit reaches no write
	// callback at all. An unbound store additionally refuses every write out loud.
	expect(c.callDidNotMutateState).toBe(true);
	expect(BigInt(c.storageAfterCall)).toBe(1n);
	expect(c.readWriteCallbacks).toEqual([]);
	expect(c.unboundWriteMethodsThrow).toBe(true);

	// every caller a SIMULATION must serve works, on both engines: funded,
	// unfunded (what the zeroed base fee used to buy), and holding code (EIP-3607,
	// which the default engine's runCall never enforced). A refusal on either
	// engine is a divergence.
	expect(c.callerErrors).toEqual({});
	expect(c.callerResultsMatch).toBe(true);
	expect(c.callerGasMatches).toBe(true);
	expect(c.callerResultsAgree).toBe(true);
	// sumTo(4) == 0+1+2+3 == 6, from a caller that holds code.
	expect(BigInt(c.callerResults['contract.revm'])).toBe(6n);

	// a VALUE-BEARING read is relaxed in its VALIDITY rules, never in its
	// TRANSFER: an unaffordable value fails on both engines (geth's `eth_call`
	// fails it too, with ErrInsufficientBalance), an affordable one succeeds on
	// both, and a zero-value read from an address holding nothing still works.
	// Both engines are held to the absolute statement, not merely to each other.
	expect(c.valueOutcomesMatch).toBe(true);
	expect(c.valueOutcomes).toEqual(
		Object.fromEntries(
			Object.entries(c.valueExpected).flatMap(([name, want]) => [
				[`${name}.default`, want],
				[`${name}.revm`, want],
			]),
		),
	);
	expect(c.valueOutcomesCorrect).toBe(true);
	// ...and the `data` the failure carries is the SAME on both engines, because
	// `data` on an `execution reverted` error means one thing to a client: the
	// CALLEE's revert payload. A refused transfer produces none on either engine
	// (revm's own `Transaction(LackOfFundForMaxFee { .. })` text is NOT forwarded
	// as return data), and a callee that really reverted still delivers its own
	// bytes on both, so the fix that drops the engine's text swallows no answer.
	expect(c.errorData['unaffordable.default']).toBe(
		c.errorDataExpected.unaffordable,
	);
	expect(c.errorData['unaffordable.revm']).toBe(
		c.errorDataExpected.unaffordable,
	);
	expect(c.errorData['calleeRevert.default']).toBe(
		c.errorDataExpected.calleeRevert,
	);
	expect(c.errorData['calleeRevert.revm']).toBe(
		c.errorDataExpected.calleeRevert,
	);
	// ...and the rejection is an AFFORDABILITY rejection, read at the engine seam
	// (the node flattens every engine failure into one `execution reverted`, so
	// the words only exist below it). Both engines are held to the same sentence:
	// value == balance succeeds, value == balance + 1 fails, names a lack of
	// funds, carries no callee answer. A `catch`-anything bar would pass with any
	// of those four clauses false.
	expect(c.valueSeamOutcomes.default).toBe(c.valueSeamExpected);
	expect(c.valueSeamOutcomes.revm).toBe(c.valueSeamExpected);
	// ...on the fork the NODE pins, read off a real `createNode()` rather than
	// named a second time here — and that fork must be one the engine ADMITS, or
	// the revm half of the probe could not have connected at all.
	expect(c.seamHardforkIsAdmitted).toBe(true);
	expect(c.admittedHardforks).toContain(c.seamHardfork);
	// The two engines say it in their OWN words, which is why the predicate above
	// is a vocabulary rather than a string: neither message may be asserted on the
	// other engine.
	expect(c.valueFailureShapes.default).toMatch(/insufficient balance/i);
	expect(c.valueFailureShapes.revm).toMatch(/LackOfFundForMaxFee/);
	// ...and that vocabulary REFUSES every other failure this read path produces,
	// so an unrelated error cannot be mistaken for an unaffordable transfer.
	expect(c.lackOfFundsVocabularyRejects).toBe(true);
	// ...and the NEGATIVE CONTROL those bars issue is bytecode every admitted fork
	// can actually run, not only the one the node pins today: an invalid opcode
	// fails a call too, so a control a fork cannot execute would pass as the
	// control working while measuring nothing.
	expect(Object.keys(c.controlAtFork).length).toBeGreaterThan(1);
	for (const [hardfork, outcome] of Object.entries(c.controlAtFork))
		expect(`${hardfork}: ${outcome}`).toBe(
			`${hardfork}: ${c.controlAtForkExpected}`,
		);

	// the BLOCK ENVIRONMENT read through a contract is the node's own, and the
	// SAME on both engines. Gas cannot see this class of bug: these opcodes are
	// fee-independent, so an engine running the read against a block the node
	// never had still charges byte-identical gas.
	expect(c.blockEnvMatches).toBe(true);
	expect(c.blockEnvOnRevm).toEqual(c.blockEnvExpected);
	// ...and specifically NOT the zeroed base fee the engine used to force.
	expect(BigInt(c.blockEnvOnRevm.basefee)).toBe(7_000_000_000n);
	expect(BigInt(c.blockEnvOnRevm.prevrandao)).not.toBe(0n);

	// BLOCKHASH is wired to the node's OWN blocks (an unwired one answers zero,
	// silently). Each node is its own chain, so each is checked against itself.
	expect(c['blockHash.revm']).toBe(c['blockHashExpected.revm']);
	expect(c['blockHash.default']).toBe(c['blockHashExpected.default']);
	expect(BigInt(c['blockHash.revm'])).not.toBe(0n);

	// the runtime-fetched-URL delivery shape produces a working engine too
	expect(c.runtimeUrlEngineId).toBe(c.revmEngineIdExpected);
	expect(c.runtimeUrlCall).toBe(c.runtimeUrlCallExpected);
	expect(BigInt(c.runtimeUrlCall)).not.toBe(0n);

	// trie mode is SERVED on revm (it used to be refused at construction): the
	// block revm executed carries a real root, the node reports the same one, and
	// it moved from genesis.
	const t = c.trieServed;
	expect(t.engineId).toBe('revm-wasm');
	expect(t.stateMode).toBe('trie');
	expect(t.status).toBe('0x1');
	expect(t.headerRoot).toMatch(/^0x[0-9a-f]{64}$/);
	expect(BigInt(t.headerRoot)).not.toBe(0n);
	expect(t.liveRoot).toBe(t.headerRoot);
	expect(t.genesisRoot).not.toBe(t.headerRoot);

	// ...and an engine asked to READ before a node bound it refuses too, naming
	// what is missing and what to do. `createNode()` always connects first, so this
	// edge is reachable only by hand-driving an `Engine` — which is why nothing
	// but this assertion keeps it alive through a refactor. Guessing a fork here
	// would answer with an estimate computed under rules the caller never chose.
	expect(c.unboundCallRefusal).not.toBe('DID_NOT_THROW');
	expect(c.unboundCallRefusal).toContain('connect()');
	expect(c.unboundCallRefusal).toContain('intrinsic gas');
	expect(c.unboundCallRefusal).toMatch(/createNode/i);

	// a HARDFORK the engine cannot cost is refused the same way. The node runs
	// Cancun, so this guard is unreachable through `createNode()` — which is the
	// point: it fires the day the node's hardfork moves, instead of the node
	// quietly charging pre-Prague intrinsic gas against post-Prague enforcement
	// (above the admitted range) or post-Shanghai intrinsic gas on a pre-Shanghai
	// fork (below it).
	expect(c.refusedHardforks).toEqual(['prague', 'osaka']);
	expect(c.hardforkRefusals.prague).not.toBe('DID_NOT_THROW');
	expect(c.hardforkRefusals.prague).toContain('EIP-7623');
	expect(c.hardforkRefusals.prague).toContain('intrinsic-gas.ts');
	expect(c.hardforkRefusals.osaka).not.toBe('DID_NOT_THROW');
	expect(c.hardforkRefusals.osaka).toContain('EIP-7825');
	for (const message of Object.values(c.hardforkRefusals) as string[]) {
		// every refusal names the ADR a reader should go and read
		expect(message).toContain('docs/adr/0008-');
	}
	// ...and the fork the node actually runs is untouched
	expect(c.cancunAdmitted).toBe(true);
	expect(c.admittedHardforks).toEqual([
		'berlin',
		'london',
		'paris',
		'shanghai',
		'cancun',
	]);

	// ...AND THAT GUARD CANNOT BE ASSIGNED AWAY. The tables are public so "which
	// forks does this engine serve" is answerable without provoking a throw, and
	// `Readonly` is erased at runtime, so before `Object.freeze` one assignment from
	// outside re-admitted a fork whose estimate revm itself rejects. Measured as a
	// runtime property (a type cannot be measured): both tables report frozen, the
	// two edits a re-admitter would make leave them exactly as they were, and the
	// construction guard still refuses `prague` afterwards in the same words.
	expect(c.tablesFrozen).toBe(true);
	expect(c.admittedAfterEditAttempt).toEqual([
		'berlin',
		'london',
		'paris',
		'shanghai',
		'cancun',
	]);
	expect(c.refusedAfterEditAttempt).toEqual(['prague', 'osaka']);
	expect(c.pragueRefusalAfterEditAttempt).toBe(c.hardforkRefusals.prague);
	expect(c.pragueRefusalAfterEditAttempt).toContain('EIP-7623');
	// ...and the write FAILS AT THE CONSUMER'S OWN LINE, which is the half a
	// consumer is told about and the half the readings above cannot see: a
	// sloppy-mode caller gets the unchanged table WITHOUT the throw, so neither
	// implies the other. These modules are ESM and therefore strict, so both edits
	// must throw here. The message is the browser's own words (V8 and JSC word it
	// differently), so what is pinned is that it threw, not what it said.
	expect(c.tableEditOutcomes['admit prague']).toMatch(/^threw: /);
	expect(c.tableEditOutcomes['drop the prague refusal']).toMatch(/^threw: /);

	// THE INVARIANT, asserted against the engine itself: on every hardfork the
	// table admits, the number `eth_estimateGas` returned for a calldata-heavy
	// call is a gas limit revm RUNS, and so is the node's default read budget.
	// viem uses an estimate as the transaction's gas limit, so a rejection here
	// would reach the user as "out of gas" with no warning.
	expect(c.heavyEstimatesMatch).toBe(true);
	expect(BigInt(c.heavyEstimates.revm)).toBe(21_000n + 1000n * 16n);
	for (const hardfork of c.admittedHardforks as string[]) {
		expect(`${hardfork}: ${c.estimateVerdicts[hardfork]}`).toBe(
			`${hardfork}: accepted`,
		);
		expect(`${hardfork}: ${c.budgetVerdicts[hardfork]}`).toBe(
			`${hardfork}: accepted`,
		);
	}
	// ...and the refusals are load-bearing: the SAME numbers are rejected on the
	// specs the table does not admit.
	expect(c.estimateOnPrague).toContain('GasFloorMoreThanGasLimit');
	expect(c.budgetOnOsaka).toContain('TxGasLimitGreaterThanCap');

	// AND THE PROTOCOL GETS A VOTE, because the node and revm agree about
	// intrinsic gas by construction (the engine subtracts what the node adds), so
	// a term that is wrong AT A FORK is wrong on both sides and their agreement
	// cannot see it. This is ADR 0008's clause (b), and it covers EVERY term the
	// shared formula bakes in — not only the fork-gated one: each term is isolated
	// by a delta between two probe transactions and read three ways at every
	// admitted fork (the protocol, via the `@ethereumjs/tx` arithmetic this node's
	// own `runTx` charges; revm, MEASURED; the node's `intrinsicGas()`, measured
	// the same way). The list is asserted too, so a term cannot quietly leave it.
	expect(c.intrinsicTermNames).toEqual([
		'transaction base',
		'non-zero calldata byte (EIP-2028)',
		'zero calldata byte',
		'creation base (EIP-2)',
		'initcode word (EIP-3860)',
	]);
	expect(c.intrinsicTermDisagreements).toEqual([]);
	// ...and against the ABSOLUTE numbers at both ends of the admitted range, not
	// merely against each other: three parties agreeing is what the pre-0.3.1 world
	// looked like while two of them were wrong.
	expect(c.intrinsicTermReadings.berlin).toEqual({
		'transaction base': {revm: '21000', protocol: '21000', node: '21000'},
		'non-zero calldata byte (EIP-2028)': {
			revm: '16',
			protocol: '16',
			node: '16',
		},
		'zero calldata byte': {revm: '4', protocol: '4', node: '4'},
		'creation base (EIP-2)': {revm: '32000', protocol: '32000', node: '32000'},
		'initcode word (EIP-3860)': {revm: '0', protocol: '0', node: '0'},
	});
	expect(c.intrinsicTermReadings.cancun).toEqual({
		'transaction base': {revm: '21000', protocol: '21000', node: '21000'},
		'non-zero calldata byte (EIP-2028)': {
			revm: '16',
			protocol: '16',
			node: '16',
		},
		'zero calldata byte': {revm: '4', protocol: '4', node: '4'},
		'creation base (EIP-2)': {revm: '32000', protocol: '32000', node: '32000'},
		'initcode word (EIP-3860)': {revm: '2', protocol: '2', node: '2'},
	});
	// ...and the fork-gated term is additionally read off `@ethereumjs/common`'s
	// ACTIVATION table, which is the form the gate itself is written in
	// (`common.isActivatedEIP(3860)` in src/intrinsic-gas.ts).
	for (const hardfork of c.admittedHardforks as string[]) {
		const want = c.eip3860Active[hardfork] ? '2' : '0';
		const r = c.intrinsicTermReadings[hardfork]['initcode word (EIP-3860)'];
		expect(
			`${hardfork}: EIP-3860 ${c.eip3860Active[hardfork]}, ` +
				`revm ${r.revm}/word, protocol ${r.protocol}/word, node ${r.node}/word`,
		).toBe(
			`${hardfork}: EIP-3860 ${c.eip3860Active[hardfork]}, ` +
				`revm ${want}/word, protocol ${want}/word, node ${want}/word`,
		);
	}
	// ...and that term's readings are only load-bearing because the admitted set
	// SPANS the EIP-3860 boundary: an ungated formula would satisfy all of them if
	// every admitted fork charged the term. These three are the forks the fork gate
	// exists for. Measurements:
	// docs/spikes/intrinsic-gas-charges-eip-3860-on-forks-that-predate-it/ (§6).
	expect(c.admittedPreEip3860).toEqual(['berlin', 'london', 'paris']);

	// THE OTHER BOUNDARY, which no admitted fork can span: EIP-2028 (Istanbul) set
	// the 16-gas non-zero calldata byte, and every admitted fork is at or above
	// Istanbul, so the per-fork readings above would ALSO pass with a formula that
	// simply hardcodes 16 — which is exactly what `intrinsicGas()` does. What makes
	// that term's check load-bearing rather than decorative is measuring the
	// boundary itself from BOTH sides, on specs the engine does not admit: at
	// `istanbul` (the floor of the range the formula is true for) all three parties
	// agree, and one fork BELOW it they part company, with the node under-charging
	// by 52 gas per non-zero byte. An under-estimate is what reaches a user as "out
	// of gas", because a client uses an estimate as the transaction's gas limit.
	expect(c.lowerBoundDisagreements.istanbul).toEqual([]);
	expect(c.lowerBoundDisagreements.petersburg).toEqual([
		'petersburg/non-zero calldata byte (EIP-2028): ' +
			'revm 68, protocol 68, node 16',
	]);
	expect(
		c.lowerBoundReadings.petersburg['non-zero calldata byte (EIP-2028)'],
	).toEqual({revm: '68', protocol: '68', node: '16'});
	// ...and neither of those two forks can be reached by accident: they are in
	// NEITHER table, so the engine refuses them at construction. Re-admitting one
	// means moving it INTO the admitted table, which puts it into the per-fork loop
	// above and turns the disagreement just measured into a failing build.
	expect(c.belowAdmittedRefusals.petersburg).toContain(
		"no revm spec is known for hardfork 'petersburg'",
	);
	expect(c.belowAdmittedRefusals.istanbul).toContain(
		"no revm spec is known for hardfork 'istanbul'",
	);

	// THE DIVERGENCE THIS CHANGE CLOSED, asserted where it lives: a CREATE-shaped
	// `eth_estimateGas`, engine against engine, at every admitted fork. The default
	// engine's estimate moves with the node's formula (`runCall` charges no
	// intrinsic gas) and the revm engine's does not (it subtracts the same formula
	// from revm's `totalGasSpent` and the node adds it back), so an EIP-3860 term
	// charged on a fork that predates it splits them by 2 gas per initcode word.
	expect(c.createEstimatesMatch).toBe(true);
	// ...against the ABSOLUTE numbers, not merely against each other, because two
	// engines can agree on a number neither should have given — which is exactly
	// what they did before `revm-wasm@0.3.1`. 64-byte initcode (2 words) deploying
	// empty code: 6 gas of execution on top of the intrinsic cost.
	for (const hardfork of ['berlin', 'london', 'paris']) {
		expect(`${hardfork}: ${JSON.stringify(c.createEstimates[hardfork])}`).toBe(
			`${hardfork}: {"default":"53298","revm":"53298"}`,
		);
	}
	for (const hardfork of ['shanghai', 'cancun']) {
		expect(`${hardfork}: ${JSON.stringify(c.createEstimates[hardfork])}`).toBe(
			`${hardfork}: {"default":"53302","revm":"53302"}`,
		);
	}
	// ...and that estimate is a gas limit revm RUNS the same CREATE within, on every
	// admitted spec — the same bar the calldata-heavy CALL above is held to, applied
	// to the shape the EIP-3860 term actually reaches.
	for (const hardfork of c.admittedHardforks as string[]) {
		expect(`${hardfork}: ${c.createVerdicts[hardfork]}`).toBe(
			`${hardfork}: accepted`,
		);
	}
	// ...and the node's own intrinsic gas for that CREATE is what `@ethereumjs/tx`
	// charges the same transaction, at every admitted fork — i.e. what this node's
	// `runTx` path spends when the deployment is actually mined. A read path that
	// disagreed with it would over- or under-estimate the node's OWN transactions.
	expect(c.createIntrinsicMatchesProtocol).toBe(true);
	expect(c.createIntrinsic.paris).toEqual({
		node: '53292',
		protocol: '53292',
	});
	expect(c.createIntrinsic.cancun).toEqual({
		node: '53296',
		protocol: '53296',
	});

	// ---- THE TRANSACTION HALF: one transfer, on revm, COMMITTED ----
	// The same signed transfer, sent to a revm-backed node and to a default-engine
	// node built on identical state. Every receipt field the seam's
	// `TransactionResult` feeds must be indistinguishable, and so must the
	// post-state a consumer can read back.
	expect(c.transferReceiptFields).toBeDefined();
	for (const [field, both] of Object.entries(
		c.transferReceiptFields as Record<string, {default: string; revm: string}>,
	)) {
		expect(`${field}=${both.revm}`).toBe(`${field}=${both.default}`);
	}
	expect(c.transferReceipts.revm.status).toBe('0x1');
	expect(BigInt(c.transferReceipts.revm.gasUsed)).toBe(21_000n);
	expect(c.transferReceipts.revm.contractAddress ?? null).toBe(null);
	expect(c.transferLogCounts).toEqual({default: 0, revm: 0});
	// ...and the MONEY moved, on the node's own state: an engine that reported a
	// perfect receipt and committed nothing would leave every balance untouched.
	for (const [what, both] of Object.entries(
		c.transferPostState as Record<string, {default: string; revm: string}>,
	)) {
		expect(`${what}=${BigInt(both.revm)}`).toBe(
			`${what}=${BigInt(both.default)}`,
		);
	}
	expect(BigInt(c.transferPostState.sinkBalance.revm)).toBe(12_345n);
	expect(BigInt(c.transferPostState.senderNonce.revm)).toBe(1n);
	expect(String(BigInt(c.transferPostState.senderBalance.revm))).toBe(
		c.transferSenderBalanceExpected,
	);
	// ...and the coinbase was credited the priority fee by revm, not by the node.
	expect(BigInt(c.transferPostState.coinbaseBalance.revm)).toBe(
		21_000n * 1_000_000_000n,
	);

	// IT RAN ON REVM, and on the committing path: exactly one `Revm#transact`, for
	// the sender the NODE established (never one the engine recovered for itself),
	// with NO simulation switch anywhere near it and nothing said about the nonce.
	// The switches relax a transaction's VALIDITY, so a transaction that runs with
	// them is not a transaction; `checkNonce` is left to the binding's committing
	// default because a value passed here is a value a later refactor can flip.
	expect(c.transactCalls).toBe(1);
	expect(c.transactFrom).toBe(c.transactFromExpected);
	expect(c.transactSwitchesPresent).toEqual([]);
	expect(c.transactCheckNonceOption).toBe('undefined');
	expect(c.transactCommitOption).toBe('undefined');
	expect(c.transactReturnStateOption).toBe('undefined');

	// NONCE CHECKING IS ON: the replay is REJECTED on both engines, and the
	// sender's nonce is untouched by the attempt.
	expect(c.replay_revm).not.toBe('DID_NOT_THROW');
	expect(c.replay_default).not.toBe('DID_NOT_THROW');
	expect(c.nonceAfterReplay).toEqual({default: '0x1', revm: '0x1'});

	// the node's own features still work over state a revm transaction wrote
	expect(BigInt(c.cheatBalance)).toBe(42n);
	expect(BigInt(c.cheatNonce)).toBe(7n);
	expect(c.dumpHasSink).toBe(true);
	expect(BigInt(c.reloadedSinkBalance)).toBe(12_345n);

	// one engine, one node: re-using a connected engine is refused rather than
	// silently re-pointing the first node's reads at the second node's state
	expect(c.reuseRefusal).not.toBe('DID_NOT_THROW');
	expect(c.reuseRefusal).toMatch(/createNode/i);
	expect(c.numberAfterReuseAttempt).toBe('1');

	await h.dispose();
});
