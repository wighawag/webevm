/**
 * engine-call-recording.ts: the engine seam's CALL RECORDING half
 * (`recordCallsTo` in, `recordedCalls` out, the declared `recordsCalls`
 * capability), driven AT THE SEAM: the default engine is built directly from a
 * VM, exactly as `createNode` builds it, and `connectEngine` is called directly.
 * (Through the node, console logging is ./console-log-node.ts.) The scenario
 * half also runs on `webevm/revm`, held to the same lists
 * (./revm-call-recording.ts). See `docs/adr/0018-console-log-is-observed-never-answered.md`.
 *
 * What this pins:
 *   1. A read and a transaction with `recordCallsTo` return the input of every
 *      CALL, STATICCALL, DELEGATECALL and CALLCODE frame into the address, in
 *      execution order, including a frame inside a sub-call that reverts, and in
 *      a transaction that reverts as a whole; the top-level call when `to` is the
 *      address; never a CREATE; never a frame refused before it runs (a nested
 *      unaffordable value, and a top-level read whose value its sender cannot
 *      afford, which reports an EMPTY list). Depth over 1024 is NOT exercised:
 *      EIP-150's 63/64 rule makes it unreachable without an enormous gas budget,
 *      and the refusal sits in the same `_baseCall` guard as the value one.
 *   2. Without `recordCallsTo`, neither result has a `recordedCalls` key at all.
 *   3. GAS IDENTITY: the same reads and transactions, run on two identically
 *      prepared engines, one recording and one not, give identical return data,
 *      gas, status, logs, bloom and post-state.
 *   4. `connectEngine` with recording required refuses an engine that does not
 *      declare it, naming the engine id and the capability, quotes an engine's
 *      own unavailable reason verbatim, refuses BEFORE `connect` (so the engine is
 *      never bound), passes the default engine, and checks nothing new without
 *      the requirement.
 *
 * The target is the console address the next task will pass, but nothing here
 * depends on it: this layer decodes nothing.
 */
import {createVM, type VM} from '@ethereumjs/vm';
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createBlock, type Block} from '@ethereumjs/block';
import {createFeeMarket1559Tx} from '@ethereumjs/tx';
import {
	Account,
	Address,
	bytesToHex,
	createAddressFromPrivateKey,
	createAddressFromString,
	createContractAddress,
	hexToBytes,
} from '@ethereumjs/util';
import {encodeFunctionData} from 'viem';
import {connectEngine, createEthereumjsEngine} from '../../src/engine.js';
import {OverlayStorageStateManager} from '../../src/state-manager.js';
import type {
	Engine,
	EngineContext,
	ReadCallResult,
	TransactionResult,
} from '../../src/types.js';
import {
	callRecordingProbeAbi,
	callRecordingProbeBytecode,
} from './call-recording-probe.js';

/** The console address (`console.log` in ASCII); any address would do. */
const TARGET = createAddressFromString(
	'0x000000000000000000636F6e736F6c652e6c6f67',
);
const PK = hexToBytes(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const SENDER = createAddressFromPrivateKey(PK);
/** An address holding nothing, for the read whose value it cannot afford. */
const UNFUNDED = createAddressFromString(
	'0x00000000000000000000000000000000000000aa',
);
const COINBASE = createAddressFromString(
	'0x00000000000000000000000000000000000000c0',
);
const SALT = ('0x' + '11'.repeat(32)) as `0x${string}`;
const READ_GAS = 5_000_000n;

interface Rig {
	engine: Engine;
	sm: OverlayStorageStateManager;
	common: Common;
	block: Block;
	nonce: bigint;
}

/**
 * Builds an UNCONNECTED engine for {@link rig} to bind to its own state: how
 * the revm cut runs this same scenario on `webevm/revm`
 * (./revm-call-recording.ts). Absent, the default engine is built from the VM.
 */
export type CallRecordingEngineFactory = () => Promise<Engine>;

/**
 * A fresh engine on a fresh state, the sender funded: what `createNode` builds.
 * The default engine unless `makeEngine` is given, which is connected here to
 * the same state, fork and block, exactly as `connectEngine` would.
 */
async function rig(makeEngine?: CallRecordingEngineFactory): Promise<Rig> {
	const common = new Common({
		chain: {...Mainnet, chainId: 31337, name: 'webevm'},
		hardfork: Hardfork.Osaka,
	});
	const sm = new OverlayStorageStateManager();
	await sm.putAccount(SENDER, new Account(0n, 10n ** 24n));
	const mockBlockchain: any = {
		getBlock: async () => block,
		putBlock: async () => {},
		shallowCopy() {
			return mockBlockchain;
		},
	};
	const vm: VM = await createVM({
		common,
		stateManager: sm,
		blockchain: mockBlockchain,
	});
	const block = createBlock(
		{
			header: {
				number: 1n,
				gasLimit: 30_000_000n,
				baseFeePerGas: 7n,
				timestamp: 1_000n,
				coinbase: COINBASE,
			},
		},
		{common},
	);
	let engine: Engine;
	if (makeEngine === undefined) {
		engine = createEthereumjsEngine({vm, stateManager: sm});
	} else {
		engine = await makeEngine();
		await connectEngine(
			engine,
			{stateManager: sm, common, getBlockHash: () => undefined},
			{recordCalls: true},
		);
	}
	return {
		engine,
		sm,
		common,
		block,
		nonce: 0n,
	};
}

async function transact(
	r: Rig,
	to: Address | undefined,
	data: Uint8Array,
	recordCallsTo?: Address,
): Promise<TransactionResult> {
	const tx = createFeeMarket1559Tx(
		{
			nonce: r.nonce,
			to,
			data,
			gasLimit: 3_000_000n,
			maxFeePerGas: 1_000_000_000n,
			maxPriorityFeePerGas: 1n,
			chainId: 31337n,
		},
		{common: r.common},
	).sign(PK);
	r.nonce += 1n;
	return r.engine.transact({
		tx,
		sender: SENDER,
		block: r.block,
		...(recordCallsTo === undefined ? {} : {recordCallsTo}),
	});
}

function read(
	r: Rig,
	request: {
		from?: Address;
		to?: Address;
		data: Uint8Array;
		value?: bigint;
	},
	recordCallsTo?: Address,
): Promise<ReadCallResult> {
	return r.engine.call({
		from: request.from ?? SENDER,
		to: request.to,
		data: request.data,
		value: request.value ?? 0n,
		gasLimit: READ_GAS,
		block: r.block,
		...(recordCallsTo === undefined ? {} : {recordCallsTo}),
	});
}

const calldata = (
	functionName: 'callEveryKind' | 'callThenRevert' | 'createThenCall',
	args: readonly unknown[],
) =>
	hexToBytes(
		encodeFunctionData({
			abi: callRecordingProbeAbi,
			functionName,
			args: args as any,
		}),
	);

/** `recordedCalls` as hex, or the literal 'ABSENT' when the key is not there. */
function recorded(res: object): string[] | 'ABSENT' {
	if (!('recordedCalls' in res)) return 'ABSENT';
	return (res as {recordedCalls: Uint8Array[]}).recordedCalls.map((b) =>
		bytesToHex(b),
	);
}

/** Every receipt-relevant field of a result, rendered; `recordedCalls` left out. */
function shapeOf(res: ReadCallResult | TransactionResult): string {
	const {recordedCalls: _ignored, ...rest} = res as any;
	return JSON.stringify(rest, (_k, v) =>
		typeof v === 'bigint'
			? `${v}n`
			: v instanceof Uint8Array
				? bytesToHex(v)
				: v,
	);
}

/** The post-state the scenario can touch, rendered. */
async function postState(r: Rig, probe: Address): Promise<string> {
	const accounts = await Promise.all(
		[SENDER, probe, TARGET, COINBASE].map(async (a) => {
			const acc = await r.sm.getAccount(a);
			return acc === undefined ? null : bytesToHex(acc.serialize());
		}),
	);
	const slot0 = bytesToHex(await r.sm.getStorage(probe, new Uint8Array(32)));
	const code = bytesToHex(await r.sm.getCode(probe));
	return JSON.stringify({accounts, slot0, code});
}

/**
 * The WHOLE scenario on one fresh engine, recording or not. Every result is
 * returned in two halves: its receipt-relevant shape (which must not depend on
 * `record`) and what it recorded.
 */
async function scenario(
	record: boolean,
	makeEngine?: CallRecordingEngineFactory,
) {
	const r = await rig(makeEngine);
	const rec = (a: Address) => (record ? a : undefined);

	const deploy = await transact(
		r,
		undefined,
		hexToBytes(callRecordingProbeBytecode),
		rec(TARGET),
	);
	const probe = new Address(deploy.createdAddress!);

	const results: Record<string, ReadCallResult | TransactionResult> = {};
	// Reads.
	results.readEveryKind = await read(
		r,
		{to: probe, data: calldata('callEveryKind', [TARGET.toString()])},
		rec(TARGET),
	);
	results.readTopLevel = await read(
		r,
		{to: TARGET, data: hexToBytes('0xabcd')},
		rec(TARGET),
	);
	results.readUnaffordableTopLevel = await read(
		r,
		{from: UNFUNDED, to: TARGET, data: hexToBytes('0xabcd'), value: 1n},
		rec(TARGET),
	);
	// The CREATE2 address, learnt from a non-recording read (reads are pure, so
	// the recording read below creates at the same address).
	const created = await read(r, {
		to: probe,
		data: calldata('createThenCall', [SALT]),
	});
	const createdAddress = createAddressFromString(
		bytesToHex(created.returnValue.slice(12, 32)),
	);
	results.readCreateThenCall = await read(
		r,
		{to: probe, data: calldata('createThenCall', [SALT])},
		rec(createdAddress),
	);
	// A top-level CREATE, recording calls to the very address it creates.
	const topLevelCreated = createContractAddress(SENDER, r.nonce);
	results.readTopLevelCreate = await read(
		r,
		{data: hexToBytes(callRecordingProbeBytecode)},
		rec(topLevelCreated),
	);
	// Transactions.
	results.txEveryKind = await transact(
		r,
		probe,
		calldata('callEveryKind', [TARGET.toString()]),
		rec(TARGET),
	);
	results.txRevertsWhole = await transact(
		r,
		probe,
		calldata('callThenRevert', [TARGET.toString(), '0x08']),
		rec(TARGET),
	);
	results.txTopLevel = await transact(
		r,
		TARGET,
		hexToBytes('0xbeef'),
		rec(TARGET),
	);
	results.txCreateThenCall = await transact(
		r,
		probe,
		calldata('createThenCall', [SALT]),
		rec(createdAddress),
	);

	const shapes: Record<string, string> = {deploy: shapeOf(deploy)};
	const recordings: Record<string, string[] | 'ABSENT'> = {
		deploy: recorded(deploy),
	};
	for (const [k, v] of Object.entries(results)) {
		shapes[k] = shapeOf(v);
		recordings[k] = recorded(v);
	}
	return {
		engineId: r.engine.id,
		shapes,
		recordings,
		statuses: {
			txEveryKind: (results.txEveryKind as TransactionResult).status,
			txRevertsWhole: (results.txRevertsWhole as TransactionResult).status,
		},
		readUnaffordableTopLevelError: (
			results.readUnaffordableTopLevel as ReadCallResult
		).error,
		readEveryKindError: (results.readEveryKind as ReadCallResult).error,
		txEveryKindLogCount: (results.txEveryKind as TransactionResult).logs.length,
		postState: await postState(r, probe),
	};
}

/** A stub engine: everything the seam requires, plus an optional declaration. */
function stub(id: string, recordsCalls?: Engine['recordsCalls']) {
	let connected = 0;
	const engine: Engine = {
		id,
		...(recordsCalls === undefined ? {} : {recordsCalls}),
		connect() {
			connected += 1;
		},
		async call() {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact() {
			throw new Error('not used');
		},
	};
	return {engine, connectedCount: () => connected};
}

async function outcomeOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return 'CONNECTED';
	} catch (e) {
		return `REFUSED: ${String((e as Error)?.message ?? e)}`;
	}
}

/** A context good enough for a stub (which reads none of it). */
async function stubContext(): Promise<EngineContext> {
	const r = await rig();
	return {
		stateManager: r.sm,
		common: r.common,
		getBlockHash: () => undefined,
	};
}

/**
 * `connectEngine` with and without the requirement, on stubs and on the default
 * engine. Exported for reuse by the revm cut, which adds `webevm/revm` itself.
 */
export async function runConnectEngineRecordingChecks() {
	const out: Record<string, unknown> = {};
	const ctx = await stubContext();

	const silent = stub('silent-stub');
	out.silentRequired = await outcomeOf(
		connectEngine(silent.engine, ctx, {recordCalls: true}),
	);
	out.silentConnectedWhenRefused = silent.connectedCount();

	const explained = stub('explained-stub', {
		unavailable: 'this stub was built without its frame tracer (reason 42)',
	});
	out.explainedRequired = await outcomeOf(
		connectEngine(explained.engine, ctx, {recordCalls: true}),
	);
	out.explainedConnectedWhenRefused = explained.connectedCount();

	// Without the requirement, nothing new is checked: both stubs connect.
	const silent2 = stub('silent-stub');
	out.silentNotRequired = await outcomeOf(connectEngine(silent2.engine, ctx));
	const explained2 = stub('explained-stub', {unavailable: 'whatever'});
	out.explainedNotRequired = await outcomeOf(
		connectEngine(explained2.engine, ctx, {recordCalls: false}),
	);

	// The default engine declares it and passes.
	const r = await rig();
	out.defaultDeclares = r.engine.recordsCalls;
	out.defaultRequired = await outcomeOf(
		connectEngine(r.engine, ctx, {recordCalls: true}),
	);
	return out;
}

/**
 * The recording scenario (what is recorded, and gas identity with recording on
 * and off) on ONE engine: the default one, or the one `makeEngine` builds. The
 * revm cut runs it on both and the spec holds both to the same lists.
 */
export async function runCallRecordingScenarios(
	makeEngine?: CallRecordingEngineFactory,
) {
	const recording = await scenario(true, makeEngine);
	const plain = await scenario(false, makeEngine);
	return {
		engineId: recording.engineId,
		target: TARGET.toString(),
		recording: recording.recordings,
		plain: plain.recordings,
		statuses: recording.statuses,
		readUnaffordableTopLevelError: recording.readUnaffordableTopLevelError,
		readEveryKindError: recording.readEveryKindError ?? null,
		txEveryKindLogCount: recording.txEveryKindLogCount,
		shapesIdentical:
			JSON.stringify(recording.shapes) === JSON.stringify(plain.shapes),
		shapesRecording: recording.shapes,
		shapesPlain: plain.shapes,
		postStateIdentical: recording.postState === plain.postState,
	};
}

export async function runEngineCallRecordingChecks() {
	return {
		...(await runCallRecordingScenarios()),
		connect: await runConnectEngineRecordingChecks(),
	};
}
