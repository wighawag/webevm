/**
 * impersonation-expected.ts: what ./helpers/impersonation-checks.ts must
 * observe, on every engine. Shared by impersonation.spec.ts and
 * revm-impersonation.spec.ts so the two engines are held to the same
 * assertions, to the wei, as webevm's trusted-sender suite holds its own.
 */
import {expect} from '@playwright/test';
import {getContractAddress, keccak256, pad} from 'viem';
import {ANVIL_ACCOUNTS} from './dev-node-expected.js';

const X = '0x00000000000000000000000000000000000000a1';
const Y = '0x00000000000000000000000000000000000000a2';
const Z = '0x00000000000000000000000000000000000000a3';
const RECIPIENT = '0x00000000000000000000000000000000000000cc';
const GENESIS = 10n ** 21n;
/** The node's base fee plus its priority fee (helpers/send-checks.ts, `FEES`). */
const EFFECTIVE_GAS_PRICE = 7_000_000_000n;
/** secp256k1's group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The fabricated signature's `r` for a sender: keccak of its 20 bytes, mod n. */
const fabricatedR = (address: string) =>
	BigInt(keccak256(address as `0x${string}`)) % N;

const big = (v: unknown) => BigInt(v as string);

export function assertImpersonation(c: Record<string, any>, engineId: string) {
	// The battery really ran on the engine named, not silently on the default.
	expect(c.engineId).toBe(engineId);
	expect(c.dev).toBe(ANVIL_ACCOUNTS[0]);

	// 1. Not impersonated yet: refused, naming both methods, nothing moved.
	const b = c.beforeImpersonating;
	expect(b.send.code).toBe(4100);
	expect(b.send.message).toContain(X);
	expect(b.send.message).toContain('hardhat_impersonateAccount');
	expect(b.send.message).toContain('anvil_impersonateAccount');
	expect(b.nonce).toBe('0x0');
	expect(big(b.balance)).toBe(GENESIS);

	// The methods answer what anvil answers under both names: null.
	for (const r of [c.impersonateX, c.impersonateY, c.impersonateDev])
		expect(r).toEqual({resolved: null});

	// 2. The transfer executed AS X, to the wei.
	const t = c.transfer;
	expect(t.receipt.from).toBe(X);
	expect(t.receipt.status).toBe('0x1');
	expect(big(t.receipt.gasUsed)).toBe(21_000n);
	expect(big(t.receipt.effectiveGasPrice)).toBe(EFFECTIVE_GAS_PRICE);
	expect(t.tx.from).toBe(X);
	expect(big(t.balance)).toBe(
		GENESIS - 12_345n - 21_000n * EFFECTIVE_GAS_PRICE,
	);
	expect(t.nonce).toBe('0x1');
	expect(big(t.recipientAfter) - big(t.recipientBefore)).toBe(12_345n);
	// Sent through the trusted-sender primitive, claiming X, with a FABRICATED
	// signature: a fixed low `s` and an `r` derived from the address.
	expect(t.sends).toHaveLength(1);
	const sent = t.sends[0];
	expect(sent.method).toBe('evm_sendRawTransactionAs');
	expect(sent.claimed).toBe(X);
	expect(sent.tx.type).toBe('eip1559');
	expect(big(sent.tx.r)).toBe(fabricatedR(X));
	expect(big(sent.tx.s)).toBe(1n);
	expect(sent.tx.yParity).toBe(0);
	expect(sent.tx.nonce).toBe(0);
	expect(sent.tx.gas).toBe('21000');
	expect(sent.tx.to).toBe(RECIPIENT);
	expect(sent.tx.value).toBe('12345');
	expect(t.hash).toBe(t.receipt.transactionHash);

	// The EVM saw X as the sender: the create's address is derived from X's
	// nonce, and the recorder stored X as its CALLER.
	const d = c.deploy.receipt;
	expect(d.from).toBe(X);
	expect(d.status).toBe('0x1');
	expect(d.contractAddress).toBe(
		getContractAddress({from: X, nonce: 1n}).toLowerCase(),
	);
	const call = c.call;
	expect(call.receipt.from).toBe(X);
	expect(call.receipt.status).toBe('0x1');
	expect(call.slot0).toBe(pad(X));
	expect(call.nonce).toBe('0x3');
	expect(big(call.balance)).toBe(
		big(t.balance) -
			big(d.gasUsed) * big(d.effectiveGasPrice) -
			big(call.receipt.gasUsed) * big(call.receipt.effectiveGasPrice),
	);
	expect(big(d.effectiveGasPrice)).toBe(EFFECTIVE_GAS_PRICE);

	// 3. Two senders, otherwise identical transactions: two hashes, two receipts.
	const two = c.twoSenders;
	expect(two.hashes[0]).not.toBe(two.hashes[1]);
	expect(two.receipts.map((r: any) => r.from)).toEqual([Y, Z]);
	expect(two.receipts.map((r: any) => r.transactionHash)).toEqual(two.hashes);
	expect(two.receipts.map((r: any) => r.status)).toEqual(['0x1', '0x1']);
	expect(two.sends.map((s: any) => s.claimed)).toEqual([Y, Z]);
	expect(big(two.sends[0].tx.r)).toBe(fabricatedR(Y));
	expect(big(two.sends[1].tx.r)).toBe(fabricatedR(Z));
	// Only the signature's `r` differs between the two transactions.
	const {r: _r0, ...rest0} = two.sends[0].tx;
	const {r: _r1, ...rest1} = two.sends[1].tx;
	expect(rest0).toEqual(rest1);
	expect(two.nonces).toEqual(['0x1', '0x1']);
	for (const balance of two.balances)
		expect(big(balance)).toBe(GENESIS - 1n - 21_000n * EFFECTIVE_GAS_PRICE);

	// 4. No signature that is not one: every signing method refuses Z.
	const s = c.signRefusals;
	for (const method of [
		'eth_signTransaction',
		'personal_sign',
		'eth_sign',
		'eth_signTypedData_v4',
	]) {
		expect(s[method].code, method).toBe(4100);
		expect(s[method].message, method).toContain(method);
		expect(s[method].message, method).toContain(Z);
		expect(s[method].message, method).toContain('no key');
	}
	expect(s.nonce).toBe('0x1');
	expect(s.sendsMade).toBe(0);

	// 5. A dev account that is also impersonated signs and sends with its key.
	const dev = c.devAlsoImpersonated;
	expect(dev.receipt.from).toBe(c.dev);
	expect(dev.receipt.status).toBe('0x1');
	expect(dev.sendRecoversTo).toBe(c.dev);
	expect(dev.signTxRecoversTo).toBe(c.dev);
	expect(dev.personalSign).toBe(dev.viemPersonalSign);

	// 6. Stopped (each through the other name set): refused again, nothing
	// moves; Z, still impersonated, still sends.
	expect(c.stopX).toEqual({resolved: null});
	expect(c.stopY).toEqual({resolved: null});
	const a = c.afterStop;
	expect(a.x.code).toBe(4100);
	expect(a.x.message).toContain(X);
	expect(a.x.message).toContain('hardhat_impersonateAccount');
	expect(a.y.code).toBe(4100);
	expect(a.y.message).toContain(Y);
	expect(a.sendsMade).toBe(0);
	expect(a.nonceXAfter).toBe(a.nonceXBefore);
	expect(a.z).toHaveProperty('resolved');
	expect(a.stopAgain).toEqual({resolved: null});

	// 7. Malformed parameters.
	for (const [name, r] of Object.entries(c.malformed) as [string, any][]) {
		expect(r.code, name).toBe(-32602);
		expect(r.message, name).toContain('address');
	}

	// OFF: a real -32601 naming the option, under both name sets; the unknown
	// `from` refusal names it too.
	for (const [method, r] of Object.entries(c.off) as [string, any][]) {
		if (method === 'unknownFrom') continue;
		expect(r.code, method).toBe(-32601);
		expect(r.message, method).toContain(method);
		expect(r.message, method).toContain('`impersonation`');
	}
	expect(c.off.unknownFrom.code).toBe(4100);
	expect(c.off.unknownFrom.message).toContain('`impersonation`');

	// createDevNode makes a 'trusted' node, and refuses an explicit 'recover'.
	expect(c.createdNode.senderMode).toBe('trusted');
	expect(c.createdNode.receipt.from).toBe(X);
	expect(c.createdNode.receipt.status).toBe('0x1');
	expect(c.createRecover.message).toContain('`impersonation`');
	expect(c.createRecover.message).toContain("'trusted'");
	expect(c.createRecover.message).toContain("'recover'");

	// wrapDevNode refuses a node that is not 'trusted', at once.
	expect(c.wrapRecover.message).toContain('`impersonation`');
	expect(c.wrapRecover.message).toContain("'trusted'");
	expect(c.wrapRecoverOff).toEqual({returned: true});
}
