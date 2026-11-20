/**
 * send.ts: `eth_sendTransaction` from a DEV ACCOUNT. Fill exactly what the
 * request leaves out, sign with the account's key, submit, return the hash.
 *
 * THE FILLING matches the node's own `eth_fillTransaction`
 * (`packages/webevm/src/node.ts`), through the node's PUBLIC methods only:
 *
 * - `nonce`: the PENDING nonce (`eth_getTransactionCount` at `pending`), so a
 *   send queued behind an unmined one (manual or interval mining) does not reuse
 *   its nonce;
 * - `gas`: `eth_estimateGas` on the same request (its access list and
 *   authorization list included, which the node charges and applies);
 * - fees: legacy `gasPrice` from `eth_gasPrice`; the EIP-1559 pair from the
 *   node's own `eth_fillTransaction`, because the base fee it adds to the
 *   priority fee is a node option no other public method reports as such (a
 *   block's `baseFeePerGas` can differ under a `blockEnv`). So the two cannot
 *   drift apart.
 *
 * UNLIKE `eth_fillTransaction`, NOTHING THE REQUEST NAMES IS DROPPED. The
 * envelope follows the fields: type 4 for an `authorizationList`, type 0 for a
 * `gasPrice` (type 1 with an `accessList` too), type 2 otherwise (carrying any
 * `accessList`). An explicit `type` is honoured.
 *
 * THE SEND PATH follows the node's sender mode (ADR 0017): on `'trusted'`,
 * `evm_sendRawTransactionAs(raw, from)` with the REAL signature, so no ecrecover
 * runs and the chain's transactions still replay on any node (ADR 0002's
 * portability caveat is about fabricated signatures only); on `'recover'`,
 * `eth_sendRawTransaction(raw)`.
 *
 * ONE OPERATION, ONE QUEUE. Fill, sign and submit run as a single job on a
 * queue per layer: two concurrent sends from one account would otherwise both
 * read the same pending nonce before either is submitted. The node serialises
 * its own requests (ADR 0012), not a sequence of them, so the layer orders its
 * own sequences.
 *
 * DECISIONS made here (task `devnode-eth-send-transaction-from-dev-accounts`),
 * each user-visible and reversible before 1.0:
 *
 * - AN UNKNOWN `from` IS REFUSED WITH `4100`, EIP-1193's "Unauthorized" ("the
 *   requested method and/or account has not been authorized"), the code wallets
 *   use for an account they hold no key for, and viem maps it to
 *   `UnauthorizedProviderError`. A missing or malformed `from` is `-32602`.
 *   Alternatives: `-32000` (a generic server error), or `-32602` for both, which
 *   would read as a malformed request when the request is well formed. The
 *   impersonation task extends the message, not the code: it names
 *   `hardhat_impersonateAccount` (or `anvil_impersonateAccount`) while the
 *   `impersonation` option is on, and the option itself while it is off.
 * - A REQUEST THAT CANNOT BE SENT AS NAMED IS REFUSED WITH `-32602`, never
 *   trimmed into one that can: fields its type cannot carry (a `gasPrice` with
 *   EIP-1559 fees or with an `authorizationList`, an `accessList` on type 0, an
 *   `authorizationList` on anything but type 4), blob fields or type 3 (which
 *   this layer does not build), a `type` other than 0, 1, 2 or 4, `data` and
 *   `input` both present and different (as geth refuses them), and a `chainId`
 *   that is not the node's. `eth_fillTransaction` drops some of these instead;
 *   that is its documented difference, and the reason this does not reuse it.
 * - SIGNING IS DETERMINISTIC (RFC 6979, no extra entropy), so the same request
 *   on the same state signs to the same bytes and the same hash.
 * - THE SIGNING `Common` is the node's chain ID on Prague, the fork with every
 *   type this layer builds. The NODE's fork decides what is accepted: a type 4
 *   on Cancun is refused by the node in its own words, not by the signer.
 *
 * `eth_signTransaction` (task `devnode-signing-methods-and-eip-712`) is the
 * same fill, the same types and the same refusals (each `-32602` and `4100`
 * names `eth_signTransaction`), stopping before the submit. Its DECISIONS, each
 * user-visible and reversible before 1.0:
 *
 * - IT RETURNS THE RAW SIGNED TRANSACTION AS A HEX STRING, as anvil does and as
 *   viem's `signTransaction` over a JSON-RPC account reads it. Alternative:
 *   geth's `{raw, tx}` object, which viem would hand back as an object.
 * - IT RUNS ON THE SAME QUEUE AS THE SENDS, so its pending nonce counts every
 *   send queued before it. Two signs with no send between them read the same
 *   nonce: nothing was submitted, as on anvil.
 * - Its `4100` names only the `accounts` remedy: impersonation never signs
 *   (ADR 0017).
 *
 * AN IMPERSONATED `from` (task `devnode-impersonation`, see
 * ./impersonation.ts) is filled exactly as a dev account's is and given the
 * FABRICATED signature of `fabricatedSignature` instead of a real one, then
 * sent through `evm_sendRawTransactionAs` (the option requires a `'trusted'`
 * node). A dev account that is also impersonated sends with its key: the key
 * is looked up first. `eth_signTransaction` refuses an impersonated `from`
 * with `4100`, since what it returns would be a signature that is not one.
 */
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createTx, type TypedTxData} from '@ethereumjs/tx';
import {bytesToHex} from '@ethereumjs/util';
import {RpcError, type SlimNode} from 'webevm';
import type {DevAccount} from './accounts.js';
import type {Impersonation} from './impersonation.js';
import {
	fabricatedSignature,
	impersonatedNoKeyMessage,
} from './impersonation.js';
import {noKeyMessage} from './sign.js';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

/** The fields that make a request an EIP-1559 one. */
const FEE_1559 = ['maxFeePerGas', 'maxPriorityFeePerGas'] as const;
/** EIP-4844's fields, which this layer does not build a transaction from. */
const BLOB_FIELDS = [
	'blobVersionedHashes',
	'maxFeePerBlobGas',
	'blobs',
	'sidecars',
] as const;

type Request = Record<string, unknown>;

/**
 * A malformed request, thrown by the helpers below and turned into a `-32602`
 * naming the method that was called (`eth_sendTransaction` or
 * `eth_signTransaction`) where the request is built.
 */
class InvalidRequest extends Error {}

function invalid(message: string): never {
	throw new InvalidRequest(message);
}

/** A request's quantity as a bigint, or `undefined` when it is absent. */
function quantity(p: Request, field: string): bigint | undefined {
	const value = p[field];
	if (value == null) return undefined;
	if (typeof value === 'string' && HEX_QUANTITY.test(value))
		return BigInt(value);
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
		return BigInt(value);
	if (typeof value === 'bigint' && value >= 0n) return value;
	return invalid(
		`\`${field}\` must be a hex quantity (received ${JSON.stringify(String(value))}).`,
	);
}

function present(p: Request, field: string): boolean {
	return p[field] != null;
}

/** The envelope type the request names or implies, refusing a conflict. */
function envelopeType(p: Request): 0 | 1 | 2 | 4 {
	for (const field of BLOB_FIELDS) {
		if (present(p, field))
			invalid(
				`\`${field}\` is an EIP-4844 (type 3) field, and a dev account does not send type 3 transactions. Sign it yourself and use eth_sendRawTransaction.`,
			);
	}
	const has1559 = FEE_1559.some((f) => present(p, f));
	const explicit = quantity(p, 'type');
	let type: 0 | 1 | 2 | 4;
	if (explicit !== undefined) {
		if (
			explicit !== 0n &&
			explicit !== 1n &&
			explicit !== 2n &&
			explicit !== 4n
		)
			invalid(
				`type ${explicit} is not one a dev account sends: 0 (legacy), 1 (EIP-2930), 2 (EIP-1559) or 4 (EIP-7702).`,
			);
		type = Number(explicit) as 0 | 1 | 2 | 4;
	} else if (present(p, 'authorizationList')) type = 4;
	else if (present(p, 'gasPrice') && !has1559)
		type = present(p, 'accessList') ? 1 : 0;
	else type = 2;

	const conflict = (field: string) =>
		invalid(
			`\`${field}\` cannot be carried by a type ${type} transaction, and a dev account's transaction carries every field it is given rather than dropping one. Remove it, or ${type === 0 || type === 1 ? 'remove `gasPrice` and pass EIP-1559 fees' : 'pick a type that carries it'}.`,
		);
	if (type === 0 || type === 1) {
		for (const f of FEE_1559) if (present(p, f)) conflict(f);
		if (present(p, 'authorizationList')) conflict('authorizationList');
		if (type === 0 && present(p, 'accessList')) conflict('accessList');
	} else {
		if (present(p, 'gasPrice')) conflict('gasPrice');
		if (type === 2 && present(p, 'authorizationList'))
			conflict('authorizationList');
	}
	return type;
}

/** The request's call data, `data` or `input`, refusing two different ones. */
function callData(p: Request): string {
	const {data, input} = p;
	for (const [name, v] of [
		['data', data],
		['input', input],
	] as const) {
		if (v != null && (typeof v !== 'string' || !HEX_DATA.test(v)))
			invalid(`\`${name}\` must be even-length 0x hex.`);
	}
	if (
		typeof data === 'string' &&
		typeof input === 'string' &&
		data.toLowerCase() !== input.toLowerCase()
	)
		invalid(
			'both `data` and `input` are set and they differ. Pass one, or the same bytes in both.',
		);
	return ((input ?? data ?? '0x') as string).toLowerCase();
}

/** An authorization entry in the form `@ethereumjs/tx` reads, `v` accepted as yParity. */
function authorization(entry: unknown): Record<string, string> {
	if (entry === null || typeof entry !== 'object')
		invalid(
			'each `authorizationList` entry must be {chainId, address, nonce, yParity, r, s}.',
		);
	const e = entry as Record<string, unknown>;
	let yParity = e.yParity ?? e.v;
	if (typeof yParity === 'string' && HEX_QUANTITY.test(yParity)) {
		const parity = BigInt(yParity);
		if (parity >= 27n) yParity = `0x${(parity - 27n).toString(16)}`;
	}
	const out: Record<string, string> = {};
	for (const [field, value] of Object.entries({
		chainId: e.chainId,
		address: e.address,
		nonce: e.nonce,
		yParity,
		r: e.r,
		s: e.s,
	})) {
		if (typeof value !== 'string')
			invalid(
				`an \`authorizationList\` entry's \`${field}\` must be a hex string.`,
			);
		out[field] = value;
	}
	return out;
}

/** The two transaction methods of the layer, sharing one queue. */
export interface TransactionMethods {
	/** `eth_sendTransaction`: fill, sign, submit; resolves to the hash. */
	sendTransaction(params: unknown): Promise<string>;
	/** `eth_signTransaction`: fill and sign as `eth_sendTransaction` does; resolves to the raw signed transaction, unsent. */
	signTransaction(params: unknown): Promise<string>;
	/** Run `job` on the same queue, after every send and sign issued before it. */
	inOrder<T>(job: () => T): Promise<T>;
}

type TransactionMethod = 'eth_sendTransaction' | 'eth_signTransaction';

/**
 * The layer's `eth_sendTransaction` and `eth_signTransaction`: functions of the
 * request's params, which run every send and every sign on ONE queue, signing
 * with the given accounts' keys, or, for an address `impersonation` holds, a
 * fabricated signature.
 */
export function createTransactionMethods(
	node: SlimNode,
	accounts: readonly DevAccount[],
	impersonation: Impersonation,
): TransactionMethods {
	const keys = new Map(accounts.map((a) => [a.address, a.privateKey]));
	let common: Promise<{common: Common; chainId: bigint}> | undefined;
	const signingCommon = () =>
		(common ??= (async () => {
			const chainId = BigInt(
				(await node.request({method: 'eth_chainId'})) as string,
			);
			return {
				chainId,
				common: new Common({
					chain: {...Mainnet, chainId: Number(chainId), name: 'webevm-devnode'},
					hardfork: Hardfork.Prague,
				}),
			};
		})().catch((e) => {
			common = undefined;
			throw e;
		}));

	/** Fill and sign; `-32602` for a malformed request, named by `method`. */
	async function build(
		params: unknown,
		method: TransactionMethod,
	): Promise<{raw: string; from: string}> {
		try {
			return await fillAndSign(params, method);
		} catch (e) {
			if (e instanceof InvalidRequest)
				throw new RpcError(-32602, `${method}: ${e.message}`);
			throw e;
		}
	}

	async function fillAndSign(
		params: unknown,
		method: TransactionMethod,
	): Promise<{raw: string; from: string}> {
		const p = (Array.isArray(params) ? params[0] : undefined) as unknown;
		if (p === null || typeof p !== 'object' || Array.isArray(p))
			invalid('expected one transaction request object as its parameter.');
		const request = p as Request;
		if (typeof request.from !== 'string' || !ADDRESS.test(request.from))
			invalid(
				'`from` must be the 20-byte hex address of the dev account to send from.',
			);
		const from = request.from.toLowerCase();
		// The key first: a dev account that is also impersonated signs with it.
		const privateKey = keys.get(from);
		if (!privateKey) {
			const impersonated = impersonation.addresses.has(from);
			if (method === 'eth_signTransaction')
				throw new RpcError(
					4100,
					impersonated
						? impersonatedNoKeyMessage(method, from)
						: noKeyMessage(method, from),
				);
			if (!impersonated)
				throw new RpcError(
					4100,
					`eth_sendTransaction: ${from} is not a dev account, so @webevm/devnode holds no key to sign for it. ` +
						`Configure its private key in the dev node's \`accounts\` option, or impersonate it: ` +
						(impersonation.enabled
							? `call hardhat_impersonateAccount (or anvil_impersonateAccount) with ["${from}"] first.`
							: `turn on the dev node's \`impersonation\` option, then call hardhat_impersonateAccount (or anvil_impersonateAccount) with ["${from}"].`),
				);
		}

		const type = envelopeType(request);
		const data = callData(request);
		const to = request.to == null ? undefined : request.to;
		if (to !== undefined && (typeof to !== 'string' || !ADDRESS.test(to)))
			invalid('`to` must be a 20-byte hex address, or absent to create.');
		const {chainId, common} = await signingCommon();
		const requestChainId = quantity(request, 'chainId');
		if (requestChainId !== undefined && requestChainId !== chainId)
			invalid(
				`\`chainId\` ${requestChainId} is not this node's chain ID (${chainId}).`,
			);
		if (request.accessList != null && !Array.isArray(request.accessList))
			invalid('`accessList` must be an array of {address, storageKeys}.');
		if (
			request.authorizationList != null &&
			!Array.isArray(request.authorizationList)
		)
			invalid(
				'`authorizationList` must be an array of {chainId, address, nonce, yParity, r, s}.',
			);
		// Validate every named quantity before any round trip.
		const value = quantity(request, 'value') ?? 0n;
		const named = {
			nonce: quantity(request, 'nonce'),
			gas: quantity(request, 'gas'),
			gasPrice: quantity(request, 'gasPrice'),
			maxFeePerGas: quantity(request, 'maxFeePerGas'),
			maxPriorityFeePerGas: quantity(request, 'maxPriorityFeePerGas'),
		};

		const nonce =
			named.nonce ??
			BigInt(
				(await node.request({
					method: 'eth_getTransactionCount',
					params: [from, 'pending'],
				})) as string,
			);

		let gas = named.gas;
		if (gas === undefined) {
			// The same request, minus the `gas` being estimated.
			const estimate: Request = {...request, from};
			delete estimate.gas;
			gas = BigInt(
				(await node.request({
					method: 'eth_estimateGas',
					params: [estimate],
				})) as string,
			);
		}

		const txData: Record<string, unknown> = {
			type,
			nonce,
			gasLimit: gas,
			to,
			value,
			data,
		};
		if (type === 0 || type === 1) {
			txData.gasPrice =
				named.gasPrice ??
				BigInt((await node.request({method: 'eth_gasPrice'})) as string);
		} else {
			let {maxFeePerGas, maxPriorityFeePerGas} = named;
			if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
				// The node's own EIP-1559 filling, on a plain transfer whose nonce and
				// gas are fixed so it neither reads the nonce nor estimates.
				const probe: Request = {from, to: from, nonce: '0x0', gas: '0x5208'};
				if (maxFeePerGas !== undefined)
					probe.maxFeePerGas = `0x${maxFeePerGas.toString(16)}`;
				if (maxPriorityFeePerGas !== undefined)
					probe.maxPriorityFeePerGas = `0x${maxPriorityFeePerGas.toString(16)}`;
				const filled = (await node.request({
					method: 'eth_fillTransaction',
					params: [probe],
				})) as {tx: {maxFeePerGas: string; maxPriorityFeePerGas: string}};
				maxFeePerGas ??= BigInt(filled.tx.maxFeePerGas);
				maxPriorityFeePerGas ??= BigInt(filled.tx.maxPriorityFeePerGas);
			}
			txData.maxFeePerGas = maxFeePerGas;
			txData.maxPriorityFeePerGas = maxPriorityFeePerGas;
		}
		if (type !== 0) {
			txData.chainId = chainId;
			txData.accessList = request.accessList ?? [];
		}
		if (type === 4) {
			txData.authorizationList = (
				(request.authorizationList ?? []) as unknown[]
			).map(authorization);
		}

		try {
			if (privateKey) {
				const raw = bytesToHex(
					createTx(txData as TypedTxData, {common})
						.sign(privateKey, false)
						.serialize(),
				);
				return {raw, from};
			}
			// Impersonated: the fabricated signature, y-parity 0 (EIP-155's
			// `chainId * 2 + 35` on a legacy transaction).
			const {r, s} = fabricatedSignature(from);
			const v = type === 0 ? chainId * 2n + 35n : 0n;
			const raw = bytesToHex(
				createTx({...txData, v, r, s} as TypedTxData, {common}).serialize(),
			);
			return {raw, from};
		} catch (e) {
			return invalid(
				`the transaction could not be built: ${(e as Error).message}`,
			);
		}
	}

	async function send(params: unknown): Promise<string> {
		const {raw, from} = await build(params, 'eth_sendTransaction');
		return (await node.request(
			node.senderMode === 'trusted'
				? {method: 'evm_sendRawTransactionAs', params: [raw, from]}
				: {method: 'eth_sendRawTransaction', params: [raw]},
		)) as string;
	}

	// The queue: each job starts when the one before it has settled, whatever
	// its outcome, so a refused one cannot stall the ones behind it. A sign
	// runs on it too, so it reads the pending nonce AFTER every send queued
	// before it has been submitted.
	let queue: Promise<unknown> = Promise.resolve();
	function enqueue<T>(run: () => Promise<T>): Promise<T> {
		const job = queue.then(run);
		queue = job.catch(() => undefined);
		return job;
	}
	return {
		sendTransaction: (params) => enqueue(() => send(params)),
		signTransaction: (params) =>
			enqueue(async () => (await build(params, 'eth_signTransaction')).raw),
		inOrder: (job) => enqueue(async () => job()),
	};
}
