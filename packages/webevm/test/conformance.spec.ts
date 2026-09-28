/**
 * conformance.spec.ts — DIFFERENTIAL conformance of the slim node's receipt/RPC
 * layer against a trusted reference EVM (a trie-backed @ethereumjs/vm `runTx` set
 * up by hand — the SAME engine WITH a Merkle state manager) running the SAME
 * signed txs, in real Chromium via playwright-browser-harness.
 *
 * WHY differential (not ethereum/tests fixtures): GeneralStateTests /
 * execution-spec-tests verify by comparing the post-state Merkle-Patricia TRIE
 * ROOT (+ keccak(RLP(logs))). The default slim node (no `computeStateRoot`) has NO
 * trie/root on purpose and throws on getStateRoot, so those fixtures can't
 * validate it without reintroducing a trie — and VMTests (the one trie-free
 * format) is frozen at Homestead. The legacy effectiveGasPrice bug this node
 * guards against is a RECEIPT/RPC-layer concern none of them cover. See the
 * package README "On comprehensive EVM test fixtures". The right tool is a
 * differential diff of OUR layer — implemented in test/helpers/conformance.ts.
 *
 * We run the whole battery WITHOUT and WITH `computeStateRoot` (result labels
 * 'none', the default fast path, and 'trie') and assert ZERO field-by-field mismatches against the reference.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('slim-node differential conformance vs trie-backed @ethereumjs/vm reference', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'conformance'}});

	console.log('\n[conformance] errors:', r.errors);
	const c = r.results.conformance as any;
	// Pretty-print the per-step report so a failure tells you exactly which field
	// diverged on which tx (and in which state mode).
	for (const mode of ['none', 'trie'] as const) {
		console.log(
			`\n[conformance:${mode}] ${c[mode].steps.length} steps, ${c[mode].totalMismatches} mismatches`,
		);
		for (const s of c[mode].steps) {
			const tag = s.mismatches.length === 0 ? 'OK ' : 'XX ';
			console.log(
				`  ${tag}${s.label}${s.mismatches.length ? ': ' + JSON.stringify(s.mismatches) : ''}`,
			);
		}
	}

	expect(r.errors).toEqual([]);

	// Field-by-field equality across the WHOLE battery, BOTH modes → zero diffs.
	expect(c.none.totalMismatches).toBe(0);
	expect(c.trie.totalMismatches).toBe(0);
	expect(r.results.conformanceTotalMismatches).toBe(0);

	// Sanity: the battery actually ran a meaningful number of steps (not silently
	// short-circuited). Each mode runs the full battery (deploy/calls/legacy/2930/
	// multi-log/discarded-log/revert/estimate/back-to-back + post-state reads).
	expect(c.none.steps.length).toBeGreaterThanOrEqual(20);
	expect(c.trie.steps.length).toBeGreaterThanOrEqual(20);

	// The BLOCK-ENVIRONMENT step ran, in both modes. Named explicitly because it
	// is the only step whose class of bug is invisible to every other bar in the
	// repo: BASEFEE / PREVRANDAO / COINBASE / NUMBER / TIMESTAMP are
	// gas-independent, so an engine reading them wrong charges identical gas and
	// produces identical receipts. If it silently stopped running, nothing else
	// would go red.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			'block environment through a contract',
		);
	}

	// The VALUE-BEARING-READ step ran too, in both modes, and for the same
	// reason: an engine that fabricates the caller's balance to serve an
	// `eth_call` answers a transfer that could never happen, and a validation
	// failure charges no gas on either engine, so no gas bar can see it.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			'value-bearing read affordability',
		);
	}

	// The DISCARDED-LOG step ran too, in both modes, and its central assertions
	// are absolute for a reason the other steps do not have: the reference EVM
	// executes the SAME contract, so a log that leaked out of a reverted frame
	// would leak on both sides and diff perfectly clean. What cannot diff clean is
	// the discarded event's topic appearing in the receipt at all, or the bloom
	// differing from the plain `emitTwo(3,4)` transaction that emits the same two
	// events without a reverting sub-call.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			"reverted sub-call's log is in neither the logs nor the bloom",
		);
	}

	// ...and the step that pins the LOG POSITIONS the node owns rather than the
	// engine: a `logIndex` running across a block of several log-emitting
	// transactions, and `eth_getLogs` reading exactly the receipts' logs back out.
	// Its oracle is the node's own receipts (the reference is a separate chain and
	// cannot mine that block), so counting steps would not notice it going away.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			'logIndex runs across the block; eth_getLogs agrees with the receipts',
		);
	}

	// The THREE NEGATIVE CASES ran too, in both modes. Their oracle IS the
	// trie-backed reference — the same `runTx` refuses the same two transactions,
	// and the refund's receipt and post-state are diffed against it field by field
	// — but each also carries an absolute statement the reference cannot make (no
	// block was mined; the sender ends at exactly zero; a refund really happened),
	// so they are named rather than counted.
	for (const mode of ['none', 'trie'] as const) {
		for (const label of [
			'a replayed nonce is refused, and nothing moved',
			'an unaffordable transaction is refused, and mines once the sender can pay',
			'a storage-clearing refund is priced at the effective gas price',
		]) {
			expect(c[mode].steps.map((s: any) => s.label)).toContain(label);
		}
	}

	// The BLOCK-GAS-LIMIT step ran too, in both modes, and it is the third step
	// whose oracle is NOT the reference: this file's reference `runTx` passes
	// `skipBlockGasLimitValidation` itself, so a node that went back to mining a
	// transaction too large for its block would diff CLEAN against it. Only the
	// node's own answer (refused here, mined on a node configured for it) can see
	// that, which is why the step must be named rather than counted.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).toContain(
			'block gas limit refuses an over-limit tx; blockGasLimit lifts it',
		);
	}

	// AND NOTHING WAS RECORDED AT THE SEAM, because there is nothing to record
	// here: this battery installs no engine, so the node builds its own default
	// `@ethereumjs/evm` and no recorder can sit in front of it (the battery says so
	// itself — `transactionsByEngine` in test/helpers/conformance.ts). Asserted so
	// the `null` reads as the deliberate absence it is rather than as a recorder
	// that quietly stopped counting; the engine-parameterised run
	// (revm-conformance.spec.ts) is where the recording is the point.
	expect(c.none.transactionsByEngine).toBeNull();
	expect(c.trie.transactionsByEngine).toBeNull();
	// ...and the step that reports it is likewise absent, for the same reason.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[mode].steps.map((s: any) => s.label)).not.toContain(
			'every transaction ran on the installed engine',
		);
	}
});
