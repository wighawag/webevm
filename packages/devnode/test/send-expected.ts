/**
 * send-expected.ts: what ./helpers/send-checks.ts must observe, on every engine
 * and in both sender modes. Shared by send.spec.ts and revm-send.spec.ts.
 */
import {expect} from '@playwright/test';
import {ANVIL_ACCOUNTS} from './dev-node-expected.js';

/** The node's fee market in the battery (helpers/send-checks.ts, `FEES`). */
const GAS_PRICE = 9_000_000_000n;
const BASE_FEE = 5_000_000_000n;
const PRIORITY_FEE = 2_000_000_000n;
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const STRANGER = '0x00000000000000000000000000000000000000ee';
const DELEGATE = '0x00000000000000000000000000000000000000dd';

const VIEM_TYPE: Record<number, string> = {
	0: 'legacy',
	1: 'eip2930',
	2: 'eip1559',
	4: 'eip7702',
};

const str = (v: unknown) => String(BigInt(v as string));

/**
 * Every field the request NAMED is in the sent transaction, unchanged (viem's
 * decoding names `gas`, `data`, `to`, `nonce`, ... as the request does).
 */
function expectNamedFieldsSent(name: string, r: any) {
	const {request, sent} = r;
	for (const [field, value] of Object.entries(request)) {
		if (field === 'from') {
			expect(sent.signer, `${name}.from`).toBe(value);
		} else if (field === 'type') {
			expect(sent.type, `${name}.type`).toBe(VIEM_TYPE[Number(value)]);
		} else if (field === 'to' || field === 'data') {
			expect(sent[field], `${name}.${field}`).toBe(value);
		} else if (field === 'accessList') {
			expect(sent.accessList, `${name}.accessList`).toEqual(value);
		} else if (field === 'authorizationList') {
			expect(
				sent.authorizationList.map((a: any) => ({
					chainId: `0x${a.chainId.toString(16)}`,
					address: a.address.toLowerCase(),
					nonce: `0x${a.nonce.toString(16)}`,
					yParity: `0x${a.yParity.toString(16)}`,
					r: a.r,
					s: a.s,
				})),
				`${name}.authorizationList`,
			).toEqual(value);
		} else {
			// A quantity: nonce, gas, value and the fees.
			expect(str(sent[field]), `${name}.${field}`).toBe(str(value));
		}
	}
}

/** Every field the request LEFT OUT is filled as specified. */
function expectFilled(name: string, r: any, type: 0 | 1 | 2 | 4) {
	const {request, sent} = r;
	expect(sent.type, `${name} type`).toBe(VIEM_TYPE[type]);
	expect(sent.chainId, `${name} chainId`).toBe(31337);
	if (request.nonce === undefined)
		expect(String(sent.nonce), `${name} nonce`).toBe(str(r.pendingNonce));
	if (request.gas === undefined)
		expect(sent.gas, `${name} gas`).toBe(str(r.estimate));
	if (type === 0 || type === 1) {
		if (request.gasPrice === undefined)
			expect(sent.gasPrice, `${name} gasPrice`).toBe(String(GAS_PRICE));
		expect(sent).not.toHaveProperty('maxFeePerGas');
	} else {
		if (request.maxPriorityFeePerGas === undefined)
			expect(sent.maxPriorityFeePerGas, `${name} priority fee`).toBe(
				String(PRIORITY_FEE),
			);
		if (request.maxFeePerGas === undefined)
			expect(sent.maxFeePerGas, `${name} max fee`).toBe(
				String(BASE_FEE + PRIORITY_FEE),
			);
		expect(sent).not.toHaveProperty('gasPrice');
	}
	if (request.accessList === undefined && type !== 0)
		expect(sent.accessList ?? [], `${name} accessList`).toEqual([]);
	if (request.value === undefined)
		expect(sent.value ?? '0', `${name} value`).toBe('0');
}

function assertMode(m: any, mode: 'recover' | 'trusted', engineId: string) {
	// The battery really ran on the engine named, not silently on the default.
	expect(m.engineId).toBe(engineId);
	const from = ANVIL_ACCOUNTS[0];
	expect(m.from).toBe(from);

	// 1. viem's sendTransaction on a createDevNode node: mined, from the account.
	expect(m.viemSend.receipt.from).toBe(from);
	expect(m.viemSend.receipt.status).toBe('0x1');
	expect(m.viemSend.blockNumber).toBe('0x1');
	expect(m.viemSend.recipientBalance).toBe('0x4d2');

	// 2. The path: by sender mode, with a REAL signature either way, so the
	// transaction replays on a 'recover' node under the same hash and sender.
	const p = m.path;
	expect(p.receipt.from).toBe(from);
	expect(p.receipt.status).toBe('0x1');
	expect(p.sends).toEqual([
		mode === 'trusted'
			? {method: 'evm_sendRawTransactionAs', from}
			: {method: 'eth_sendRawTransaction', from: null},
	]);
	expect(p.signer).toBe(from);
	expect(p.replayHash).toEqual({resolved: p.hash});
	expect(p.replayReceipt.from).toBe(from);
	expect(p.replayReceipt.status).toBe('0x1');

	// 3. Fields, per type.
	const f = m.fields;
	const mined = [
		['type0Full', 0],
		['type0Sparse', 0],
		['type0ByType', 0],
		['type1Full', 1],
		['type1Sparse', 1],
		['type2Full', 2],
		['type2Sparse', 2],
		['type2OnlyMaxFee', 2],
		['type2Create', 2],
		['type4Full', 4],
		['type4Sparse', 4],
	] as const;
	for (const [name, type] of mined) {
		const r = f[name];
		expect(r.result, name).toHaveProperty('resolved');
		expect(r.sendCount, name).toBe(1);
		expect(r.receipt.status, name).toBe('0x1');
		expect(r.receipt.from, name).toBe(from);
		expect(r.receipt.type, name).toBe(`0x${type}`);
		expectNamedFieldsSent(name, r);
		expectFilled(name, r, type);
	}
	// The full requests left nothing to fill: no estimate was taken for them.
	for (const name of ['type0Full', 'type1Full', 'type2Full', 'type4Full'])
		expect(f[name].estimate, name).toBeNull();
	// The access list and the authorization list are charged by the estimate.
	expect(BigInt(f.type1Sparse.estimate)).toBe(21_000n + 2_400n + 1_900n);
	expect(BigInt(f.type4Sparse.estimate)).toBeGreaterThanOrEqual(
		21_000n + 25_000n,
	);
	expect(f.type2Create.sent).not.toHaveProperty('to');
	expect(f.type2Create.receipt.contractAddress).toMatch(/^0x[0-9a-f]{40}$/);
	// The authorizations were applied: each authority now delegates.
	expect(m.delegatedCode).toEqual(
		m.authorities.map(() => `0xef0100${DELEGATE.slice(2)}`),
	);
	// A named nonce is sent as named, even a stale one, which the node refuses.
	expect(f.staleNonce.sent.nonce).toBe(0);
	expect(f.staleNonce.result.code).toBe(-32000);
	expect(f.staleNonce.result.message).toContain('nonce too low');
	// What cannot be sent as named is refused, never trimmed, and sends nothing.
	for (const [name, field] of [
		['gasPriceAnd1559', '`gasPrice`'],
		['accessListOnType0', '`accessList`'],
		['wrongChainId', '`chainId`'],
	]) {
		expect(f[name].result.code, name).toBe(-32602);
		expect(f[name].result.message, name).toContain(field);
		expect(f[name].sendCount, name).toBe(0);
	}

	// 4. Concurrency: both mine, consecutive nonces, in auto and manual mining.
	for (const which of ['auto', 'manual']) {
		const c = m.concurrency[which];
		const before = BigInt(c.before);
		expect(c.hashes[0], which).toHaveProperty('resolved');
		expect(c.hashes[1], which).toHaveProperty('resolved');
		expect(c.hashes[0].resolved).not.toBe(c.hashes[1].resolved);
		expect(c.txs.map((t: any) => BigInt(t.tx.nonce))).toEqual([
			before,
			before + 1n,
		]);
		for (const t of c.txs) {
			expect(t.receipt.status, which).toBe('0x1');
			expect(t.receipt.from, which).toBe(from);
		}
	}
	const manual = m.concurrency.manual;
	expect(manual.mined.txHashes).toEqual(
		manual.hashes.map((h: any) => h.resolved),
	);

	// 5. Refusal: an unknown `from` gets 4100 naming both remedies, and nothing
	// moves; a missing `from` or request is -32602.
	const ref = m.refusal;
	expect(ref.unknown.code).toBe(4100);
	expect(ref.unknown.message).toContain(STRANGER);
	expect(ref.unknown.message).toContain('`accounts`');
	expect(ref.unknown.message).toContain('impersonate');
	expect(ref.noFrom.code).toBe(-32602);
	expect(ref.noFrom.message).toContain('`from`');
	expect(ref.noParams.code).toBe(-32602);
	expect(ref.after).toEqual(ref.before);
	expect(ref.sendsMade).toBe(0);
	expect(ref.before.recipient).not.toBe('0x0');
	expect(f.type2Sparse.sent.to).toBe(RECIPIENT);
}

export function assertSend(c: Record<string, any>, engineId: string) {
	assertMode(c.recover, 'recover', engineId);
	assertMode(c.trusted, 'trusted', engineId);
	// Deterministic signing: the same request on the same state is the same
	// transaction in both modes.
	expect(c.trusted.path.hash).toBe(c.recover.path.hash);
	// Before Prague the node itself refuses the authorization list.
	expect(c.cancunType4.code).toBe(-32602);
	expect(c.cancunType4.message).toContain('predates');
}
