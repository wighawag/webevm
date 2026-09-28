/**
 * revm-trusted-sender.spec.ts — the trusted-sender suite, run with the
 * `webevm/revm` engine installed.
 *
 * The suite itself is the one `trusted-sender.spec.ts` runs
 * (helpers/trusted-sender.ts): the same signed transactions through a `'recover'`
 * node and a `'trusted'` node, receipts diffed field by field, the cheats refused
 * outside `senderMode:'trusted'`, and a transaction signed by one account and
 * submitted CLAIMING another. What changes here is WHICH EVM executes them.
 *
 * WHY THIS FILE EXISTS AT ALL, since the suite passes on the default engine: the
 * sender crosses the engine seam as a VALUE (`TransactionRequest.sender`), and an
 * engine that ignored it and recovered a sender from the signature would fail
 * NOTHING LOUDLY. It would charge the signer, advance the signer's nonce, commit,
 * and return a receipt that looks right. The only assertion that can see it is one
 * where the claimed and recoverable senders DIFFER, and it has to run on the engine
 * under test — which is why the suite is parameterised by engine rather than
 * asserted once on `@ethereumjs/evm` and assumed for the rest.
 *
 * WHICH STATE MODE: `'none'`, the default. (This engine used to refuse `'trie'`,
 * ADR 0005; it serves it since ADR 0014, covered by `revm-trie-derived.spec.ts`
 * and `revm-conformance.spec.ts`.)
 *
 * Its OWN cut (helpers/cut-revm.ts), because that bundle carries the revm `.wasm`
 * and the shared cut must keep costing the other specs nothing.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {TRUSTED_SENDER_POST_STATE} from './trusted-sender-post-state.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut-revm.ts');

test("senderMode:'trusted' on the revm engine: the CLAIMED sender is the sender", async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
		// The bundler-resolved wasm delivery shape, as in `revm-conformance.spec.ts`.
		esbuild: {loader: {'.wasm': 'binary'}},
	});
	const r = await h.run({phase: 'once', params: {mode: 'trusted-sender'}});

	console.log('\n[revm-trusted-sender] errors:', r.errors);
	const c = r.results.revmTrustedSender as Record<string, any>;
	console.log('[revm-trusted-sender]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);

	// The suite really ran ON REVM, in both sender modes (not silently on the
	// default engine, which is what `trusted-sender.spec.ts` already covers).
	expect(c.recoverNodeEngineId).toBe('revm-wasm');
	expect(c.trustedNodeEngineId).toBe('revm-wasm');
	expect(c.recoverNodeSenderMode).toBe('recover');
	expect(c.trustedNodeSenderMode).toBe('trusted');

	// 1) DIFFERENTIAL: the same battery as on the default engine — deploy, 1559
	// call, value transfer, legacy call, multi-log, revert — with `'recover'` and
	// `'trusted'` receipts equal field by field, identical post-state between the
	// two nodes, and every ordinary tx executing as the RECOVERED sender.
	expect(c.mismatches).toEqual([]);
	expect(c.totalMismatches).toBe(0);

	// 2) SAFETY: `'trusted'` is not widened by installing an engine. The cheats are
	// still absent in the default mode, and still fail loudly (ADR 0002 — the mode
	// stays opt-in at construction, whatever EVM is behind it).
	expect(c.gap_evm_sendRawTransactionAs).toBe('threw:-32601');
	expect(c.gap_evm_sendRawTransactionSyncAs).toBe('threw:-32601');

	// 3) THE ASSERTION THIS FILE EXISTS FOR: a transaction signed by one account
	// and submitted claiming another executes as the CLAIMED one on revm — the
	// claimed account is charged to the wei, its nonce advances, the SIGNER pays
	// nothing and its nonce does not move, and the call's state change happened.
	// An engine recovering its own sender inverts exactly this and throws nothing.
	expect(c.impersonation.mismatches).toEqual([]);
	expect(c.impersonation.chargedTheClaimedSender).toBe(true);
	expect(c.impersonation.receiptFrom).not.toBe(c.impersonation.actualSigner);
	expect(c.impersonation.signerBalanceDelta).toBe('0');
	expect(c.impersonation.signerNonceAfter).toBe(
		c.impersonation.signerNonceBefore,
	);

	// 4) BOTH ENGINES AGREE, absolutely: the SAME literals (
	// ./trusted-sender-post-state.ts) `trusted-sender.spec.ts` asserts for the default
	// engine. Balances encode the gas charged AND whose
	// balance it came out of; nonces encode who sent what; the storage encodes that
	// the transactions executed. A revm-backed trusted-sender chain is therefore the
	// same chain as an `@ethereumjs/vm` one.
	expect(c.postState).toEqual(TRUSTED_SENDER_POST_STATE);

	// the async (non-sync) variant still returns a real hash and mines
	expect(c.asyncVariant.hashIsReal).toBe(true);
	expect(c.asyncVariant.receiptFound).toBe(true);
	expect(c.asyncVariant.status).toBe('0x1');

	await h.dispose();
});
