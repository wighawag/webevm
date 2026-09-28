/**
 * statetest.ts — TRACK B conformance: run real `ethereum/tests` GeneralStateTests
 * against the slim node's opt-in `stateMode:'trie'` and assert the post-state
 * Merkle-Patricia ROOT (and `keccak(RLP(logs))`) match the fixture's expected
 * values. This is the STRONGEST spec-conformance signal — it verifies exactly
 * what the canonical fixtures verify — and it is only possible because trie mode
 * produces a real state root (the default `'none'` mode has none by design).
 *
 * How a fixture maps onto the node (no full retesteth machinery needed):
 *   - `pre`  -> createNode({initialState}) (full balance/nonce/code/storage),
 *   - `env`  -> createNode({blockEnv}) (coinbase/baseFee/number/timestamp/randao;
 *               the coinbase is credited fees, so it affects the root),
 *   - each Cancun `post[]` case carries `txbytes` (the exact signed raw tx for
 *     that data/gas/value index) -> eth_sendRawTransaction,
 *   - then node.getStateRoot() must equal the case `hash`, and keccak(RLP(logs))
 *     must equal the case `logs`.
 *
 * We target the Cancun fork (the node's hardfork). Fixtures are vendored under
 * tests/fixtures (see tests/fixtures/README.md for the pinned source tag).
 */
import {hexToBytes, bytesToHex, type PrefixedHexString} from '@ethereumjs/util';
import {keccak_256} from '@noble/hashes/sha3.js';
import {createNode} from '../../src/index.js';
import type {GenesisAccount, BlockEnv} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';

const FORK = 'Cancun';

// --- minimal RLP encoder (just enough for the logs list: bytes + nested lists).
// Kept self-contained to avoid a hoisting-sensitive @ethereumjs/rlp import. ---
type RlpInput = Uint8Array | RlpInput[];
function rlpLength(len: number, offset: number): Uint8Array {
	if (len < 56) return Uint8Array.from([offset + len]);
	const hexLen = len.toString(16);
	const lenBytes = hexToBytes(
		`0x${hexLen.length % 2 ? '0' + hexLen : hexLen}` as PrefixedHexString,
	);
	return Uint8Array.from([offset + 55 + lenBytes.length, ...lenBytes]);
}
function concat(arrs: Uint8Array[]): Uint8Array {
	const total = arrs.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const a of arrs) {
		out.set(a, o);
		o += a.length;
	}
	return out;
}
function rlpEncode(input: RlpInput): Uint8Array {
	if (input instanceof Uint8Array) {
		if (input.length === 1 && input[0] < 0x80) return input;
		return concat([rlpLength(input.length, 0x80), input]);
	}
	const payload = concat(input.map(rlpEncode));
	return concat([rlpLength(payload.length, 0xc0), payload]);
}

interface FixtureAccount {
	balance: string;
	nonce: string;
	code: string;
	storage: Record<string, string>;
}
interface FixtureCase {
	hash: string;
	logs: string;
	indexes: {data: number; gas: number; value: number};
	txbytes: string;
}
interface StateTest {
	config: {chainid: string};
	env: Record<string, string>;
	pre: Record<string, FixtureAccount>;
	post: Record<string, FixtureCase[]>;
}

function logsHash(
	logs: {address: string; topics: string[]; data: string}[],
): string {
	const items: RlpInput = logs.map((l) => [
		hexToBytes(l.address as PrefixedHexString),
		l.topics.map((t) => hexToBytes(t as PrefixedHexString)),
		hexToBytes(l.data as PrefixedHexString),
	]);
	return bytesToHex(keccak_256(rlpEncode(items))) as string;
}

function toInitialState(
	pre: Record<string, FixtureAccount>,
): Record<string, GenesisAccount> {
	const out: Record<string, GenesisAccount> = {};
	for (const [addr, a] of Object.entries(pre)) {
		out[addr] = {
			balance: BigInt(a.balance),
			nonce: BigInt(a.nonce),
			code: a.code,
			storage: a.storage,
		};
	}
	return out;
}

function toBlockEnv(env: Record<string, string>): BlockEnv {
	return {
		coinbase: env.currentCoinbase,
		baseFeePerGas:
			env.currentBaseFee != null ? BigInt(env.currentBaseFee) : undefined,
		number: BigInt(env.currentNumber),
		timestamp: BigInt(env.currentTimestamp),
		gasLimit: BigInt(env.currentGasLimit),
		prevRandao: env.currentRandom,
	};
}

export interface CaseResult {
	test: string;
	caseIndex: number;
	indexes: {data: number; gas: number; value: number};
	rootMatch: boolean;
	logsMatch: boolean;
	gotRoot: string;
	wantRoot: string;
	gotLogs: string;
	wantLogs: string;
	txStatus: string | null;
	/** The engine the case's node ran on (`node.engine.id`). */
	engine: string;
	error?: string;
}

/** Run every Cancun case of one named state test (a fixture may hold several). */
export async function runStateTestFixture(
	name: string,
	fixture: Record<string, StateTest>,
	makeEngine?: EngineFactory,
): Promise<CaseResult[]> {
	const results: CaseResult[] = [];
	for (const [testName, test] of Object.entries(fixture)) {
		const cases = test.post[FORK];
		if (!cases) continue; // fixture doesn't cover Cancun
		const initialState = toInitialState(test.pre);
		const blockEnv = toBlockEnv(test.env);
		const chainId = Number(test.config?.chainid ?? '0x1');

		for (let i = 0; i < cases.length; i++) {
			const c = cases[i];
			const r: CaseResult = {
				test: `${name}:${testName}`,
				caseIndex: i,
				indexes: c.indexes,
				rootMatch: false,
				logsMatch: false,
				gotRoot: '',
				wantRoot: c.hash,
				gotLogs: '',
				wantLogs: c.logs,
				txStatus: null,
				engine: '',
			};
			// Fresh node per case (each starts from the same `pre`).
			const node = await createNode({
				chainId,
				stateMode: 'trie',
				miningConfig: {type: 'auto'},
				initialState,
				blockEnv,
				// One engine per node (an engine binds to exactly one): with revm
				// installed the same roots must come out, since the trie is derived
				// from the flat state whichever engine wrote it.
				engine: makeEngine ? await makeEngine() : undefined,
			});
			r.engine = node.engine.id;
			try {
				const rcpt = (await node.request({
					method: 'eth_sendRawTransactionSync',
					params: [c.txbytes],
				})) as any;
				r.txStatus = rcpt?.status ?? null;
				r.gotRoot = await node.getStateRoot();
				r.gotLogs = logsHash(rcpt?.logs ?? []);
				r.rootMatch = r.gotRoot.toLowerCase() === c.hash.toLowerCase();
				r.logsMatch = r.gotLogs.toLowerCase() === c.logs.toLowerCase();
			} catch (e: any) {
				r.error = String(e?.message ?? e);
			} finally {
				await node.dispose();
			}
			results.push(r);
		}
	}
	return results;
}

/** Run a batch of named fixtures, returning a flat case-result list + a summary. */
export async function runStateTests(
	fixtures: {name: string; json: Record<string, StateTest>}[],
	makeEngine?: EngineFactory,
): Promise<{
	/** Every engine a case ran on: exactly one, the one under test. */
	engines: string[];
	cases: CaseResult[];
	total: number;
	passed: number;
	failed: number;
}> {
	const cases: CaseResult[] = [];
	for (const f of fixtures) {
		cases.push(...(await runStateTestFixture(f.name, f.json, makeEngine)));
	}

	const passed = cases.filter(
		(c) => c.rootMatch && c.logsMatch && !c.error,
	).length;
	return {
		engines: [...new Set(cases.map((c) => c.engine))],
		cases,
		total: cases.length,
		passed,
		failed: cases.length - passed,
	};
}
