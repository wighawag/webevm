/**
 * impersonation.ts: IMPERSONATION, opt-in, over webevm's trusted-sender
 * primitive (ADR 0002, ADR 0017). `hardhat_impersonateAccount` /
 * `hardhat_stopImpersonatingAccount` and their `anvil_` names maintain a set of
 * impersonated addresses; `eth_sendTransaction` from one (./send.ts) is filled
 * as a dev account's is, given a FABRICATED signature, and sent through
 * `evm_sendRawTransactionAs(raw, from)`, which is why the node must be
 * `senderMode: 'trusted'`.
 *
 * THE FABRICATED SIGNATURE IS UNIQUE PER SENDER, as ADR 0002's caller contract
 * requires: `from` is not part of a transaction, so its hash comes from the
 * bytes alone, and two impersonated senders sending otherwise identical
 * transactions would collide under one dummy signature (anvil's bug, foundry
 * #4210). So `r` is `keccak256(address) mod n` (secp256k1's group order) and
 * `s` is fixed at 1, which is low (EIP-2), with y-parity 0. It is a signature
 * of NOTHING: a `'recover'` node recovers some unrelated address from it, or
 * none, so a dump holding such transactions is not replayable chain history.
 *
 * NO SIGNATURE THAT IS NOT ONE. The fabricated signature only ever reaches the
 * node inside a transaction it is told the sender of; no signing method
 * returns one (./sign.ts and `eth_signTransaction` refuse an impersonated
 * address with {@link impersonatedNoKeyMessage}).
 *
 * DECISIONS made here (task `devnode-impersonation`), each user-visible and
 * reversible before 1.0:
 *
 * - THE METHODS RETURN `null` UNDER BOTH NAME SETS, as anvil answers them
 *   (Hardhat answers `true`). This follows the core's rule for the `hardhat_`
 *   state-cheat aliases (`hardhat-and-anvil-names-for-the-state-cheats`: "what
 *   anvil returns under both names"); viem's `impersonateAccount` and rocketh
 *   ignore the result. Alternative: `true` for `hardhat_`, `null` for `anvil_`.
 * - STOPPING AN ADDRESS THAT IS NOT IMPERSONATED IS NO ERROR, as on anvil and
 *   Hardhat. A malformed address is `-32602`.
 * - WHILE THE OPTION IS OFF, the four methods are answered HERE with `-32601`
 *   naming the option, rather than forwarded to the core's generic `-32601`:
 *   rocketh swallows this error, so its text is the only place a user learns
 *   what to switch on.
 * - THE METHODS RUN ON THE SEND QUEUE (./send.ts), so a send issued before a
 *   `stopImpersonatingAccount` is decided by the set as it was when the send
 *   was issued, not when it reached the front of the queue.
 * - THE SET IS LAYER STATE, not chain state: it is not in `dumpState`, and
 *   `loadState` (which reaches the node, not this layer) leaves it as it is.
 */
import {keccak_256} from '@noble/hashes/sha3.js';
import {RpcError} from 'webevm';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** secp256k1's group order: a signature's `r` and `s` lie in [1, n). */
const SECP256K1_N =
	0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The fabricated signature's scalars for `address` (lowercase 0x hex). */
export function fabricatedSignature(address: string): {r: bigint; s: bigint} {
	const bytes = new Uint8Array(20);
	for (let i = 0; i < 20; i++)
		bytes[i] = parseInt(address.slice(2 + 2 * i, 4 + 2 * i), 16);
	let hash = 0n;
	for (const b of keccak_256(bytes)) hash = (hash << 8n) | BigInt(b);
	// `r = 0` is no signature at all; keccak lands on a multiple of n with
	// negligible probability, and 1 keeps the scalar valid if it ever does.
	return {r: hash % SECP256K1_N || 1n, s: 1n};
}

/** The message of a `4100` refusal to SIGN for an impersonated address. */
export function impersonatedNoKeyMessage(
	method: string,
	address: string,
): string {
	return (
		`${method}: ${address} is impersonated, and @webevm/devnode holds no key for it: ` +
		`an impersonated address can send (eth_sendTransaction), but nothing is ever signed for it, ` +
		`since any signature would be fabricated. Configure its private key in the dev node's \`accounts\` option to sign with it.`
	);
}

/** The impersonation methods, under both name sets. */
export const IMPERSONATION_METHODS = new Set([
	'hardhat_impersonateAccount',
	'anvil_impersonateAccount',
	'hardhat_stopImpersonatingAccount',
	'anvil_stopImpersonatingAccount',
]);

/** The impersonation methods' state and their answers. */
export interface Impersonation {
	/** Whether the option is on. */
	readonly enabled: boolean;
	/** The impersonated addresses (lowercase), empty while off. */
	readonly addresses: ReadonlySet<string>;
	/** Answer one of {@link IMPERSONATION_METHODS}. */
	request(method: string, params: unknown): null;
}

export function createImpersonation(enabled: boolean): Impersonation {
	const addresses = new Set<string>();
	return {
		enabled,
		addresses,
		request(method, params) {
			if (!enabled)
				throw new RpcError(
					-32601,
					`${method}: impersonation is off on this dev node. Turn on the \`impersonation\` option: ` +
						`createDevNode({impersonation: true}), or wrapDevNode(node, {impersonation: true}) on a node created with senderMode: 'trusted'.`,
				);
			const address = Array.isArray(params) ? params[0] : undefined;
			if (typeof address !== 'string' || !ADDRESS.test(address))
				throw new RpcError(
					-32602,
					`${method}: expected [address], a 20-byte hex address (received ${JSON.stringify(address ?? null)}).`,
				);
			const lower = address.toLowerCase();
			if (method.endsWith('_impersonateAccount')) addresses.add(lower);
			else addresses.delete(lower);
			return null;
		},
	};
}
