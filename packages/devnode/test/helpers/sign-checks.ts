/**
 * sign-checks.ts: the battery for the signing methods of dev accounts:
 * `eth_signTypedData_v4` (and the package's own EIP-712 encoder under it),
 * `personal_sign`, `eth_sign` and `eth_signTransaction`. It runs IN NODE
 * (../sign.spec.ts calls it directly) and in a real browser page (./cut.ts,
 * mode 'sign'), on the default engine, against the same assertions.
 *
 * THE ORACLES ARE NEVER THE PACKAGE: EIP-712's own published values for its
 * `Mail` example (`assets/eip-712/Example.js` in the EIPs repository, held in
 * ../sign-expected.ts), and viem (a dev dependency): its `hashTypedData`, its
 * local accounts' `signTypedData` / `signMessage` on the same key, its
 * `recover*Address`, and its wallet client driving the dev node over EIP-1193
 * (so the parameter orders are the ones viem sends).
 *
 * It RETURNS what it observed and asserts nothing itself.
 */
import {
	createWalletClient,
	custom,
	hashTypedData as viemHashTypedData,
	keccak256,
	parseTransaction,
	recoverMessageAddress,
	recoverTransactionAddress,
	recoverTypedDataAddress,
	stringToHex,
	toHex,
	type EIP1193Provider,
	type Hex,
	type TransactionSerialized,
	type TypedDataDefinition,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {SenderMode, SlimNode} from 'webevm';
import {encodeType, hashDomain, hashTypedData} from '../../src/eip712.js';
import {createDevNode} from '../../src/index.js';

/** EIP-712's example signer: the private key `keccak256("cow")`. */
export const COW_KEY = keccak256(stringToHex('cow'));
/** anvil's account 0, the dev node's default first account. */
const ANVIL_KEY =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const STRANGER = '0x00000000000000000000000000000000000000ee';
const RECIPIENT = '0x00000000000000000000000000000000000000cc';

/** EIP-712's own example, verbatim from the EIP. */
export const MAIL = {
	types: {
		EIP712Domain: [
			{name: 'name', type: 'string'},
			{name: 'version', type: 'string'},
			{name: 'chainId', type: 'uint256'},
			{name: 'verifyingContract', type: 'address'},
		],
		Person: [
			{name: 'name', type: 'string'},
			{name: 'wallet', type: 'address'},
		],
		Mail: [
			{name: 'from', type: 'Person'},
			{name: 'to', type: 'Person'},
			{name: 'contents', type: 'string'},
		],
	},
	primaryType: 'Mail',
	domain: {
		name: 'Ether Mail',
		version: '1',
		chainId: 1,
		verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
	},
	message: {
		from: {name: 'Cow', wallet: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826'},
		to: {name: 'Bob', wallet: '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'},
		contents: 'Hello, Bob!',
	},
} as const;

/** An EIP-2612 permit, as a token's `permit` checks it (no `EIP712Domain` declared: derived). */
export const PERMIT = {
	types: {
		Permit: [
			{name: 'owner', type: 'address'},
			{name: 'spender', type: 'address'},
			{name: 'value', type: 'uint256'},
			{name: 'nonce', type: 'uint256'},
			{name: 'deadline', type: 'uint256'},
		],
	},
	primaryType: 'Permit',
	domain: {
		name: 'USD Coin',
		version: '2',
		chainId: 31337,
		verifyingContract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
	},
	message: {
		owner: privateKeyToAccount(ANVIL_KEY).address,
		spender: '0x000000000022d473030f116ddee9f6b43ac78ba3',
		value: 2n ** 256n - 1n,
		nonce: 0n,
		deadline: 1_900_000_000n,
	},
} as const;

/**
 * Arrays (dynamic, fixed, nested) and nested structs, with every other
 * encoding beside them: a signed integer below zero, `bytes`, `bytesN`, `bool`,
 * a small `uintN`, and a struct referencing types whose names sort differently
 * from their declaration order (so `encodeType`'s sorting is exercised).
 */
export const NESTED = {
	types: {
		EIP712Domain: [
			{name: 'name', type: 'string'},
			{name: 'chainId', type: 'uint256'},
			{name: 'salt', type: 'bytes32'},
		],
		Order: [
			{name: 'maker', type: 'Party'},
			{name: 'legs', type: 'Leg[]'},
			{name: 'tags', type: 'bytes32[2]'},
			{name: 'matrix', type: 'int16[][]'},
			{name: 'notes', type: 'string[]'},
			{name: 'payload', type: 'bytes'},
			{name: 'active', type: 'bool'},
		],
		Party: [
			{name: 'wallet', type: 'address'},
			{name: 'aliases', type: 'string[]'},
		],
		Leg: [
			{name: 'asset', type: 'Asset'},
			{name: 'amount', type: 'int256'},
			{name: 'decimals', type: 'uint8'},
		],
		Asset: [
			{name: 'token', type: 'address'},
			{name: 'id', type: 'bytes4'},
		],
	},
	primaryType: 'Order',
	domain: {
		name: 'Nested',
		chainId: 31337,
		salt: '0x00000000000000000000000000000000000000000000000000000000000000ab',
	},
	message: {
		maker: {
			wallet: '0x1111111111111111111111111111111111111111',
			aliases: ['alice', 'ålîçé ✓'],
		},
		legs: [
			{
				asset: {
					token: '0x2222222222222222222222222222222222222222',
					id: '0xdeadbeef',
				},
				amount: -5n,
				decimals: 18,
			},
			{
				asset: {
					token: '0x3333333333333333333333333333333333333333',
					id: '0x00000001',
				},
				amount: 2n ** 255n - 1n,
				decimals: 0,
			},
		],
		tags: [
			'0x0000000000000000000000000000000000000000000000000000000000000001',
			'0xff00000000000000000000000000000000000000000000000000000000000000',
		],
		matrix: [[1, -2], [], [-32768, 32767, 0]],
		notes: [],
		payload: '0x0102030405',
		active: true,
	},
} as const;

const json = (v: unknown) =>
	JSON.parse(
		JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)),
	);

async function outcome(p: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		return {resolved: await p};
	} catch (e) {
		const err = e as {code?: unknown; message?: unknown};
		return {code: err.code, message: err.message};
	}
}

/** One typed-data case: the package's digest, viem's, and both signatures. */
async function typedCase(
	node: SlimNode,
	key: Hex,
	typed: TypedDataDefinition,
	through: 'object' | 'viem-wallet',
) {
	const account = privateKeyToAccount(key);
	const address = account.address.toLowerCase();
	let signature: unknown;
	if (through === 'viem-wallet') {
		// viem's wallet client sends `eth_signTypedData_v4 [address, JSON text]`.
		const wallet = createWalletClient({
			transport: custom(node as unknown as EIP1193Provider),
		});
		signature = await wallet.signTypedData({
			account: account.address,
			...(typed as any),
		});
	} else {
		signature = await node.request({
			method: 'eth_signTypedData_v4',
			params: [address, json(typed)],
		});
	}
	return {
		address,
		digest: toHex(hashTypedData(json(typed))),
		viemDigest: viemHashTypedData(typed),
		signature,
		viemSignature: await account.signTypedData(typed as any),
		recovered: (
			await recoverTypedDataAddress({
				...(typed as any),
				signature: signature as Hex,
			})
		).toLowerCase(),
	};
}

async function signTransactionCase(mode: SenderMode) {
	const node = await createDevNode({senderMode: mode});
	const [from] = (await node.request({method: 'eth_accounts'})) as Hex[];
	const before = {
		block: await node.request({method: 'eth_blockNumber'}),
		nonce: await node.request({
			method: 'eth_getTransactionCount',
			params: [from, 'pending'],
		}),
	};
	const raw = (await node.request({
		method: 'eth_signTransaction',
		params: [{from, to: RECIPIENT, value: '0x7b'}],
	})) as Hex;
	// Signing sent nothing.
	const afterSign = {
		block: await node.request({method: 'eth_blockNumber'}),
		nonce: await node.request({
			method: 'eth_getTransactionCount',
			params: [from, 'pending'],
		}),
	};
	const tx = parseTransaction(raw as TransactionSerialized);
	const signer = (
		await recoverTransactionAddress({
			serializedTransaction: raw as TransactionSerialized,
		})
	).toLowerCase();
	const hash = await node.request({
		method: 'eth_sendRawTransaction',
		params: [raw],
	});
	const receipt = (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	})) as {from: string; status: string; to: string} | null;

	// viem's wallet client: `signTransaction` with a JSON-RPC account sends
	// `eth_signTransaction` with the fields it prepared.
	const wallet = createWalletClient({
		transport: custom(node as unknown as EIP1193Provider),
	});
	const viemRaw = await wallet.signTransaction({
		account: from,
		to: RECIPIENT,
		value: 5n,
		chain: null,
	});
	const viemSigner = (
		await recoverTransactionAddress({
			serializedTransaction: viemRaw as TransactionSerialized,
		})
	).toLowerCase();
	const viemHash = await node.request({
		method: 'eth_sendRawTransaction',
		params: [viemRaw],
	});
	const viemReceipt = (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [viemHash],
	})) as {from: string; status: string} | null;

	const refusals = {
		unknown: await outcome(
			node.request({
				method: 'eth_signTransaction',
				params: [{from: STRANGER, to: RECIPIENT}],
			}),
		),
		conflict: await outcome(
			node.request({
				method: 'eth_signTransaction',
				params: [{from, to: RECIPIENT, gasPrice: '0x1', maxFeePerGas: '0x1'}],
			}),
		),
	};
	await node.dispose();
	return {
		from: from!.toLowerCase(),
		before,
		afterSign,
		rawIsHex: typeof raw === 'string' && /^0x[0-9a-f]+$/.test(raw),
		type: tx.type,
		nonce: tx.nonce,
		value: String(tx.value),
		chainId: tx.chainId,
		signer,
		receipt,
		viemSigner,
		viemReceipt,
		refusals,
	};
}

export async function runSignChecks() {
	// 1. THE ENCODER against EIP-712's published values for its own example.
	const mail = {
		encodeType: encodeType(MAIL.types, 'Mail'),
		typeHash: keccak256(stringToHex(encodeType(MAIL.types, 'Mail'))),
		domainSeparator: toHex(hashDomain(json(MAIL))),
		digest: toHex(hashTypedData(json(MAIL))),
	};

	// 2. eth_signTypedData_v4 on a node whose one account is EIP-712's signer,
	// and on the default accounts.
	const cowNode = await createDevNode({accounts: [COW_KEY]});
	const mailSigned = await typedCase(cowNode, COW_KEY, MAIL as any, 'object');
	const mailViaViem = await typedCase(
		cowNode,
		COW_KEY,
		MAIL as any,
		'viem-wallet',
	);
	await cowNode.dispose();

	const node = await createDevNode();
	const permit = await typedCase(node, ANVIL_KEY, PERMIT as any, 'viem-wallet');
	const nested = await typedCase(node, ANVIL_KEY, NESTED as any, 'object');
	const nestedViaViem = await typedCase(
		node,
		ANVIL_KEY,
		NESTED as any,
		'viem-wallet',
	);
	// The domain alone (`primaryType: 'EIP712Domain'`).
	const domainOnly = await typedCase(
		node,
		ANVIL_KEY,
		{...MAIL, primaryType: 'EIP712Domain', message: {}} as any,
		'object',
	);

	// 3. personal_sign [message, address] and eth_sign [address, message].
	const account = privateKeyToAccount(ANVIL_KEY);
	const address = account.address.toLowerCase();
	const wallet = createWalletClient({
		transport: custom(node as unknown as EIP1193Provider),
	});
	const text = 'Sign in to example.org\nNonce: 42 ✓';
	const raw = '0x00ff10deadbeef' as Hex;
	const messages = {
		// viem's wallet client: personal_sign [toHex(text), address].
		viemText: await wallet.signMessage({
			account: account.address,
			message: text,
		}),
		viemRaw: await wallet.signMessage({
			account: account.address,
			message: {raw},
		}),
		// A plain-text message, as MetaMask-shaped dapps send it.
		plainText: await node.request({
			method: 'personal_sign',
			params: [text, address],
		}),
		ethSign: await node.request({method: 'eth_sign', params: [address, raw]}),
		ethSignText: await node.request({
			method: 'eth_sign',
			params: [address, stringToHex(text)],
		}),
		expectedText: await account.signMessage({message: text}),
		expectedRaw: await account.signMessage({message: {raw}}),
	};
	const recovered = {
		viemText: (
			await recoverMessageAddress({
				message: text,
				signature: messages.viemText as Hex,
			})
		).toLowerCase(),
		ethSign: (
			await recoverMessageAddress({
				message: {raw},
				signature: messages.ethSign as Hex,
			})
		).toLowerCase(),
	};

	// 4. REFUSALS: an address with no key, and malformed requests.
	const refusals = {
		personalUnknown: await outcome(
			node.request({method: 'personal_sign', params: [raw, STRANGER]}),
		),
		ethSignUnknown: await outcome(
			node.request({method: 'eth_sign', params: [STRANGER, raw]}),
		),
		typedUnknown: await outcome(
			node.request({
				method: 'eth_signTypedData_v4',
				params: [STRANGER, json(MAIL)],
			}),
		),
		// eth_sign with personal_sign's order: the first parameter is no address.
		ethSignSwapped: await outcome(
			node.request({method: 'eth_sign', params: [raw, address]}),
		),
		typedMissingMember: await outcome(
			node.request({
				method: 'eth_signTypedData_v4',
				params: [address, {...json(MAIL), message: {from: MAIL.message.from}}],
			}),
		),
		typedOutOfRange: await outcome(
			node.request({
				method: 'eth_signTypedData_v4',
				params: [
					address,
					{
						...json(NESTED),
						message: {
							...json(NESTED).message,
							legs: [{...json(NESTED).message.legs[0], decimals: 256}],
						},
					},
				],
			}),
		),
		typedUnknownType: await outcome(
			node.request({
				method: 'eth_signTypedData_v4',
				params: [
					address,
					{...json(PERMIT), types: {Permit: [{name: 'x', type: 'Nope'}]}},
				],
			}),
		),
		typedBadJson: await outcome(
			node.request({method: 'eth_signTypedData_v4', params: [address, '{']}),
		),
	};
	await node.dispose();

	return json({
		mail,
		mailSigned,
		mailViaViem,
		permit,
		nested,
		nestedViaViem,
		domainOnly,
		address,
		messages,
		recovered,
		refusals,
		signTransaction: {
			recover: await signTransactionCase('recover'),
			trusted: await signTransactionCase('trusted'),
		},
	});
}
