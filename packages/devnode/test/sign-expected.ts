/**
 * sign-expected.ts: what ./helpers/sign-checks.ts must observe, in Node and in
 * a browser page. The EIP-712 values are EIP-712's own, published in the EIPs
 * repository's `assets/eip-712/Example.js` for its `Mail` example (read
 * 2026-11-21); everything else is checked against viem.
 */
import {expect} from '@playwright/test';

export const EIP712_MAIL = {
	encodeType:
		'Mail(Person from,Person to,string contents)Person(string name,address wallet)',
	typeHash:
		'0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2',
	domainSeparator:
		'0xf2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f',
	digest: '0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2',
	signer: '0xcd2a3d9f938e13cd947ec05abc7fe734df8dd826',
	// v 28, r, s as the EIP publishes them.
	signature:
		'0x4355c47d63924e8a72e509b65029052eb6c299d53a04e167c5775fd466751c9d' +
		'07299936d304c153f6443dfa05f40ff007d72911b6f72307f996231605b91562' +
		'1c',
};

function expectTypedCase(name: string, c: any) {
	expect(c.digest, `${name} digest = viem's hashTypedData`).toBe(c.viemDigest);
	expect(c.signature, `${name} signature = viem's signTypedData`).toBe(
		c.viemSignature,
	);
	expect(c.recovered, `${name} recovers to its signer`).toBe(c.address);
}

export function assertSign(c: Record<string, any>) {
	// 1. The encoder, against the EIP's published values.
	expect(c.mail).toEqual({
		encodeType: EIP712_MAIL.encodeType,
		typeHash: EIP712_MAIL.typeHash,
		domainSeparator: EIP712_MAIL.domainSeparator,
		digest: EIP712_MAIL.digest,
	});

	// 2. eth_signTypedData_v4 against viem, and the EIP's own signature.
	for (const name of [
		'mailSigned',
		'mailViaViem',
		'permit',
		'nested',
		'nestedViaViem',
		'domainOnly',
	])
		expectTypedCase(name, c[name]);
	expect(c.mailSigned.address).toBe(EIP712_MAIL.signer);
	expect(c.mailSigned.viemDigest).toBe(EIP712_MAIL.digest);
	expect(c.mailSigned.signature).toBe(EIP712_MAIL.signature);
	expect(c.mailViaViem.signature).toBe(EIP712_MAIL.signature);
	// The nested case is not the Mail one by accident.
	expect(c.nested.digest).not.toBe(c.permit.digest);

	// 3. personal_sign and eth_sign: viem's signMessage, in either order.
	const m = c.messages;
	expect(m.viemText).toBe(m.expectedText);
	expect(m.plainText).toBe(m.expectedText);
	expect(m.ethSignText).toBe(m.expectedText);
	expect(m.viemRaw).toBe(m.expectedRaw);
	expect(m.ethSign).toBe(m.expectedRaw);
	expect(c.recovered).toEqual({viemText: c.address, ethSign: c.address});

	// 4. Refusals: no key is 4100 naming the address and the remedy;
	// malformed is -32602 naming what is wrong.
	const r = c.refusals;
	for (const [name, method] of [
		['personalUnknown', 'personal_sign'],
		['ethSignUnknown', 'eth_sign'],
		['typedUnknown', 'eth_signTypedData_v4'],
	]) {
		expect(r[name].code, name).toBe(4100);
		expect(r[name].message, name).toContain(method);
		expect(r[name].message, name).toContain(
			'0x00000000000000000000000000000000000000ee',
		);
		expect(r[name].message, name).toContain('`accounts`');
	}
	expect(r.ethSignSwapped.code).toBe(-32602);
	expect(r.typedMissingMember.code).toBe(-32602);
	expect(r.typedMissingMember.message).toContain('message.to');
	expect(r.typedOutOfRange.code).toBe(-32602);
	expect(r.typedOutOfRange.message).toContain('message.legs[0].decimals');
	expect(r.typedOutOfRange.message).toContain('uint8');
	expect(r.typedUnknownType.code).toBe(-32602);
	expect(r.typedUnknownType.message).toContain('Nope');
	expect(r.typedBadJson.code).toBe(-32602);

	// 5. eth_signTransaction: signed, unsent, and it mines when submitted.
	for (const mode of ['recover', 'trusted']) {
		const t = c.signTransaction[mode];
		expect(t.rawIsHex, mode).toBe(true);
		expect(t.afterSign, `${mode}: signing sends nothing`).toEqual(t.before);
		expect(t.type, mode).toBe('eip1559');
		expect(t.chainId, mode).toBe(31337);
		expect(t.nonce, mode).toBe(0);
		expect(t.value, mode).toBe('123');
		expect(t.signer, mode).toBe(t.from);
		expect(t.receipt?.status, mode).toBe('0x1');
		expect(t.receipt?.from, mode).toBe(t.from);
		expect(t.receipt?.to, mode).toBe(
			'0x00000000000000000000000000000000000000cc',
		);
		expect(t.viemSigner, mode).toBe(t.from);
		expect(t.viemReceipt?.status, mode).toBe('0x1');
		expect(t.viemReceipt?.from, mode).toBe(t.from);
		expect(t.refusals.unknown.code, mode).toBe(4100);
		expect(t.refusals.unknown.message, mode).toContain('eth_signTransaction');
		expect(t.refusals.unknown.message, mode).not.toContain('impersonat');
		expect(t.refusals.conflict.code, mode).toBe(-32602);
		expect(t.refusals.conflict.message, mode).toContain('eth_signTransaction:');
	}
}
