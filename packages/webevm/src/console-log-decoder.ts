/**
 * console-log-decoder.ts: the selector table, the hand-written ABI decoder and
 * the browser-safe formatter behind `webevm/console-log` (./console-log.ts).
 * INTERNAL: it is not in the package's `exports` map, and only ./console-log.ts
 * imports it, so it is never in the default entry's graph (ADR 0018).
 *
 * WHAT IS DECODED. The input bytes of one call frame into the console address
 * `0x000000000000000000636F6e736F6c652e6c6f67`: a four-byte selector and the ABI
 * encoding of its arguments. This module never sees the address; the engine
 * picked the frames, and the node hands their inputs over.
 *
 * THE SELECTOR TABLE is the union of the function signatures in the PINNED
 * Hardhat `hardhat/console.sol` and forge-std `src/console.sol` /
 * `src/console2.sol` (vendored, with the pins, under
 * `test/fixtures/console-log/`), plus a legacy alias for every one of them that
 * contains `uint256` or `int256`. It is GENERATED here rather than listed,
 * exactly the way Hardhat's own `console-library-generator` generates the
 * Solidity file (every permutation of `uint256` / `string` / `bool` / `address`
 * up to four arguments, and the single-argument functions), and
 * `test/console-log.spec.ts` parses the vendored files and asserts the generated
 * set is EXACTLY theirs, so a re-pin that adds a signature fails loudly. The
 * selectors are computed on the first decode, never at import.
 *
 * Decisions taken here (see the done record of task
 * `webevm-console-log-decodes-and-formats-console-calls`):
 *
 *  - "A SIGNATURE" IS BOTH SPELLINGS IN THE FILE. Each library function is
 *    declared under one name and sends a payload encoded under another:
 *    `function logUint(uint256 p0)` sends `abi.encodeWithSignature("log(uint256)")`.
 *    Only the encoded spelling is ever on the wire from the pinned files, but the
 *    spec names `logUint(uint)` among the legacy selectors, so the table carries
 *    the DECLARED spelling (`logUint(uint256)`, `logBytes4(bytes4)`, ...) as well.
 *    A selector nothing sends costs one map entry and can mis-decode nothing.
 *    The alternative, encoded spellings only, would match Hardhat's table exactly
 *    and drop `logUint(uint)`.
 *  - THE LEGACY ALIAS SPELLS EVERY INTEGER OF A SIGNATURE `uint` / `int` AT ONCE
 *    (`log(uint,uint)`, never `log(uint256,uint)`), which is what old Hardhat
 *    versions compiled (`hardhat@2.9.0`'s `console.sol` writes
 *    `abi.encodeWithSignature("log(uint,uint)")`) and what Hardhat's generator
 *    aliases. Mixed spellings were never emitted by any version.
 *  - forge-std's `console.table(...)` IS NOT IN THE TABLE. forge-std v1.17.0
 *    added twelve `table` functions taking ARRAYS (`table(uint256[])`,
 *    `table(string[],bool[])`, ...), which no other node in this family decodes
 *    and whose printed form is forge's own; the decoder covers exactly the types
 *    the `log*` functions use. A `table` call is therefore an unknown selector,
 *    ignored like any other. Adding it is additive (an array decoder and a table
 *    renderer); the spec test asserts the exclusion is exactly those twelve.
 *
 * THE DECODER is lax where Hardhat is lax and strict where reading past the end
 * would be required: a bool is `true` when the last byte of its word is non-zero,
 * an address is the low twenty bytes of its word and a `bytesN` the first N
 * bytes, whatever the padding holds (Hardhat's reading, so no log Hardhat prints
 * is dropped here); trailing bytes are ignored. What cannot be read is refused:
 * fewer than four bytes, an unknown selector, a head shorter than one word per
 * argument, a dynamic offset or length that points past the end. Refused means
 * `undefined`, never a throw: malformed console calldata is ignored (ADR 0018).
 *
 * THE FORMATTER reproduces Hardhat's printed line, which is
 * `util.format(...args)` over the arguments rendered as STRINGS, after `%d` /
 * `%i` in the first argument are rewritten to `%s` (so an integer beyond 2^53 is
 * never pushed through a JS number). It is written out here because `node:util`
 * is not browser-safe. Consequences that are Hardhat's and are kept: `%o` and
 * `%O` quote their argument as `util.inspect` quotes a string; `%j` is
 * `JSON.stringify` of it, `%f` its `parseFloat`, `%c` consumes it and prints
 * nothing (Node's `util.format` honours those three as well); a specifier with
 * no argument left is printed as written, so a lone `%d` prints as `%s`; surplus
 * arguments are appended, space separated; a first argument with no argument
 * after it is printed verbatim (`%%` included). One deliberate difference from
 * Hardhat 3: addresses are rendered CHECKSUMMED (EIP-55), where Hardhat prints
 * them lower-case.
 */
import {keccak_256} from '@noble/hashes/sha3.js';

/** One decoded argument: integers as `bigint`, addresses as checksummed hex,
 * `bytes` / `bytesN` as `0x` hex, strings and booleans as themselves. */
export type ConsoleLogArg = bigint | string | boolean;

/** One decoded console call: its arguments in order, and the formatted line. */
export interface DecodedConsoleCall {
	args: ConsoleLogArg[];
	message: string;
}

/** The ABI types the console libraries' `log*` functions use. */
type ArgType =
	| 'uint256'
	| 'int256'
	| 'bool'
	| 'address'
	| 'string'
	| 'bytes'
	| `bytes${number}`;

/** The alphabet of the multi-argument overloads, in Hardhat's generator order. */
const MULTI_TYPES: readonly ArgType[] = [
	'uint256',
	'string',
	'bool',
	'address',
];

/** The single-argument functions' types, each also under its typed name. */
function singleTypes(): ArgType[] {
	const types: ArgType[] = [
		'int256',
		'uint256',
		'string',
		'bool',
		'address',
		'bytes',
	];
	for (let n = 1; n <= 32; n++) types.push(`bytes${n}`);
	return types;
}

/** `logUint`, `logInt`, `logString`, `logBytes4`, ...: the typed function name. */
function typedName(type: ArgType): string {
	const short = type.replace('int256', 'int');
	return `log${short.charAt(0).toUpperCase()}${short.slice(1)}`;
}

/** The canonical signatures with their argument types, before aliasing. */
function canonicalSignatures(): Array<[string, ArgType[]]> {
	const out: Array<[string, ArgType[]]> = [['log()', []]];
	for (const type of singleTypes()) {
		out.push([`log(${type})`, [type]]);
		out.push([`${typedName(type)}(${type})`, [type]]);
	}
	for (let arity = 2; arity <= 4; arity++) {
		const count = MULTI_TYPES.length ** arity;
		for (let j = 0; j < count; j++) {
			const types: ArgType[] = [];
			let rest = j;
			for (let k = 0; k < arity; k++) {
				types.unshift(MULTI_TYPES[rest % MULTI_TYPES.length]);
				rest = Math.floor(rest / MULTI_TYPES.length);
			}
			out.push([`log(${types.join(',')})`, types]);
		}
	}
	// forge-std only (not in Hardhat's file).
	out.push(['log(string,int256)', ['string', 'int256']]);
	return out;
}

let signatureList: Array<[string, ArgType[]]> | undefined;

/** Every signature in the table, canonical ones and their legacy aliases. */
function allSignatures(): Array<[string, ArgType[]]> {
	if (signatureList !== undefined) return signatureList;
	const list: Array<[string, ArgType[]]> = [];
	for (const [signature, types] of canonicalSignatures()) {
		list.push([signature, types]);
		// `uint256` -> `uint` and `int256` -> `int`, every one at once.
		const alias = signature.replaceAll('int256', 'int');
		if (alias !== signature) list.push([alias, types]);
	}
	signatureList = list;
	return list;
}

/**
 * The signatures the selector table answers, canonical spellings and legacy
 * aliases. For inspection (the spec test compares it with the vendored files);
 * decoding never needs it.
 */
export function consoleLogSignatures(): string[] {
	return allSignatures().map(([signature]) => signature);
}

const utf8Encoder = /* @__PURE__ */ new TextEncoder();

/** The four-byte selector of a signature, as an unsigned 32-bit number. */
function selectorOf(signature: string): number {
	const h = keccak_256(utf8Encoder.encode(signature));
	return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

let selectorTable: Map<number, ArgType[]> | undefined;

/** The selector table, built on first use. */
function table(): Map<number, ArgType[]> {
	if (selectorTable !== undefined) return selectorTable;
	const map = new Map<number, ArgType[]>();
	for (const [signature, types] of allSignatures()) {
		map.set(selectorOf(signature), types);
	}
	selectorTable = map;
	return map;
}

const HEX = '0123456789abcdef';

function hexOf(bytes: Uint8Array): string {
	let s = '0x';
	for (let i = 0; i < bytes.length; i++) {
		s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
	}
	return s;
}

/** A 32-byte word as an unsigned bigint. */
function wordAt(data: Uint8Array, offset: number): bigint {
	return BigInt(hexOf(data.subarray(offset, offset + 32)));
}

/** An EIP-55 checksummed address from its 20 bytes. */
function checksummed(bytes: Uint8Array): string {
	const lower = hexOf(bytes).slice(2);
	const hash = keccak_256(utf8Encoder.encode(lower));
	let out = '0x';
	for (let i = 0; i < lower.length; i++) {
		const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 15;
		out += nibble >= 8 ? lower[i].toUpperCase() : lower[i];
	}
	return out;
}

// `ignoreBOM` keeps a leading U+FEFF, as Hardhat's `Buffer#toString` does.
const utf8Decoder = /* @__PURE__ */ new TextDecoder('utf-8', {ignoreBOM: true});

const TWO_255 = 1n << 255n;
const TWO_256 = 1n << 256n;

/** The `[start, end)` of a dynamic argument's bytes, or `undefined` if any part
 * of it lies past the end of the data. */
function dynamicRange(
	data: Uint8Array,
	head: number,
): [number, number] | undefined {
	const offset = wordAt(data, head);
	if (offset + 32n > BigInt(data.length)) return undefined;
	const start = Number(offset) + 32;
	const length = wordAt(data, Number(offset));
	if (BigInt(start) + length > BigInt(data.length)) return undefined;
	return [start, start + Number(length)];
}

function decodeArg(
	data: Uint8Array,
	head: number,
	type: ArgType,
): ConsoleLogArg | undefined {
	switch (type) {
		case 'uint256':
			return wordAt(data, head);
		case 'int256': {
			const word = wordAt(data, head);
			return word >= TWO_255 ? word - TWO_256 : word;
		}
		case 'bool':
			return data[head + 31] !== 0;
		case 'address':
			return checksummed(data.subarray(head + 12, head + 32));
		case 'string': {
			const range = dynamicRange(data, head);
			if (range === undefined) return undefined;
			return utf8Decoder.decode(data.subarray(range[0], range[1]));
		}
		case 'bytes': {
			const range = dynamicRange(data, head);
			if (range === undefined) return undefined;
			return hexOf(data.subarray(range[0], range[1]));
		}
		default: {
			const size = Number(type.slice(5));
			return hexOf(data.subarray(head, head + size));
		}
	}
}

/**
 * Decode the input bytes of one call into the console address, or `undefined`
 * when they are not a console call this table knows or cannot be read. Never
 * throws.
 */
export function decodeConsoleCall(
	input: Uint8Array,
): DecodedConsoleCall | undefined {
	try {
		if (input.length < 4) return undefined;
		const selector =
			((input[0] << 24) | (input[1] << 16) | (input[2] << 8) | input[3]) >>> 0;
		const types = table().get(selector);
		if (types === undefined) return undefined;
		const data = input.subarray(4);
		if (data.length < types.length * 32) return undefined;
		const args: ConsoleLogArg[] = [];
		for (let i = 0; i < types.length; i++) {
			const arg = decodeArg(data, i * 32, types[i]);
			if (arg === undefined) return undefined;
			args.push(arg);
		}
		return {args, message: formatConsoleArgs(args)};
	} catch {
		// Belt and braces: nothing above should throw on any input, and a
		// debugging aid must never fail the execution it observes.
		return undefined;
	}
}

/** An argument as Hardhat renders it before formatting: always a string. */
function render(arg: ConsoleLogArg): string {
	if (typeof arg === 'bigint') return arg.toString(10);
	if (typeof arg === 'boolean') return arg ? 'true' : 'false';
	return arg;
}

/**
 * Hardhat's rewrite of the format string: `%d` / `%i` become `%s` where the `%`
 * is not itself escaped, i.e. at the end of a run of an ODD number of `%`.
 * (Hardhat's regex `/((?<!%)(?:%%)*)(%[di])/g`, without the look-behind.)
 */
function rewriteIntegerSpecifiers(format: string): string {
	let out = '';
	let run = 0;
	for (let i = 0; i < format.length; i++) {
		const c = format[i];
		if ((c === 'd' || c === 'i') && run % 2 === 1) {
			out += 's';
		} else {
			out += c;
		}
		run = c === '%' ? run + 1 : 0;
	}
	return out;
}

/** Node's `util.inspect` table of escapes for a string's code units. */
function metaEscape(code: number): string {
	switch (code) {
		case 8:
			return '\\b';
		case 9:
			return '\\t';
		case 10:
			return '\\n';
		case 12:
			return '\\f';
		case 13:
			return '\\r';
		case 39:
			return "\\'";
		case 92:
			return '\\\\';
		default:
			return `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
	}
}

/** `util.inspect`'s quoting and escaping of one string (its `strEscape`). */
function quoteString(str: string): string {
	// 39 = single quote (escaped inside), -1 = double quotes, -2 = backticks.
	let quote = 39;
	if (str.includes("'")) {
		if (!str.includes('"')) quote = -1;
		else if (!str.includes('`') && !str.includes('${')) quote = -2;
	}
	let result = '';
	let last = 0;
	for (let i = 0; i < str.length; i++) {
		const point = str.charCodeAt(i);
		if (
			point === quote ||
			point === 92 ||
			point < 32 ||
			(point > 126 && point < 160)
		) {
			result += str.slice(last, i) + metaEscape(point);
			last = i + 1;
		} else if (point >= 0xd800 && point <= 0xdfff) {
			if (point <= 0xdbff && i + 1 < str.length) {
				const next = str.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					i++;
					continue;
				}
			}
			result += `${str.slice(last, i)}\\u${point.toString(16)}`;
			last = i + 1;
		}
	}
	result += str.slice(last);
	if (quote === -1) return `"${result}"`;
	if (quote === -2) return `\`${result}\``;
	return `'${result}'`;
}

/** `util.inspect` of a string at the top level, with its defaults
 * (`maxStringLength` 10000, `breakLength` 128): what `%o` and `%O` print. */
function inspectString(value: string): string {
	let trailer = '';
	if (value.length > 10000) {
		const remaining = value.length - 10000;
		value = value.slice(0, 10000);
		trailer = `... ${remaining} more character${remaining > 1 ? 's' : ''}`;
	}
	if (value.length > 16 && value.length > 128 - 4) {
		return (
			splitLines(value)
				.map((line) => quoteString(line))
				.join(' +\n  ') + trailer
		);
	}
	return quoteString(value) + trailer;
}

/** `util.format`'s rendering of a number. */
function formatNumber(n: number): string {
	return Object.is(n, -0) ? '-0' : `${n}`;
}

/** `util.format`'s `%f` of a string. */
function formatFloat(value: string): string {
	return formatNumber(parseFloat(value));
}

/** Split after every `\n`, keeping it (`str.split(/(?<=\n)/)`, without the
 * look-behind). */
function splitLines(value: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) === 10) {
			lines.push(value.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < value.length || lines.length === 0) {
		lines.push(value.slice(start));
	}
	return lines;
}

/** Node's `util.format` over strings only, which is all Hardhat ever passes it. */
function utilFormat(args: string[]): string {
	if (args.length === 0) return '';
	const first = args[0];
	let a = 0;
	let str = '';
	let join = '';
	if (args.length === 1) return first;
	let lastPos = 0;
	for (let i = 0; i < first.length - 1; i++) {
		if (first.charCodeAt(i) !== 37) continue; // '%'
		const next = first.charCodeAt(++i);
		if (a + 1 !== args.length) {
			let temp: string;
			switch (next) {
				case 115: // s
					temp = args[++a];
					break;
				// `%d` / `%i` survive Hardhat's rewrite only when escaped, so these two
				// are unreachable from a decoded call; kept as Node has them.
				case 100: // d
					temp = formatNumber(Number(args[++a]));
					break;
				case 105: // i
					temp = formatNumber(parseInt(args[++a]));
					break;
				case 106: // j
					temp = JSON.stringify(args[++a]);
					break;
				case 79: // O
				case 111: // o
					temp = inspectString(args[++a]);
					break;
				case 102: // f
					temp = formatFloat(args[++a]);
					break;
				case 99: // c
					a += 1;
					temp = '';
					break;
				case 37: // %
					str += first.slice(lastPos, i);
					lastPos = i + 1;
					continue;
				default:
					continue;
			}
			if (lastPos !== i - 1) str += first.slice(lastPos, i - 1);
			str += temp;
			lastPos = i + 1;
		} else if (next === 37) {
			str += first.slice(lastPos, i);
			lastPos = i + 1;
		}
	}
	if (lastPos !== 0) {
		a++;
		join = ' ';
		if (lastPos < first.length) str += first.slice(lastPos);
	}
	while (a < args.length) {
		str += join + args[a];
		join = ' ';
		a++;
	}
	return str;
}

/**
 * The line Hardhat prints for these decoded arguments: a first `string` is a
 * format string (`%s`, `%d`, `%i`, `%o`, `%O`, `%%`, and Node's `%j`, `%f`,
 * `%c`), the rest are appended space separated; integers in full decimal,
 * addresses checksummed, bytes as `0x` hex, booleans as `true` / `false`.
 */
export function formatConsoleArgs(args: readonly ConsoleLogArg[]): string {
	const rendered = args.map(render);
	if (rendered.length > 0) rendered[0] = rewriteIntegerSpecifiers(rendered[0]);
	return utilFormat(rendered);
}
