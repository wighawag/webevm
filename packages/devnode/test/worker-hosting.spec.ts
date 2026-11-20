/**
 * worker-hosting.spec.ts: `@webevm/devnode` over a worker and inside one, the
 * two shapes ADR 0017 names, in a real browser (Chromium and WebKit). The
 * battery is ./helpers/worker-hosting-checks.ts, on the main thread; the worker
 * module it drives is ./helpers/dev-worker.ts, one module whose behaviour is
 * chosen by its URL's `?host=` query, because a harness mount serves ONE worker.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';
import {ANVIL_ACCOUNTS} from './dev-node-expected.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const devWorker = resolve(here, './helpers/dev-worker.ts');

const TEN_THOUSAND_ETH = String(10_000n * 10n ** 18n);
const STRANGER = '0x00000000000000000000000000000000000000aa';

test('the dev node over a worker proxy, and inside a worker (keys never cross)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		worker: devWorker,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const workerUrl = new URL('worker.js', h.serverUrl).href;
	const r = await h.run({
		phase: 'once',
		params: {mode: 'worker-hosting', workerUrl},
	});

	console.log('\n[worker-hosting] errors:', r.errors);
	const c = r.results.workerHosting as Record<string, any>;
	console.log(
		'[worker-hosting]',
		JSON.stringify(c ?? null, null, 2).slice(0, 6000),
	);
	expect(r.errors).toEqual([]);

	// A. KEYS ON THE MAIN THREAD: wrapDevNode over createWorkerNode()'s proxy,
	// funded with devAccountBalances() at the worker node's genesis.
	const m = c.mainThread;
	expect(m.engineId).toBe('@ethereumjs/evm');
	expect(m.accounts).toEqual(ANVIL_ACCOUNTS);
	expect(m.genesisBalance).toBe(TEN_THOUSAND_ETH);
	expect(m.send.status).toBe('0x1');
	expect(m.send.from).toBe(ANVIL_ACCOUNTS[0]);
	expect(m.send.recipientBalance).toBe('42');
	expect(m.signature).toBe(m.expectedSignature);
	// The main-thread layer serves its port from the main thread.
	expect(m.servedAccounts).toEqual(ANVIL_ACCOUNTS);

	// B. KEYS IN THE WORKER: exposeDevNode, the main thread unchanged.
	const w = c.inWorker;
	expect(w.expectedAccounts).toHaveLength(3);
	expect(w.accounts).toEqual(w.expectedAccounts);
	expect(w.genesisBalance).toBe(TEN_THOUSAND_ETH);
	expect(w.send.status).toBe('0x1');
	expect(w.send.from).toBe(w.expectedAccounts[0]);
	expect(w.send.recipientBalance).toBe('42');
	expect(w.signature).toBe(w.expectedSignature);
	// The in-worker layer's port is served by the worker, and answers as it.
	expect(w.servedAccounts).toEqual(w.expectedAccounts);
	// The main thread's own initialBalances still reach the worker's genesis.
	expect(w.strangerGenesis).toBe(String(10n ** 18n));

	// Every SlimNode member crossed: the plain values...
	expect(w.values).toEqual({
		engineId: '@ethereumjs/evm',
		senderMode: 'trusted',
		computeStateRoot: false,
	});
	// ...the methods (mine produced a head the subscription saw; loadState
	// restored the dump; getStateRoot's refusal is the core's -32004)...
	expect(w.heads).toBeGreaterThanOrEqual(1);
	expect(w.blockAfterLoad).toBe(w.blockBeforeLoad);
	expect(w.stateRoot.code).toBe(-32004);
	expect(w.stateRoot.isRpcError).toBe(true);
	// ...the shape, field for field against a main-thread dev node.
	expect(w.shapeGaps).toEqual([]);

	// The layer's own methods, answered in the worker.
	expect(w.impersonate).toEqual(null);
	expect(w.impersonated).toEqual({status: '0x1', from: STRANGER});
	expect(w.signedTransaction).toBe('string');
	expect(w.typedSignature).toBe('string');

	// An RpcError the LAYER raises arrives whole: a real RpcError, code and message.
	expect(w.errors.unknownSender).toMatchObject({
		code: 4100,
		name: 'RpcError',
		isRpcError: true,
	});
	expect(w.errors.unknownSender.message).toContain(
		'0x00000000000000000000000000000000000000cc',
	);
	expect(w.errors.signImpersonated).toMatchObject({
		code: 4100,
		isRpcError: true,
	});
	expect(w.errors.wrongChainId).toMatchObject({
		code: -32602,
		isRpcError: true,
	});

	// NO KEY AND NO MNEMONIC in anything the main thread received.
	expect(w.receivedBytes).toBeGreaterThan(1000);
	expect(w.leaks).toEqual([]);

	// C. A BAD CONFIG REJECTS the main thread (never NEVER_SETTLED, the hang)...
	expect(c.bad.mnemonic.outcome).toBe('REJECTED');
	expect(c.bad.mnemonic.message).toBe(
		'@webevm/devnode: `accounts.mnemonic` is not a valid BIP-39 English mnemonic.',
	);
	expect(c.bad.key.outcome).toBe('REJECTED');
	expect(c.bad.key.message).toContain('`accounts[0]`');
	expect(c.bad.engine.outcome).toBe('REJECTED');
	expect(c.bad.engine.message).toContain('`createEngine` must be a FUNCTION');
	// ...and is logged in the worker at once, without a throw.
	expect(c.early.mnemonic.threw).toBe('DID_NOT_THROW');
	expect(c.early.mnemonic.reported).toContain('`accounts.mnemonic`');
	expect(c.early.key.threw).toBe('DID_NOT_THROW');
	expect(c.early.key.reported).toContain('`accounts[0]`');
	expect(c.early.balance.threw).toBe('DID_NOT_THROW');
	expect(c.early.balance.reported).toContain('`balance`');
	expect(c.early.good).toEqual({reported: '', threw: 'DID_NOT_THROW'});

	await h.dispose();
});
