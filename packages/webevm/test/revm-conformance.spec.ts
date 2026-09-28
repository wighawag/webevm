/**
 * revm-conformance.spec.ts — the DIFFERENTIAL conformance battery, run with the
 * `webevm/revm` engine installed.
 *
 * The battery itself is the one `conformance.spec.ts` runs (helpers/conformance.ts):
 * the same signed transactions through the node AND through a trie-backed
 * `@ethereumjs/vm` `runTx` reference, diffed field by field plus post-state. What
 * changes here is WHICH EVM answers, and it answers everything: `eth_call` return
 * data, `eth_estimateGas`, and every mined transaction — deploys, storage writes,
 * logs, a real EIP-2930 access list, a legacy fee, a revert, two transactions in
 * one block, a storage-clearing refund — executed and COMMITTED by revm against
 * the node's own state, plus the two it must REFUSE (a replayed nonce, a sender
 * who cannot pay), which the reference `runTx` refuses too. So this file is where
 * a revm-executed chain is asserted to be the SAME chain as an `@ethereumjs/vm`
 * one, receipt for receipt and account for account — and where the battery is
 * held to having actually executed those transactions on revm, rather than
 * reporting that it did.
 *
 * BOTH STATE MODES, on revm. `'trie'` used to be REFUSED by revm at
 * construction (trie mode ran on `MerkleStateManager`, which has no synchronous
 * view, ADR 0005) and kept only its default-engine coverage. Every node now runs
 * on the flat state and trie mode derives its trie from it between blocks (ADR
 * 0014), so the WHOLE battery runs on revm in both modes, held to the same
 * assertions, and the trie-mode run puts the roots revm's writes lead to under
 * the reference's post-state diff. `conformance.spec.ts` still runs both modes
 * on the default engine, unchanged.
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm
 * `.wasm` and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test('differential conformance with the revm engine installed (stateMode none and trie)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape: `import ... from
		// 'revm-wasm/revm.wasm'` built into the bundle as bytes (the harness's
		// built-in `.wasm` loader is `copy`, which the browser then refuses to
		// execute as a module).
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'conformance'}});

	console.log('\n[revm-conformance] errors:', r.errors);
	const c = r.results.revmConformance as any;
	expect(r.errors).toEqual([]);
	expect(Object.keys(c.byMode)).toEqual(['none', 'trie']);
	expect(c.totalMismatches).toBe(0);

	for (const mode of ['none', 'trie'] as const) {
		const served = c.byMode[mode];
		console.log(
			`\n[revm-conformance:${served.stateMode} on ${served.engineId}] ${served.steps.length} steps, ${served.totalMismatches} mismatches`,
		);
		for (const s of served.steps) {
			const tag = s.mismatches.length === 0 ? 'OK ' : 'XX ';
			console.log(
				`  ${tag}${s.label}${s.mismatches.length ? ': ' + JSON.stringify(s.mismatches) : ''}`,
			);
		}
		console.log(
			'[revm-conformance] transactions by engine:',
			JSON.stringify(served.transactionsByEngine),
		);

		// The battery really ran ON REVM (not silently on the default engine).
		expect(served.engineId).toBe('revm-wasm');
		expect(served.stateMode).toBe(mode);

		// ...AND ITS TRANSACTIONS REALLY EXECUTED THERE, COUNTED AT THE SEAM rather
		// than inferred from the line above.
		//
		// THE FAILURE MODE THIS EXISTS FOR IS A VACUOUS PASS. `engineId` is what the
		// node was BUILT with; it would still say `revm-wasm` if the mining path went
		// back to running `@ethereumjs/vm` itself, and then every receipt diff below
		// would pass while comparing that reference against itself — a whole battery
		// proving nothing, silently. So the battery counts the transactions each engine
		// was actually handed (`transactionsByEngine`, recorded by a wrapper in front
		// of the injected engine) and this is the assertion that reads it: revm
		// executed them, the default engine executed NONE, and there were a great many
		// of them rather than one.
		expect(served.transactionsByEngine).not.toBeNull();
		expect(Object.keys(served.transactionsByEngine)).toEqual(['revm-wasm']);
		expect(served.transactionsByEngine['@ethereumjs/evm']).toBeUndefined();
		expect(served.transactionsByEngine['revm-wasm']).toBeGreaterThanOrEqual(20);

		// Field-by-field equality against the trie-backed reference → zero diffs.
		expect(served.totalMismatches).toBe(0);

		// Sanity: the same full battery, not a short-circuited subset. Same bound as
		// `conformance.spec.ts` uses for each of its two modes.
		expect(served.steps.length).toBeGreaterThanOrEqual(20);

		// The steps that pin the halves the engine owns are in there, and passed.
		const labels = served.steps.map((s: any) => s.label);
		// The TRANSACTION half: a value transfer's receipt and its post-state, a
		// creation, a storage-writing call and a legacy fee, each diffed against the
		// reference. These are the steps that were being answered by `@ethereumjs/vm`
		// while this engine had no write half.
		expect(labels).toContain('1559-value-transfer');
		expect(labels).toContain('1559-value-transfer post-state');
		expect(labels).toContain('1559-deploy(Counter)');
		expect(labels).toContain('legacy-value-transfer');
		expect(labels).toContain('2930-call(increment, access-list)');
		// ...INCLUDING THE LOG THAT MUST NOT BE THERE: a log emitted inside a sub-call
		// that then reverted appears in neither the receipt's logs nor its bloom. Named
		// here because this is the engine's half of it — revm decides which logs
		// survive a discarded frame, and its outcome's bloom is the one the receipt
		// carries (and is OMITTED from the wire format when the log count is zero, so
		// the zero-log case exercises a decoding path the default engine does not have).
		expect(labels).toContain(
			"reverted sub-call's log is in neither the logs nor the bloom",
		);
		expect(labels).toContain(
			'a reverted transaction keeps neither its log nor its bloom bits',
		);
		expect(labels).toContain('1559-value-transfer zero-log bloom is all zero');
		// ...and the node's half, which must be unchanged by the engine underneath it:
		// `logIndex` running across a block of several log-emitting transactions, and
		// `eth_getLogs` returning exactly the receipts' logs for that block — the same
		// absolute statement the default engine is held to in `conformance.spec.ts`,
		// which is what makes the pair a cross-engine bar.
		expect(labels).toContain(
			'logIndex runs across the block; eth_getLogs agrees with the receipts',
		);
		// ...and the READ half.
		expect(labels).toContain('1559-call(increment) view number()');
		expect(labels).toContain(
			'gas consumed == the reference; estimateGas is a usable limit',
		);
		expect(labels).toContain(
			'CREATE incl. EIP-3860 initcode: consumed == the reference',
		);
		// ...including the BLOCK-ENVIRONMENT step, the one bar that can see an engine
		// lying about the block it runs in (BASEFEE / PREVRANDAO / COINBASE / NUMBER /
		// TIMESTAMP are gas-independent, so neither the gas gate nor the receipt diff
		// can). This is the step the zeroed base fee would have failed.
		expect(labels).toContain('block environment through a contract');
		// ...and the VALUE-BEARING-READ step, which pins the other half of `eth_call`
		// semantics: relaxing a transaction's validity rules must not relax the value
		// TRANSFER, so a read carrying more ether than the sender holds fails on revm
		// exactly as it does on `@ethereumjs/evm`.
		expect(labels).toContain('value-bearing read affordability');
		// ...and the BLOCK-GAS-LIMIT step, which is the one that exists BECAUSE this
		// engine and the default one used to disagree: revm rejects a transaction whose
		// gas limit exceeds the block's and cannot be talked out of it while committing,
		// where the default engine skipped the check and mined it. Both now refuse it in
		// the node's own words, and both mine it on a node whose `blockGasLimit` says
		// they may.
		expect(labels).toContain(
			'block gas limit refuses an over-limit tx; blockGasLimit lifts it',
		);
		// ...and the THREE NEGATIVE CASES, which are transaction-path statements this
		// engine could not be held to until it had a write half: a replayed nonce and
		// an unaffordable transaction refused by the node AND by the reference `runTx`
		// alike, and a storage-clearing REFUND whose net `gasUsed` and whose price are
		// diffed against that reference. The refund is the one that earns its place:
		// it is charged at the EFFECTIVE gas price, so a second implementation valuing
		// it at the base fee leaves the sender short while every receipt field still
		// reads correctly.
		expect(labels).toContain('a replayed nonce is refused, and nothing moved');
		expect(labels).toContain(
			'an unaffordable transaction is refused, and mines once the sender can pay',
		);
		expect(labels).toContain(
			'a storage-clearing refund is priced at the effective gas price',
		);
		// ...and the step that STATES who executed all of the above, named here for the
		// same reason every other absolute step is: counting steps would not notice it
		// going away, and it is the one that stands between this file and a vacuous
		// pass.
		expect(labels).toContain('every transaction ran on the installed engine');
	}

	await h.dispose();
});
