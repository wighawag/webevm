/**
 * console-log.spec.ts: `webevm/console-log` decodes and formats every Hardhat
 * and forge-std console call, in real browsers, with no node:
 *   - the selector table is EXACTLY the signatures of the vendored, pinned
 *     `hardhat/console.sol` and forge-std `console.sol` / `console2.sol`
 *     (`test/fixtures/console-log/`), plus each one's legacy `uint` / `int`
 *     alias, minus forge-std's array-taking `console.table` (decided in
 *     `src/console-log-decoder.ts`); every one of them decodes
 *   - every argument type decodes to the value encoded, and the message is
 *     Hardhat's line: `util.format` over the arguments rendered as strings,
 *     after its `%d` / `%i` -> `%s` rewrite, computed HERE with Node's real
 *     `node:util` as the oracle (addresses checksummed, the one deliberate
 *     difference from Hardhat)
 *   - malformed calldata decodes to nothing and throws nothing
 *   - the default sink prints the prefixed message; `onLog` replaces it
 *   - `webevm/console-log` resolves from the BUILT package
 * Calldata is encoded with viem, independently of the module under test.
 * See docs/adr/0018-console-log-is-observed-never-answered.md.
 */
import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {format} from 'node:util';
import {mountHarness} from 'playwright-browser-harness';
import {
	concatHex,
	encodeAbiParameters,
	getAddress,
	keccak256,
	padHex,
	toHex,
	type AbiParameter,
	type Hex,
} from 'viem';
import type {DecodeOutcome, SerializedArg} from './helpers/console-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');
const fixtures = resolve(here, './fixtures/console-log');

// ---- the vendored libraries' signatures ----

/** Every `function name(params) internal pure { _sendLogPayload(abi.encodeWithSignature("sig"...`,
 * as both its DECLARED spelling and its ENCODED one. */
function parseLibrary(file: string): {
	declared: string[];
	encoded: string[];
	sends: number;
} {
	const source = readFileSync(resolve(fixtures, file), 'utf8');
	const re =
		/function\s+(\w+)\s*\(([^)]*)\)\s*internal\s+pure\s*\{\s*_sendLogPayload\(\s*abi\.encodeWithSignature\(\s*"([^"]*)"/g;
	const declared: string[] = [];
	const encoded: string[] = [];
	for (const m of source.matchAll(re)) {
		const types = m[2]
			.split(',')
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => p.split(/\s+/)[0]);
		declared.push(`${m[1]}(${types.join(',')})`);
		encoded.push(m[3]);
	}
	// how many payload-sending functions there are, to check none was missed
	const sends = source.match(/abi\.encodeWithSignature\(/g)?.length ?? 0;
	return {declared, encoded, sends};
}

const hardhat = parseLibrary('hardhat/console.sol');
const forge = parseLibrary('forge-std/console.sol');
// forge-std's console2.sol at the pin is a re-export of console.sol
const console2 = readFileSync(
	resolve(fixtures, 'forge-std/console2.sol'),
	'utf8',
);

const parsed = new Set([
	...hardhat.declared,
	...hardhat.encoded,
	...forge.declared,
	...forge.encoded,
]);
const excluded = [...parsed].filter((s) => s.startsWith('table('));
const canonical = [...parsed].filter((s) => !s.startsWith('table('));
const aliasOf = (s: string) => s.replaceAll('int256', 'int');
const withAliases = new Map<string, string>(); // signature -> canonical
for (const s of canonical) {
	withAliases.set(s, s);
	if (aliasOf(s) !== s) withAliases.set(aliasOf(s), s);
}

const typesOf = (signature: string) =>
	signature
		.slice(signature.indexOf('(') + 1, -1)
		.split(',')
		.filter(Boolean);

const selectorOf = (signature: string): Hex =>
	keccak256(toHex(signature)).slice(0, 10) as Hex;

// ---- encoding (viem) and the oracle (node:util) ----

type Arg = bigint | string | boolean;

const ADDRESSES = [
	'0x52908400098527886e0f7030069857d2e4169ee7',
	'0x8617e340b3d01fa5f11f306f4090fd50e238070d',
	'0xde709f2102306220921060314715629080e2fb77',
	'0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
];
const UINTS = [2n ** 256n - 1n, 2n ** 53n + 1n, 0n, 12345678901234567890123n];
const INTS = [-1n, -(2n ** 255n), 2n ** 255n - 1n, -(2n ** 53n) - 1n];
const STRINGS = ['', 'hello', 'long '.repeat(40), 'ünïcødé ✓'];
const BYTES = ['0x', '0xdeadbeef', `0x${'ab'.repeat(70)}`, '0x00'];

/** A sample value of `type` for argument position `i` of vector `v`. */
function sample(type: string, i: number, v: number): Arg {
	const k = (i + v) % 4;
	if (type === 'uint256') return UINTS[k];
	if (type === 'int256') return INTS[k];
	if (type === 'bool') return k % 2 === 0;
	if (type === 'address') return ADDRESSES[k];
	if (type === 'string') return STRINGS[k];
	if (type === 'bytes') return BYTES[k];
	const n = Number(type.slice(5));
	let hex = '0x';
	for (let j = 0; j < n; j++)
		hex += ((j * 37 + n + k) & 255).toString(16).padStart(2, '0');
	return hex;
}

function encodeCall(signature: string, types: string[], args: Arg[]): Hex {
	const params: AbiParameter[] = types.map((type) => ({type}));
	return concatHex([
		selectorOf(signature),
		encodeAbiParameters(params, args as readonly unknown[]),
	]);
}

/** What the decoder must return for these encoded values. */
function expectedArgs(types: string[], args: Arg[]): SerializedArg[] {
	return args.map((a, i) => {
		if (typeof a === 'bigint') return {bigint: a.toString(10)};
		if (types[i] === 'address') return getAddress(a as string);
		return a;
	});
}

/** Hardhat's line: `util.format` over string renderings, `%d`/`%i` -> `%s`
 * first (Hardhat's own regex), addresses checksummed (ours). */
function hardhatMessage(types: string[], args: Arg[]): string {
	const strs = args.map((a, i) => {
		if (typeof a === 'bigint') return a.toString(10);
		if (typeof a === 'boolean') return a ? 'true' : 'false';
		if (types[i] === 'address') return getAddress(a);
		return a;
	});
	if (strs.length === 0) return '';
	strs[0] = strs[0].replace(/((?<!%)(?:%%)*)(%[di])/g, '$1%s');
	return format(...strs);
}

interface Vector {
	id: string;
	hex: Hex;
	/** `undefined`: must decode to nothing. */
	args?: SerializedArg[];
	message?: string;
}

const vectors: Vector[] = [];
function addCall(
	id: string,
	signature: string,
	args: Arg[],
	canonicalSig = signature,
) {
	const types = typesOf(canonicalSig);
	vectors.push({
		id,
		hex: encodeCall(signature, types, args),
		args: expectedArgs(types, args),
		message: hardhatMessage(types, args),
	});
}

// 1. every signature in the table, canonical and legacy alias
let v = 0;
for (const [signature, canon] of withAliases) {
	const types = typesOf(canon);
	addCall(
		`table:${signature}`,
		signature,
		types.map((t, i) => sample(t, i, v)),
		canon,
	);
	v++;
}

// 2. format strings, each with Hardhat's printed line pinned as a literal too
const A = ADDRESSES[3];
const A_SUM = getAddress(A);
const FORMATS: Array<[string, string, Arg[], string | null]> = [
	['s', 'log(string,uint256)', ['%s', 5n], '5'],
	[
		'd-beyond-2^53',
		'log(string,uint256)',
		['n=%d', 2n ** 64n + 1n],
		'n=18446744073709551617',
	],
	[
		'i-negative',
		'log(string,int256)',
		['n=%i', -(2n ** 200n)],
		`n=${-(2n ** 200n)}`,
	],
	[
		'd-int256-min',
		'log(string,int256)',
		['%d', -(2n ** 255n)],
		`${-(2n ** 255n)}`,
	],
	['o-quote', 'log(string,string)', ['%o', "it's"], `"it's"`],
	['O-plain', 'log(string,string)', ['%O', 'plain'], `'plain'`],
	['o-uint', 'log(string,uint256)', ['%o', 7n], `'7'`],
	['O-both-quotes', 'log(string,string)', ['%O', `a'b"c`], '`a\'b"c`'],
	['o-all-quotes', 'log(string,string)', ['%o', 'a\'b"c`d'], `'a\\'b"c\`d'`],
	['o-escapes', 'log(string,string)', ['%o', 'a\\b\tc\nd\x7f\x01'], null],
	[
		'o-long-multiline',
		'log(string,string)',
		['%o', `${'x'.repeat(80)}\n${'y'.repeat(80)}\n`],
		null,
	],
	['O-truncated', 'log(string,string)', ['%O', 'z'.repeat(10050)], null],
	['percent-alone', 'log(string)', ['100%%'], '100%%'],
	['percent-escape', 'log(string,uint256)', ['100%% of %s', 3n], '100% of 3'],
	['escaped-d', 'log(string,uint256)', ['%%d %d', 9n], '%d 9'],
	['lone-d', 'log(string)', ['%d'], '%s'],
	['missing', 'log(string,uint256)', ['%s and %s', 1n], '1 and %s'],
	[
		'surplus',
		'log(string,uint256,bool,address)',
		['x %s', 1n, true, A],
		`x 1 true ${A_SUM}`,
	],
	['no-specifier', 'log(string,string,string)', ['a', 'b', 'c'], 'a b c'],
	['first-not-string', 'log(uint256,string)', [1n, '%s'], '1 %s'],
	['bool-address', 'log(bool,address)', [false, A], `false ${A_SUM}`],
	['address-s', 'log(string,address)', ['to %s', A], `to ${A_SUM}`],
	['bytes', 'log(bytes)', ['0x00ff'], '0x00ff'],
	[
		'bytes32',
		'logBytes32(bytes32)',
		[`0x${'01'.repeat(31)}ff`],
		`0x${'01'.repeat(31)}ff`,
	],
	['bytes1', 'log(bytes1)', ['0x7f'], '0x7f'],
	['j', 'log(string,string)', ['%j', 'q"x'], '"q\\"x"'],
	['f', 'log(string,string)', ['%f', '1.50'], '1.5'],
	['c', 'log(string,string)', ['a%cb', 'color: red'], 'ab'],
	['unknown-specifier', 'log(string,string)', ['%x', 'y'], '%x y'],
	[
		'four-mixed',
		'log(uint256,string,bool,address)',
		[2n ** 255n, 'mid', true, A],
		`${2n ** 255n} mid true ${A_SUM}`,
	],
	['empty', 'log()', [], ''],
	[
		'legacy-uint-format',
		'log(string,uint)',
		['v=%d', 2n ** 70n],
		`v=${2n ** 70n}`,
	],
];
/** `[name, oracle's message, pinned literal]`, asserted in the test. */
const literals: Array<[string, string | undefined, string]> = [];
for (const [name, signature, args, literal] of FORMATS) {
	const canon = signature
		.replace(/\buint\b/g, 'uint256')
		.replace(/\bint\b/g, 'int256');
	addCall(`format:${name}`, signature, args, canon);
	if (literal !== null)
		literals.push([name, vectors[vectors.length - 1].message, literal]);
}

// 3. malformed
const word = (n: bigint | number) => padHex(toHex(n), {size: 32});
const SEL = (s: string) => selectorOf(s);
const MALFORMED: Array<[string, Hex]> = [
	['empty', '0x'],
	['one-byte', '0x41'],
	['three-bytes', SEL('log(string)').slice(0, 8) as Hex],
	['unknown-selector', concatHex(['0xdeadbeef', word(1)])],
	[
		'truncated-head',
		concatHex([SEL('log(uint256,uint256)'), word(1), '0x0000000000000000']),
	],
	['head-only-one-word', concatHex([SEL('log(string,uint256)'), word(64)])],
	['string-offset-past-end', concatHex([SEL('log(string)'), word(64)])],
	[
		'string-offset-huge',
		concatHex([SEL('log(string)'), word(2n ** 255n), word(0)]),
	],
	[
		'string-length-huge',
		concatHex([SEL('log(string)'), word(32), word(2n ** 255n)]),
	],
	[
		'string-length-past-end',
		concatHex([SEL('log(string)'), word(32), word(10), '0x68656c6c6f']),
	],
	[
		'bytes-length-past-end',
		concatHex([SEL('log(bytes)'), word(32), word(33), word(0)]),
	],
	['logUint-no-data', SEL('logUint(uint256)')],
	[
		'console-table-excluded',
		encodeCall('table(uint256[])', ['uint256[]'], [[1n, 2n] as never]),
	],
];
for (const [name, hex] of MALFORMED)
	vectors.push({id: `malformed:${name}`, hex});
// lax where Hardhat is: trailing bytes after a well-formed payload still decode
vectors.push({
	id: 'lax:trailing-bytes',
	hex: concatHex([encodeCall('log(uint256)', ['uint256'], [7n]), '0xffff']),
	args: [{bigint: '7'}],
	message: '7',
});

test('webevm/console-log decodes and formats every console call', async ({
	page,
}) => {
	// ---- the fixtures are what the table is checked against ----
	expect(hardhat.encoded.length).toBe(hardhat.sends);
	expect(forge.encoded.length).toBe(forge.sends);
	// the oracle agrees with the literals pinned beside the format cases
	for (const [name, oracle, literal] of literals)
		expect(oracle, name).toBe(literal);
	expect(console2).toMatch(
		/import \{console as console2\} from "\.\/console\.sol";/,
	);
	expect(hardhat.encoded.length).toBeGreaterThan(300);
	expect(forge.encoded.length).toBeGreaterThan(300);
	// the exclusion is exactly forge-std's twelve array-taking `table`s
	expect(excluded.length).toBe(12);
	for (const s of excluded) expect(s).toContain('[]');
	// and everything kept uses only the types the decoder implements
	const supported =
		/^(u?int256|bool|address|string|bytes([1-9]|[12][0-9]|3[0-2])?)$/;
	for (const s of canonical) {
		for (const t of typesOf(s)) expect(t, s).toMatch(supported);
	}
	// spot-check the legacy spellings the spec names
	for (const s of [
		'log(uint)',
		'log(uint,string)',
		'logUint(uint)',
		'log(int)',
		'log(string,int)',
	]) {
		expect(withAliases.has(s), s).toBe(true);
	}
	// no two signatures share a selector, so the table has one entry each
	const selectors = new Set([...withAliases.keys()].map(selectorOf));
	expect(selectors.size).toBe(withAliases.size);
	expect(selectors.has('0xdeadbeef')).toBe(false);

	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({
		phase: 'once',
		params: {mode: 'console-log', vectors: vectors.map((x) => [x.id, x.hex])},
	});
	expect(r.errors).toEqual([]);
	const c = r.results.consoleLog as {
		decoded: Record<string, DecodeOutcome>;
		signatures: string[];
		sink: Record<string, unknown>;
	};

	// ---- the table is exactly the vendored signatures plus their aliases ----
	expect([...c.signatures].sort()).toEqual([...withAliases.keys()].sort());

	// ---- every vector ----
	let failures = 0;
	for (const x of vectors) {
		const got = c.decoded[x.id];
		expect(got.threw, `${x.id} threw`).toBeUndefined();
		const want =
			x.args === undefined ? null : {args: x.args, message: x.message};
		if (JSON.stringify(got.decoded) !== JSON.stringify(want)) failures++;
		expect(got.decoded, x.id).toEqual(want);
	}
	expect(failures).toBe(0);
	console.log(
		`[console-log] ${vectors.length} vectors, ${c.signatures.length} signatures`,
	);

	// ---- the sink ----
	expect(c.sink.defaultPrinted).toEqual([
		['[webevm console.log]', 'balance 42'],
	]);
	expect(c.sink.onLogPrinted).toEqual([]);
	expect(c.sink.onLogReceivedCount).toBe(1);
	expect(c.sink.onLogReceivedSameEntry).toBe(true);
});

test('webevm/console-log resolves from the built package', async () => {
	// A self-reference through the package's `exports` map, i.e. `dist/`.
	const mod = await import('webevm/console-log');
	const log = mod.consoleLog();
	const input = Uint8Array.from(
		Buffer.from(
			encodeCall(
				'log(string,uint256)',
				['string', 'uint256'],
				['%s wei', 2n ** 80n],
			).slice(2),
			'hex',
		),
	);
	expect(log.decode(input)).toEqual({
		args: ['%s wei', 2n ** 80n],
		message: `${2n ** 80n} wei`,
	});
	// the default entry does not carry it
	const core = await import('webevm');
	expect('consoleLog' in core).toBe(false);
});
