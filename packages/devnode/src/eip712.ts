/**
 * eip712.ts: EIP-712 typed structured data hashing, this package's own code (a
 * maintainer decision, ADR 0017: "EIP-712 hashing is the package's own code"),
 * with no dependency beyond the keccak the package already has.
 *
 * It follows the EIP's text (https://eips.ethereum.org/EIPS/eip-712):
 *
 * - `encode(domainSeparator, message) = "\x19\x01" ‖ domainSeparator ‖ hashStruct(message)`;
 * - `hashStruct(s) = keccak256(typeHash ‖ encodeData(s))`, `typeHash = keccak256(encodeType(typeOf(s)))`;
 * - `encodeType` is `Name(type1 name1,...)` for the primary type, followed by
 *   every type it references (directly or through other types or arrays),
 *   SORTED BY NAME, each once;
 * - `encodeData` concatenates one 32-byte word per member, in declaration
 *   order: `bool`, `address`, `uintN`, `intN` (sign-extended) and `bytesN`
 *   (right-padded) encoded as the ABI encodes them; `bytes` and `string` as the
 *   keccak256 of their content (a string's UTF-8 bytes); a struct as its
 *   `hashStruct`; an array, fixed or dynamic, as the keccak256 of its elements'
 *   encodings concatenated.
 *
 * It is verified in tests against the EIP's own published `Mail` digest and
 * against viem's `hashTypedData`, never against itself.
 *
 * DECISIONS made here (task `devnode-signing-methods-and-eip-712`), each
 * user-visible and reversible before 1.0:
 *
 * - A MISSING `EIP712Domain` TYPE IS DERIVED from the fields the domain has, in
 *   the EIP's order (`name`, `version`, `chainId`, `verifyingContract`, `salt`),
 *   as viem and ethers derive it. Alternative: `@metamask/eth-sig-util`'s
 *   `EIP712Domain()` with no fields, which hashes the domain as empty and so
 *   ignores a chain ID the caller passed. A request that declares the type is
 *   hashed with exactly the declaration.
 * - `primaryType: 'EIP712Domain'` hashes the domain alone, `"\x19\x01" ‖
 *   domainSeparator`, as viem and eth-sig-util do.
 * - VALUES ARE CHECKED, NEVER COERCED INTO A DIFFERENT MEANING: a member
 *   missing from the message, an integer out of its type's range, a `bytesN`
 *   that is not exactly N bytes, an address that is not 20 bytes, a `bool` that
 *   is not a boolean, or a fixed-size array of the wrong length is an error
 *   naming the member's path. Integers are accepted as JSON numbers (safe
 *   integers only), decimal strings, hex strings (`0x`, `-0x` for a negative
 *   `intN`) and bigints. Members the message has beyond its type are ignored, as
 *   the EIP encodes only the type's members.
 */
import {keccak_256} from '@noble/hashes/sha3.js';

/** A struct type's members, as the `types` field of a request declares them. */
export type TypedDataField = {name: string; type: string};

/** The `eth_signTypedData_v4` payload. */
export interface TypedData {
	types: Record<string, readonly TypedDataField[]>;
	primaryType: string;
	domain: Record<string, unknown>;
	message: Record<string, unknown>;
}

/** The fields an `EIP712Domain` may have, in the order the EIP lists them. */
const DOMAIN_FIELDS: readonly TypedDataField[] = [
	{name: 'name', type: 'string'},
	{name: 'version', type: 'string'},
	{name: 'chainId', type: 'uint256'},
	{name: 'verifyingContract', type: 'address'},
	{name: 'salt', type: 'bytes32'},
];

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ARRAY_SUFFIX = /^(.*)\[(\d*)\]$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^uint(\d{1,3})$/;
const INT = /^int(\d{1,3})$/;
const BYTES_N = /^bytes(\d{1,2})$/;

const encoder = new TextEncoder();

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const p of parts) length += p.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function hexToBytes(hex: string): Uint8Array {
	const out = new Uint8Array((hex.length - 2) / 2);
	for (let i = 0; i < out.length; i++)
		out[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
	return out;
}

/** A non-negative bigint below 2^256 as one big-endian 32-byte word. */
function word(value: bigint): Uint8Array {
	const out = new Uint8Array(32);
	for (let i = 31; i >= 0; i--) {
		out[i] = Number(value & 0xffn);
		value >>= 8n;
	}
	return out;
}

/** The type an array type holds, or `undefined` for a non-array type. */
function arrayOf(type: string): {item: string; length?: number} | undefined {
	const m = ARRAY_SUFFIX.exec(type);
	if (!m) return undefined;
	return {item: m[1]!, length: m[2] === '' ? undefined : Number(m[2])};
}

/** The struct (or atomic) type at the root of a possibly-array type. */
function baseType(type: string): string {
	let t = type;
	for (let a = arrayOf(t); a; a = arrayOf(t)) t = a.item;
	return t;
}

function isAtomic(type: string): boolean {
	if (type === 'bool' || type === 'address' || type === 'string') return true;
	if (type === 'bytes') return true;
	const u = UINT.exec(type) ?? INT.exec(type);
	if (u) {
		const bits = Number(u[1]);
		return bits >= 8 && bits <= 256 && bits % 8 === 0;
	}
	const b = BYTES_N.exec(type);
	if (b) {
		const n = Number(b[1]);
		return n >= 1 && n <= 32;
	}
	return false;
}

/** An integer value as a bigint, from the forms a JSON-RPC request carries. */
function integer(path: string, value: unknown): bigint {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value))
			fail(
				path,
				`${value} is not a safe integer; pass a large integer as a decimal or hex string.`,
			);
		return BigInt(value);
	}
	if (typeof value === 'string') {
		if (/^-?[0-9]+$/.test(value)) return BigInt(value);
		if (/^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
		if (/^-0x[0-9a-fA-F]+$/.test(value)) return -BigInt(value.slice(1));
	}
	return fail(
		path,
		`expected an integer (a number, a decimal string or a hex string), received ${JSON.stringify(value)}.`,
	);
}

function hexData(path: string, value: unknown): Uint8Array {
	if (typeof value !== 'string' || !HEX_DATA.test(value))
		fail(
			path,
			`expected even-length 0x hex, received ${JSON.stringify(value)}.`,
		);
	return hexToBytes(value);
}

/**
 * The encoder for one typed-data payload: its struct types, checked once.
 */
class Encoder {
	private readonly typeHashes = new Map<string, Uint8Array>();

	constructor(
		private readonly types: Record<string, readonly TypedDataField[]>,
	) {
		for (const [name, fields] of Object.entries(types)) {
			if (!IDENTIFIER.test(name))
				fail(`types.${name}`, 'is not a valid struct type name.');
			if (isAtomic(name))
				fail(`types.${name}`, 'is the name of an atomic type, not a struct.');
			if (!Array.isArray(fields))
				fail(`types.${name}`, 'must be an array of {name, type}.');
			const seen = new Set<string>();
			fields.forEach((field, i) => {
				const at = `types.${name}[${i}]`;
				if (
					field === null ||
					typeof field !== 'object' ||
					typeof field.name !== 'string' ||
					typeof field.type !== 'string'
				)
					fail(at, 'must be {name, type} with both strings.');
				if (!IDENTIFIER.test(field.name))
					fail(at, `${JSON.stringify(field.name)} is not a valid member name.`);
				if (seen.has(field.name))
					fail(at, `member ${field.name} is declared twice.`);
				seen.add(field.name);
				const base = baseType(field.type);
				if (!isAtomic(base) && !(base in types))
					fail(
						at,
						`type ${JSON.stringify(field.type)} is neither atomic nor declared in \`types\`.`,
					);
			});
		}
	}

	/** The struct types `primary` references, itself included, each once. */
	private dependencies(
		primary: string,
		found = new Set<string>(),
	): Set<string> {
		if (found.has(primary) || !(primary in this.types)) return found;
		found.add(primary);
		for (const field of this.types[primary]!)
			this.dependencies(baseType(field.type), found);
		return found;
	}

	/** `encodeType`: the primary type, then its references sorted by name. */
	encodeType(primary: string): string {
		const deps = [...this.dependencies(primary)].filter((t) => t !== primary);
		deps.sort();
		return [primary, ...deps]
			.map(
				(t) =>
					`${t}(${this.types[t]!.map((f) => `${f.type} ${f.name}`).join(',')})`,
			)
			.join('');
	}

	typeHash(primary: string): Uint8Array {
		let hash = this.typeHashes.get(primary);
		if (!hash) {
			hash = keccak_256(encoder.encode(this.encodeType(primary)));
			this.typeHashes.set(primary, hash);
		}
		return hash;
	}

	/** `hashStruct`: keccak256(typeHash ‖ encodeData(data)). */
	hashStruct(primary: string, data: unknown, path: string): Uint8Array {
		if (!(primary in this.types))
			fail(
				path,
				`type ${JSON.stringify(primary)} is not declared in \`types\`.`,
			);
		if (data === null || typeof data !== 'object' || Array.isArray(data))
			fail(path, `expected an object of type ${primary}.`);
		const record = data as Record<string, unknown>;
		const words = [this.typeHash(primary)];
		for (const field of this.types[primary]!) {
			const at = `${path}.${field.name}`;
			if (record[field.name] === undefined)
				fail(at, `member of ${primary} is missing.`);
			words.push(this.encodeValue(field.type, record[field.name], at));
		}
		return keccak_256(concat(words));
	}

	/** One member's 32-byte encoding. */
	encodeValue(type: string, value: unknown, path: string): Uint8Array {
		const array = arrayOf(type);
		if (array) {
			if (!Array.isArray(value)) fail(path, `expected an array (${type}).`);
			if (array.length !== undefined && value.length !== array.length)
				fail(
					path,
					`expected ${array.length} elements (${type}), received ${value.length}.`,
				);
			return keccak_256(
				concat(
					value.map((v, i) => this.encodeValue(array.item, v, `${path}[${i}]`)),
				),
			);
		}
		if (type in this.types) return this.hashStruct(type, value, path);
		if (type === 'string') {
			if (typeof value !== 'string') fail(path, 'expected a string.');
			return keccak_256(encoder.encode(value));
		}
		if (type === 'bytes') return keccak_256(hexData(path, value));
		if (type === 'bool') {
			if (typeof value !== 'boolean') fail(path, 'expected true or false.');
			return word(value ? 1n : 0n);
		}
		if (type === 'address') {
			if (typeof value !== 'string' || !ADDRESS.test(value))
				fail(
					path,
					`expected a 20-byte 0x address, received ${JSON.stringify(value)}.`,
				);
			return word(BigInt(value));
		}
		const u = UINT.exec(type);
		if (u) {
			const bits = BigInt(u[1]!);
			const v = integer(path, value);
			if (v < 0n || v >= 1n << bits)
				fail(path, `${v} is out of range for ${type}.`);
			return word(v);
		}
		const s = INT.exec(type);
		if (s) {
			const bits = BigInt(s[1]!);
			const v = integer(path, value);
			const half = 1n << (bits - 1n);
			if (v < -half || v >= half)
				fail(path, `${v} is out of range for ${type}.`);
			// Sign-extended to 256 bits: two's complement.
			return word(v < 0n ? (1n << 256n) + v : v);
		}
		const b = BYTES_N.exec(type);
		if (b) {
			const n = Number(b[1]);
			const bytes = hexData(path, value);
			if (bytes.length !== n)
				fail(
					path,
					`expected exactly ${n} bytes (${type}), received ${bytes.length}.`,
				);
			const out = new Uint8Array(32);
			out.set(bytes);
			return out;
		}
		return fail(path, `unknown type ${JSON.stringify(type)}.`);
	}
}

/** The domain's struct type: the one declared, or derived from its fields. */
function domainFields(typed: TypedData): readonly TypedDataField[] {
	const declared = typed.types.EIP712Domain;
	if (declared) return declared;
	return DOMAIN_FIELDS.filter((f) => typed.domain[f.name] !== undefined);
}

/** Check the payload's shape, so the encoder can read it as {@link TypedData}. */
function asTypedData(value: unknown): TypedData {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		fail('typedData', 'expected {types, primaryType, domain, message}.');
	const t = value as Record<string, unknown>;
	if (t.types === null || typeof t.types !== 'object' || Array.isArray(t.types))
		fail('types', 'expected an object of struct types.');
	if (typeof t.primaryType !== 'string')
		fail('primaryType', 'expected the name of a type in `types`.');
	const domain = t.domain ?? {};
	if (domain === null || typeof domain !== 'object' || Array.isArray(domain))
		fail('domain', 'expected an object.');
	return {
		types: t.types as TypedData['types'],
		primaryType: t.primaryType,
		domain: domain as Record<string, unknown>,
		message: (t.message ?? {}) as Record<string, unknown>,
	};
}

/** The domain separator: `hashStruct(eip712Domain)`. */
export function hashDomain(value: unknown): Uint8Array {
	const typed = asTypedData(value);
	const types = {...typed.types, EIP712Domain: domainFields(typed)};
	return new Encoder(types).hashStruct('EIP712Domain', typed.domain, 'domain');
}

/**
 * The EIP-712 digest a typed-data signature signs:
 * `keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))`.
 * Throws an `Error` naming the offending path on a malformed payload.
 */
export function hashTypedData(value: unknown): Uint8Array {
	const typed = asTypedData(value);
	const types = {...typed.types, EIP712Domain: domainFields(typed)};
	const enc = new Encoder(types);
	const parts = [
		Uint8Array.of(0x19, 0x01),
		enc.hashStruct('EIP712Domain', typed.domain, 'domain'),
	];
	if (typed.primaryType !== 'EIP712Domain')
		parts.push(enc.hashStruct(typed.primaryType, typed.message, 'message'));
	return keccak_256(concat(parts));
}

/** `encodeType` for one of the payload's types (exposed for tests). */
export function encodeType(
	types: Record<string, readonly TypedDataField[]>,
	primary: string,
): string {
	return new Encoder(types).encodeType(primary);
}
