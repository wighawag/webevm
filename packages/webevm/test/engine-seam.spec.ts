/**
 * engine-seam.spec.ts — the EVM engine seam, in real browsers:
 *   - the DEFAULT engine is `@ethereumjs/evm`, exposed as the node's `engine`
 *   - an injected engine serves ALL THREE read-path callers (eth_call,
 *     eth_estimateGas, eth_fillTransaction's estimation)
 *   - the engine reports EXECUTION gas; the node adds intrinsic gas
 *   - `call` and `transact` are two operations on ONE engine: there is no second
 *     EVM to mine on, so a stub whose `transact` touches no state leaves the
 *     recipient with nothing
 *   - a transaction too large for the block is refused BY THE NODE, before the
 *     engine, in words naming the numbers and `blockGasLimit`
 *   - the default engine keeps the EIP-2929 reset + pure-read checkpoint/revert
 *   - an engine that DOES transact owns the mining path, and the receipt is built
 *     from the neutral transaction result it returned
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('engine seam (default @ethereumjs/evm, injected engine, reads and transactions)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'engine-seam'}});

	console.log('\n[engine-seam] errors:', r.errors);
	const c = r.results.engineSeam as Record<string, any>;
	console.log('[engine-seam]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// the default engine, named as THE engine
	expect(c.defaultEngineId).toBe('@ethereumjs/evm');
	// the pure-read invariants the default engine owns
	expect(c.estimateIncrementStable).toBe(true);
	expect(c.callDidNotMutateState).toBe(true);
	expect(c.number).toBe('0');

	// an injected engine is what the read path actually runs on
	expect(c.stubEngineId).toBe('test-stub');
	expect(c.stubConnectCount).toBe(1);
	// The context carries exactly these: whether the node computes a state root
	// is NOT on it (it went with the old mode field, 2026-09-28), because no
	// engine needs it now that every node runs on the same flat state.
	expect(c.stubConnectedContextKeys).toBe('common,getBlockHash,stateManager');
	expect(c.stubConnectedStateManagerUsable).toBe(true);
	expect(c.stubCallResult).toBe(c.stubCallExpected);
	// engine EXECUTION gas + node intrinsic gas
	expect(c.stubEstimate).toBe(c.stubEstimateExpected);
	expect(c.stubFilledGas).toBe(c.stubEstimateExpected);
	// eth_call (1) + eth_estimateGas (2) + eth_fillTransaction (2) = five engine
	// calls. The two methods that answer with a gas LIMIT search for it: one run at
	// the upper bound, then one probe confirming that what the request consumed is
	// itself a workable limit — which it is here, so neither pays for a bisection.
	expect(c.stubCallsSeen).toBe(5);

	// reads and transactions are TWO OPERATIONS ON ONE ENGINE: mining the tx added
	// no `call`, went to this engine's own `transact`, and — because that `transact`
	// deliberately touches no state — moved no ether. There is no longer a fallback
	// to the node's own @ethereumjs/vm, which would have credited the recipient for
	// real and hidden the fact that the engine never ran.
	expect(c.stubCallsAfterTx).toBe(5);
	expect(c.stubTransactCount).toBe(1);
	expect(c.stubTxStatus).toBe('success');
	expect(c.stubTxGasUsed).toBe('21000');
	expect(c.stubTargetBalance).toBe('0');

	// a transaction too large for the block is refused BY THE NODE, before the
	// engine: this stub would have returned a receipt for it (the default engine
	// used to mine it, revm always rejected it), so the answer is the node's on
	// every engine, and only the node can name `blockGasLimit`, which is its own
	// option and no engine's concept.
	expect(c.overLimitOutcome).toBe('refused');
	expect(c.overLimitErrorCode).toBe(-32000);
	expect(c.overLimitError).toContain('40000000');
	expect(c.overLimitError).toContain('30000000');
	expect(c.overLimitError).toContain('blockGasLimit');
	// ...and the engine was never asked to execute it.
	expect(c.stubTransactCountAfterOverLimit).toBe(1);

	// a reverting engine result is still an honest execution-reverted error
	expect(c.revertingCall).toBe('threw:3:0xdeadbeef');

	// ---- the MINING PATH runs on the engine ----
	// The engine was asked to execute the transaction the node parsed, once, with
	// the block it is mined in and the node's own sender.
	expect(c.engineTxSeen).toBe(1);
	expect(c.engineTxHashSeen).toBe(c.engineTxHashExpected);
	expect(c.engineTxSenderSeen).toBe(c.engineTxSenderExpected);
	expect(c.engineTxToSeen).toBe('0x0000000000000000000000000000000000001234');
	expect(c.engineTxBlockNumberSeen).toBe('1');
	expect(c.engineTxGasLimitSeen).toBe('21000');
	// ...and the receipt is assembled from what the ENGINE reported. None of these
	// numbers is one @ethereumjs/vm would produce for a 21000-gas transfer, so a
	// node that still ran `runTx` itself would fail here rather than pass quietly.
	expect(c.engineRcptStatus).toBe('success');
	expect(c.engineRcptGasUsed).toBe(c.engineRcptGasUsedExpected);
	expect(c.engineRcptEffectiveGasPrice).toBe(
		c.engineRcptEffectiveGasPriceExpected,
	);
	expect(c.engineRcptLogsBloom).toBe(c.engineRcptLogsBloomExpected);
	expect(c.engineRcptLogCount).toBe(1);
	expect(c.engineRcptLogAddress).toBe(c.engineRcptLogAddressExpected);
	expect(c.engineRcptLogTopics).toEqual(c.engineRcptLogTopicsExpected);
	expect(c.engineRcptLogData).toBe(c.engineRcptLogDataExpected);
	expect(c.engineRcptLogCount).toBe(c.engineBlockLogCount);
	// ...while the node keeps its own half: `cumulativeGasUsed` is the node's
	// accumulation over the block (one tx here, so the engine's gas used), the
	// created address is absent for a plain transfer, and this engine moved no
	// ether, so the node's state says the recipient got none.
	expect(c.engineRcptCumulativeGasUsed).toBe(c.engineRcptGasUsedExpected);
	expect(c.engineRcptContractAddress).toBe(null);
	expect(c.engineTxTargetBalance).toBe('0');
	// For an ordinary tx the seam's sender IS the recoverable one, so an engine
	// that re-recovered would agree here — which is exactly why that agreement
	// proves nothing on its own, and why the next block exists.
	expect(c.engineTxReRecoveredSender).toBe(c.engineTxSenderExpected);

	// ---- the SENDER is a VALUE the seam carries, not a behaviour an engine
	// reproduces ----
	// A tx signed by one account and submitted through `evm_sendRawTransactionSyncAs`
	// claiming ANOTHER (`senderMode:'trusted'`, the reason that mode exists). The
	// engine must be handed the CLAIMED sender; the address it would have recovered
	// for itself is the SIGNER, and the two must differ — otherwise this test cannot
	// see the failure it exists for. A re-recovering engine charges the signer,
	// advances the signer's nonce and returns a receipt that looks right.
	expect(c.asSenderSeen).toBe(c.asSenderExpected);
	expect(c.asReRecoveredSender).toBe(c.asReRecoveredExpected);
	expect(c.asSenderSeen).not.toBe(c.asReRecoveredSender);
	// ...and the node's own receipt names the claimed sender too.
	expect(c.asReceiptFrom).toBe(c.asSenderExpected);

	await h.dispose();
});
