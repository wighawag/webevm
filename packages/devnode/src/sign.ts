/**
 * sign.ts: MESSAGE SIGNING by dev accounts: `personal_sign`, `eth_sign`
 * (EIP-191 personal messages) and `eth_signTypedData_v4` (EIP-712, hashed by
 * ./eip712.ts). `eth_signTransaction` is in ./send.ts, beside the send it fills
 * and signs exactly as.
 *
 * Signing is `@noble/curves`' secp256k1 (`@ethereumjs/util` v10 exports no
 * signing function; ADR 0017), on the digest itself (`prehash: false`),
 * deterministic (RFC 6979, no extra entropy) and low-`s`, so the same request
 * signs to the same bytes, as viem's local accounts sign. A signature is the
 * 65 bytes `r ‖ s ‖ v` with `v` 27 or 28, as geth, anvil, Hardhat, MetaMask and
 * viem return it.
 *
 * PARAMETER ORDERS, which are opposite:
 *
 * - `personal_sign [message, address]`, as MetaMask and geth take it (the
 *   order viem's `signMessage` sends);
 * - `eth_sign [address, message]`, as geth takes it, and it signs the SAME
 *   EIP-191 digest: `keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ message)`.
 * - `eth_signTypedData_v4 [address, typedData]`, `typedData` an object or its
 *   JSON text (viem sends the text).
 *
 * DECISIONS made here (task `devnode-signing-methods-and-eip-712`), each
 * user-visible and reversible before 1.0:
 *
 * - AN ADDRESS WITH NO KEY IS REFUSED WITH `4100`, the code
 *   `eth_sendTransaction` uses for the same thing (see ./send.ts), naming only
 *   the `accounts` remedy: impersonation never signs (ADR 0017). An
 *   IMPERSONATED address with no key is refused with the same `4100`, saying so
 *   (`impersonatedNoKeyMessage` in ./impersonation.ts): a dev account that is
 *   also impersonated still signs with its key.
 * - `personal_sign` TAKES A MESSAGE THAT IS NOT HEX AS UTF-8 TEXT, as MetaMask
 *   does (dapps pass a login message as plain text), and 0x hex as the bytes it
 *   spells. So a text message that happens to be valid 0x hex is signed as
 *   bytes, exactly as MetaMask signs it. `eth_sign` requires 0x hex, as geth
 *   does. Alternative: hex only for both (geth's and anvil's rule), which
 *   refuses the plain-text message a MetaMask-shaped dapp sends.
 * - `eth_sign` SIGNS ARBITRARY DATA WITH THE EIP-191 PREFIX, as geth and anvil
 *   do (MetaMask's `eth_sign` signs a raw 32-byte hash, without the prefix, and
 *   is disabled by default there because a raw hash can be a transaction).
 *   This layer never signs a raw hash.
 */
import {secp256k1} from '@noble/curves/secp256k1.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {RpcError} from 'webevm';
import type {DevAccount} from './accounts.js';
import {hashTypedData} from './eip712.js';
import {impersonatedNoKeyMessage, type Impersonation} from './impersonation.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

const encoder = new TextEncoder();

type SigningMethod =
	| 'personal_sign'
	| 'eth_sign'
	| 'eth_signTypedData_v4'
	| 'eth_signTransaction';

/** The message of a `4100` refusal: no key is held for `address`. */
export function noKeyMessage(method: SigningMethod, address: string): string {
	return (
		`${method}: ${address} is not a dev account, so @webevm/devnode holds no key to sign for it. ` +
		`Configure its private key in the dev node's \`accounts\` option.`
	);
}

function invalid(method: SigningMethod, message: string): never {
	throw new RpcError(-32602, `${method}: ${message}`);
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array((hex.length - 2) / 2);
	for (let i = 0; i < out.length; i++)
		out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
	return out;
}

function toHex(bytes: Uint8Array): string {
	let s = '0x';
	for (const b of bytes) s += b.toString(16).padStart(2, '0');
	return s;
}

/** EIP-191 version 0x45: the personal-message digest. */
function personalMessageHash(message: Uint8Array): Uint8Array {
	const prefix = encoder.encode(
		`\x19Ethereum Signed Message:\n${message.length}`,
	);
	const data = new Uint8Array(prefix.length + message.length);
	data.set(prefix);
	data.set(message, prefix.length);
	return keccak_256(data);
}

/** A 32-byte digest signed as `r ‖ s ‖ v`, `v` 27 or 28. */
function signDigest(digest: Uint8Array, privateKey: Uint8Array): string {
	// 'recovered' is `recovery ‖ r ‖ s`.
	const sig = secp256k1.sign(digest, privateKey, {
		prehash: false,
		lowS: true,
		format: 'recovered',
	});
	const out = new Uint8Array(65);
	out.set(sig.subarray(1, 65));
	out[64] = 27 + sig[0]!;
	return toHex(out);
}

/** The layer's message-signing methods, over the given accounts' keys. */
export interface MessageSigner {
	personalSign(params: unknown): Promise<string>;
	ethSign(params: unknown): Promise<string>;
	signTypedDataV4(params: unknown): Promise<string>;
}

export function createMessageSigner(
	accounts: readonly DevAccount[],
	impersonation: Impersonation,
): MessageSigner {
	const keys = new Map(accounts.map((a) => [a.address, a.privateKey]));

	function params(method: SigningMethod, raw: unknown): [unknown, unknown] {
		if (!Array.isArray(raw) || raw.length < 2)
			invalid(
				method,
				method === 'personal_sign'
					? 'expected [message, address].'
					: method === 'eth_sign'
						? 'expected [address, message].'
						: 'expected [address, typedData].',
			);
		return [raw[0], raw[1]];
	}

	function keyFor(method: SigningMethod, address: unknown): Uint8Array {
		if (typeof address !== 'string' || !ADDRESS.test(address))
			invalid(
				method,
				`the address must be the 20-byte hex address of the dev account to sign with (received ${JSON.stringify(address)}).`,
			);
		const from = address.toLowerCase();
		const key = keys.get(from);
		if (!key)
			throw new RpcError(
				4100,
				impersonation.addresses.has(from)
					? impersonatedNoKeyMessage(method, from)
					: noKeyMessage(method, from),
			);
		return key;
	}

	return {
		async personalSign(raw) {
			const [message, address] = params('personal_sign', raw);
			if (typeof message !== 'string')
				invalid(
					'personal_sign',
					'the message must be a string, 0x hex or text.',
				);
			const key = keyFor('personal_sign', address);
			const bytes = HEX_DATA.test(message)
				? hexToBytes(message)
				: encoder.encode(message);
			return signDigest(personalMessageHash(bytes), key);
		},
		async ethSign(raw) {
			const [address, message] = params('eth_sign', raw);
			if (typeof message !== 'string' || !HEX_DATA.test(message))
				invalid('eth_sign', 'the message must be even-length 0x hex.');
			const key = keyFor('eth_sign', address);
			return signDigest(personalMessageHash(hexToBytes(message)), key);
		},
		async signTypedDataV4(raw) {
			const [address, data] = params('eth_signTypedData_v4', raw);
			const key = keyFor('eth_signTypedData_v4', address);
			let typed: unknown = data;
			if (typeof data === 'string') {
				try {
					typed = JSON.parse(data);
				} catch {
					invalid(
						'eth_signTypedData_v4',
						'the typed data is a string that is not JSON.',
					);
				}
			}
			let digest: Uint8Array;
			try {
				digest = hashTypedData(typed);
			} catch (e) {
				return invalid('eth_signTypedData_v4', (e as Error).message);
			}
			return signDigest(digest, key);
		},
	};
}
