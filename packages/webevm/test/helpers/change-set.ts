/**
 * change-set.ts: the per-block CHANGE SET (the open record of prior values, in
 * `src/state-manager.ts`) holds, for every key a block changed, the value that key
 * had at the end of the block before. Proved by a DIFFERENTIAL through the node's
 * public surface, on whichever engine the caller installs.
 *
 * ## The oracle is `dumpState`, not the state manager
 *
 * Full state is snapshotted with `dumpState` (accounts, code, storage: everything
 * the node has) after each mined block. The difference between two consecutive
 * snapshots is what the block changed, and the record the node took for the block
 * must (a) name every key in that difference, with (b) the value from the EARLIER
 * snapshot. (b) is also checked for every key the record names that did NOT
 * change: a key written and restored may be in the record (a superset is allowed),
 * but its recorded value must still be the earlier one, or the record lies about a
 * key a later reader will trust.
 *
 * The record itself is read through `changeSetsForTests`, the test-only accessor
 * `src/node.ts` names as such. Everything the record is held against comes
 * through the public surface.
 *
 * ## The chain
 *
 * The shapes of ./post-state.ts (creation, nested creation, nested frames,
 * EIP-161 removal, `SELFDESTRUCT` in both EIP-6780 halves), plus a plain transfer,
 * a REVERTED transaction, a creation at an address that already held storage,
 * and all five `evm_set*` cheats between blocks, with `eth_call` /
 * `eth_estimateGas` / state overrides / `eth_fillTransaction` interleaved before
 * every block. Each block holds one transaction (auto mining), so a failure
 * names the shape.
 *
 * ENGINE-PARAMETERISED: `test/change-set.spec.ts` runs it on the default engine
 * through ./cut.ts, `test/revm-change-set.spec.ts` on revm through ./cut-revm.ts,
 * and both hold the report to ONE contract (`test/change-set-expected.ts`).
 */
import {
	changeSetsForTests,
	createNodeWithInternals,
	type ChangeSetProbe,
} from '../../src/node.js';
import {createMemoryPersistence} from '../../src/persistence.js';
import {
	OverlayStorageStateManager,
	type ChangeSet,
} from '../../src/state-manager.js';
import {assertStateShape} from '../../src/revm-state-store.js';
import {unpackAddressKey, unpackSlotKey} from '../../src/storage-keys.js';
import type {NodeOptions, SerializedState, SlimNode} from '../../src/types.js';
import {Account, bytesToHex, createAddressFromString} from '@ethereumjs/util';
import {getContractAddress, keccak256} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {
	BASE_FEE,
	CHAIN_ID,
	COINBASE,
	CREATE_INIT,
	EMPTY_ACCOUNT,
	INNER_ADDR,
	INNER_CODE,
	NESTED_CREATE_INIT,
	OUTER_ADDR,
	OUTER_CODE,
	PK,
	SELFDESTRUCT_INIT,
	SURVIVOR_INIT,
	TIMESTAMP,
} from './post-state.js';

const account = privateKeyToAccount(PK);
const SENDER = account.address;
const GENESIS_BALANCE = 10n ** 24n;
const RECIPIENT = '0x0000000000000000000000000000000000007777';
/** Holds storage from genesis (`initialState`), so the baseline is non-trivial. */
const GENESIS_CONTRACT = '0x0000000000000000000000000000000000008888';
/** `PUSH1 1, PUSH1 1, SSTORE, PUSH1 0, PUSH1 0, REVERT`: writes slot 1, then reverts. */
const REVERTER = '0x0000000000000000000000000000000000006666';
const REVERTER_CODE = '0x600160015560006000fd';
/** An address nothing touches except state overrides, which must leave no trace. */
const OVERRIDDEN = '0x000000000000000000000000000000000000f00d';
const PROBE_CODE = '0x6000546000526001546020524760405260606000f3';

const word = (n: number | bigint) =>
	'0x' + BigInt(n).toString(16).padStart(64, '0');

// ------------------------------------------------------------ the views ----

/**
 * A storage value as a comparable string: `null` for zero. The representation
 * stores a zeroed slot as an EMPTY value (and a dump serialises it as `0x`), while
 * an unset slot is simply absent; both read as zero through every public method, so
 * they are one value here.
 */
function slotValue(v: Uint8Array | string | undefined): string | null {
	if (v === undefined) return null;
	const hex = typeof v === 'string' ? v : bytesToHex(v);
	const n = hex === '0x' ? 0n : BigInt(hex);
	return n === 0n ? null : '0x' + n.toString(16);
}

/** Code as a comparable string: `null` for none (empty code is no code). */
function codeValue(v: Uint8Array | string | undefined): string | null {
	if (v === undefined) return null;
	const hex = typeof v === 'string' ? v : bytesToHex(v);
	return hex === '0x' ? null : hex.toLowerCase();
}

/** The whole state as three flat maps: account RLP, code, and `addr:slot` values. */
interface Snapshot {
	accounts: Map<string, string>;
	code: Map<string, string>;
	storage: Map<string, string>;
}

function snapshotOf(dump: SerializedState): Snapshot {
	const accounts = new Map(Object.entries(dump.accounts));
	const code = new Map<string, string>();
	for (const [a, c] of Object.entries(dump.code)) {
		const v = codeValue(c);
		if (v !== null) code.set(a, v);
	}
	const storage = new Map<string, string>();
	for (const [a, slots] of Object.entries(dump.storage))
		for (const [s, val] of Object.entries(slots)) {
			const v = slotValue(val);
			if (v !== null) storage.set(`${a}:${s}`, v);
		}
	return {accounts, code, storage};
}

async function snapshot(node: SlimNode): Promise<Snapshot> {
	return snapshotOf(await node.dumpState());
}

/** A recorded account, readable in a report. */
export interface RecordedAccount {
	rlp: string;
	balance: string;
	nonce: string;
	codeHash: string;
}

/** A change set in the same vocabulary as {@link Snapshot}, plain JSON. */
export interface ChangeSetJson {
	accounts: Record<string, RecordedAccount | null>;
	code: Record<string, string | null>;
	storage: Record<string, string | null>;
	storageCleared: string[];
}

function accountJson(a: Account | undefined): RecordedAccount | null {
	if (a === undefined) return null;
	return {
		rlp: bytesToHex(a.serialize()),
		balance: '0x' + a.balance.toString(16),
		nonce: '0x' + a.nonce.toString(16),
		codeHash: bytesToHex(a.codeHash),
	};
}

export function changeSetJson(cs: ChangeSet | undefined): ChangeSetJson | null {
	if (cs === undefined) return null;
	const out: ChangeSetJson = {
		accounts: {},
		code: {},
		storage: {},
		storageCleared: [...cs.storageCleared].map(unpackAddressKey).sort(),
	};
	for (const [k, a] of cs.accounts) out.accounts[k] = accountJson(a);
	for (const [k, c] of cs.code) out.code[k] = codeValue(c);
	for (const [a, slots] of cs.storage)
		for (const [s, v] of slots)
			out.storage[`${unpackAddressKey(a)}:${unpackSlotKey(s)}`] = slotValue(v);
	return out;
}

function isEmptyJson(cs: ChangeSetJson | null): boolean {
	return (
		cs !== null &&
		Object.keys(cs.accounts).length === 0 &&
		Object.keys(cs.code).length === 0 &&
		Object.keys(cs.storage).length === 0 &&
		cs.storageCleared.length === 0
	);
}

/**
 * THE INVARIANT, checked. Returns every violation as a readable line; empty
 * means the record is exactly what a block's undo log must be (or a superset of
 * it with honest values).
 */
function violations(
	prev: Snapshot,
	now: Snapshot,
	record: ChangeSetJson | null,
): string[] {
	if (record === null) return ['no record was taken for the block'];
	const out: string[] = [];
	const check = (
		kind: 'accounts' | 'code' | 'storage',
		recorded: (k: string) => string | null | undefined,
		keys: string[],
	) => {
		const before = prev[kind];
		const after = now[kind];
		for (const k of new Set([...before.keys(), ...after.keys()])) {
			const p = before.get(k) ?? null;
			const n = after.get(k) ?? null;
			if (p === n) continue;
			const r = recorded(k);
			if (r === undefined)
				out.push(`${kind} ${k}: changed ${p} -> ${n}, NOT in the record`);
			else if (r !== p)
				out.push(`${kind} ${k}: changed ${p} -> ${n}, record says ${r}`);
		}
		// The superset half: a recorded key that did not change must still carry
		// the value it had at the end of the previous block.
		for (const k of keys) {
			const p = before.get(k) ?? null;
			const r = recorded(k);
			if (r !== p)
				out.push(`${kind} ${k}: record says ${r}, previous was ${p}`);
		}
	};
	check(
		'accounts',
		(k) =>
			k in record.accounts ? (record.accounts[k]?.rlp ?? null) : undefined,
		Object.keys(record.accounts),
	);
	check(
		'code',
		(k) => (k in record.code ? record.code[k] : undefined),
		Object.keys(record.code),
	);
	check(
		'storage',
		(k) => (k in record.storage ? record.storage[k] : undefined),
		Object.keys(record.storage),
	);
	return out;
}

// ------------------------------------------------------------- helpers ----

async function recordingNode(
	makeEngine: EngineFactory | undefined,
	extra: NodeOptions = {},
): Promise<SlimNode> {
	return createNodeWithInternals(
		{
			chainId: CHAIN_ID,
			miningConfig: {type: 'auto'},
			initialBalances: {[SENDER]: GENESIS_BALANCE},
			initialState: {
				[GENESIS_CONTRACT]: {
					balance: 3n,
					nonce: 1n,
					code: '0x6001',
					storage: {'0x1': word(0x11), '0x2': word(0x22)},
				},
			},
			blockEnv: {coinbase: COINBASE, timestamp: TIMESTAMP},
			engine: makeEngine ? await makeEngine() : undefined,
			...extra,
		},
		{recordChangeSets: true},
	);
}

function probe(node: SlimNode): {
	recording: boolean;
	headBlock: ChangeSetJson | null;
	open: ChangeSetJson | null;
} {
	const p: ChangeSetProbe = changeSetsForTests(node);
	return {
		recording: p.recording,
		headBlock: changeSetJson(p.headBlock),
		open: changeSetJson(p.open),
	};
}

async function send(
	node: SlimNode,
	nonce: number,
	tx: {to?: string; data?: string; value?: bigint; gas: bigint},
): Promise<any> {
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: tx.gas,
		maxFeePerGas: BASE_FEE,
		maxPriorityFeePerGas: 0n,
		...(tx.to !== undefined ? {to: tx.to as `0x${string}`} : {}),
		...(tx.data !== undefined ? {data: tx.data as `0x${string}`} : {}),
		...(tx.value !== undefined ? {value: tx.value} : {}),
	} as any);
	return node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
}

/**
 * Every PURE READ the node has, each of which executes and so opens (and
 * reverts) checkpoint levels that WRITE: `eth_call` into nested frames that
 * store, `eth_estimateGas`'s search, state overrides of every kind, a call that
 * reverts, `eth_fillTransaction`'s estimate. None of it may reach the record.
 */
async function pureReads(node: SlimNode): Promise<void> {
	const call = {from: SENDER, to: OUTER_ADDR, data: '0x'};
	const override = {
		[OVERRIDDEN]: {
			balance: '0x3e8',
			nonce: '0x5',
			code: PROBE_CODE,
			state: {[word(0)]: word(7)},
		},
		[OUTER_ADDR]: {stateDiff: {[word(0)]: word(9)}},
	};
	await node.request({method: 'eth_call', params: [call, 'latest']});
	await node.request({method: 'eth_estimateGas', params: [call, 'latest']});
	await node.request({
		method: 'eth_call',
		params: [{to: OVERRIDDEN, data: '0x'}, 'latest', override],
	});
	await node.request({
		method: 'eth_estimateGas',
		params: [call, 'latest', override],
	});
	await node
		.request({method: 'eth_call', params: [{to: REVERTER}, 'latest']})
		.catch(() => undefined);
	await node.request({method: 'eth_fillTransaction', params: [call]});
}

// -------------------------------------------------------- the differential --

export interface BlockCheck {
	label: string;
	blockNumber: number;
	/** Invariant violations for this block; empty = the record is right. */
	violations: string[];
	/** How many keys changed (so an assertion can see the block was not empty). */
	changedKeys: number;
	/** The open record right after the block was mined: must be empty. */
	openEmptyAfterMining: boolean;
}

async function runDifferential(makeEngine: EngineFactory | undefined) {
	const node = await recordingNode(makeEngine);
	const blocks: BlockCheck[] = [];
	const records: Record<string, ChangeSetJson | null> = {};
	const receipts: Record<string, string> = {};

	let prev = await snapshot(node);
	const afterBlock = async (label: string, blockNumber: number) => {
		const now = await snapshot(node);
		const p = probe(node);
		let changed = 0;
		for (const kind of ['accounts', 'code', 'storage'] as const)
			for (const k of new Set([...prev[kind].keys(), ...now[kind].keys()]))
				if ((prev[kind].get(k) ?? null) !== (now[kind].get(k) ?? null))
					changed++;
		blocks.push({
			label,
			blockNumber,
			violations: violations(prev, now, p.headBlock),
			changedKeys: changed,
			openEmptyAfterMining: isEmptyJson(p.open),
		});
		records[label] = p.headBlock;
		prev = now;
	};
	const mined = async (label: string, r: any) => {
		receipts[label] = String(r.status);
		await afterBlock(label, Number(BigInt(r.blockNumber)));
		return r;
	};

	// The creations land at addresses a cheat can pre-load with storage.
	const creationAddr = getContractAddress({from: SENDER, nonce: 1n});
	const selfdestructAddr = getContractAddress({from: SENDER, nonce: 6n});

	// ---- block 1: the fixtures, placed by cheats, then a plain transfer -----
	await node.request({method: 'evm_setCode', params: [INNER_ADDR, INNER_CODE]});
	await node.request({method: 'evm_setCode', params: [OUTER_ADDR, OUTER_CODE]});
	await node.request({
		method: 'evm_setCode',
		params: [REVERTER, REVERTER_CODE],
	});
	await node.request({
		method: 'evm_setBalance',
		params: [EMPTY_ACCOUNT, '0x0'],
	});
	await node.request({
		method: 'evm_setNonce',
		params: [GENESIS_CONTRACT, '0x9'],
	});
	await pureReads(node);
	await mined(
		'transfer',
		await send(node, 0, {to: RECIPIENT, value: 12345n, gas: 21000n}),
	);

	// ---- block 2: CREATION at an address that already holds storage -------
	await node.request({
		method: 'evm_setStorageAt',
		params: [creationAddr, '0x0', word(1)],
	});
	await node.request({
		method: 'evm_setStorageAt',
		params: [creationAddr, '0x5', word(7)],
	});
	await pureReads(node);
	const created = await mined(
		'creationOverStorage',
		await send(node, 1, {data: `0x${CREATE_INIT}`, gas: 200_000n}),
	);
	const creationCleared =
		records.creationOverStorage?.storageCleared.includes(
			creationAddr.toLowerCase(),
		) ?? false;

	// ---- block 3: NESTED CREATION ------------------------------------------
	await pureReads(node);
	await mined(
		'nestedCreation',
		await send(node, 2, {data: `0x${NESTED_CREATE_INIT}`, gas: 300_000n}),
	);

	// ---- block 4: storage through NESTED CALL FRAMES -----------------------
	await pureReads(node);
	await mined(
		'nestedFrames',
		await send(node, 3, {to: OUTER_ADDR, data: '0x', gas: 200_000n}),
	);

	// ---- block 5: a REVERTED transaction -----------------------------------
	await pureReads(node);
	await mined(
		'revertedTx',
		await send(node, 4, {to: REVERTER, data: '0x', gas: 100_000n}),
	);
	const revertedSlotKeys = Object.keys(
		records.revertedTx?.storage ?? {},
	).filter((k) => k.startsWith(REVERTER.toLowerCase()));

	// ---- block 6: EIP-161 removal of an empty account ----------------------
	await pureReads(node);
	await mined(
		'eip161Removal',
		await send(node, 5, {to: EMPTY_ACCOUNT, value: 0n, gas: 100_000n}),
	);

	// ---- block 7: SELFDESTRUCT (same-transaction creation), over storage ---
	await node.request({
		method: 'evm_setStorageAt',
		params: [selfdestructAddr, '0x3', word(9)],
	});
	await pureReads(node);
	await mined(
		'selfdestruct',
		await send(node, 6, {
			data: `0x${SELFDESTRUCT_INIT}`,
			value: 1000n,
			gas: 200_000n,
		}),
	);

	// ---- block 8: ALL FIVE CHEATS between blocks, then an EMPTY block ------
	await node.request({method: 'evm_setBalance', params: [RECIPIENT, '0x1']});
	await node.request({method: 'evm_setNonce', params: [RECIPIENT, '0x4']});
	await pureReads(node);
	await node.request({method: 'evm_setCode', params: [OUTER_ADDR, '0x6002']});
	await node.request({
		method: 'evm_setStorageAt',
		params: [OUTER_ADDR, '0x0', word(0x55)],
	});
	await node.request({
		method: 'evm_setAccount',
		params: [
			INNER_ADDR,
			{
				balance: '0x99',
				nonce: '0x2',
				code: '0x6003',
				storage: {'0x7': word(0), '0x8': word(0x88)},
			},
		],
	});
	await pureReads(node);
	const empty = await node.mine();
	await afterBlock('cheatsThenEmptyBlock', empty.blockNumber);

	// ---- blocks 9-10: EIP-6780's other half (deploy, then SELFDESTRUCT) ----
	await node.request({method: 'evm_setCode', params: [OUTER_ADDR, OUTER_CODE]});
	await pureReads(node);
	const survivor = await mined(
		'survivorDeploy',
		await send(node, 7, {
			data: `0x${SURVIVOR_INIT}`,
			value: 777n,
			gas: 200_000n,
		}),
	);
	await pureReads(node);
	await mined(
		'survivorKill',
		await send(node, 8, {
			to: survivor.contractAddress,
			data: '0x',
			gas: 200_000n,
		}),
	);

	// ---- and pure reads with nothing else: the open record stays EMPTY -----
	await pureReads(node);
	const openAfterPureReads = probe(node).open;

	const dump = await node.dumpState();
	await node.dispose();
	return {
		engineId: node.engine.id,
		blocks,
		receipts,
		createdAddress: String(created.contractAddress).toLowerCase(),
		expectedCreationAddress: creationAddr.toLowerCase(),
		creationCleared,
		selfdestructCleared:
			records.selfdestruct?.storageCleared.includes(
				selfdestructAddr.toLowerCase(),
			) ?? false,
		revertedSlotKeys,
		overriddenInAnyRecord: Object.values(records).some(
			(r) =>
				r !== null &&
				(OVERRIDDEN in r.accounts ||
					OVERRIDDEN in r.code ||
					Object.keys(r.storage).some((k) => k.startsWith(OVERRIDDEN))),
		),
		openAfterPureReads,
		openEmptyAfterPureReads: isEmptyJson(openAfterPureReads),
		dump,
	};
}

// ----------------------------------------------- the cheats, one by one ----

/**
 * EACH `evm_set*` CHEAT, at the BOTTOM level (no checkpoint is open between
 * blocks), records the value its key had BEFORE the cheat. This is the in-place
 * mutation case: `mutateAccount` (and upstream `modifyAccountFields`, reached from
 * `putCode`) edits the object `getAccount` returned and then writes it back, so a
 * record that read the prior at write time from the SAME object would hold the
 * NEW value. Asserted per cheat, on the open record right after it, and on the
 * block that takes it.
 */
async function runCheats(makeEngine: EngineFactory | undefined) {
	const X = '0x000000000000000000000000000000000000abcd';
	const FRESH = '0x000000000000000000000000000000000000abce';
	const node = await recordingNode(makeEngine, {
		initialState: {
			[X]: {
				balance: 5n,
				nonce: 3n,
				code: '0x6001',
				storage: {'0x1': word(9)},
			},
		},
	});
	const out: Record<string, any> = {
		codeHash: {
			c1: keccak256('0x6001'),
			c2: keccak256('0x6002'),
			c3: keccak256('0x6003'),
		},
	};
	const step = async (name: string, method: string, params: unknown[]) => {
		await node.request({method, params});
		const open = probe(node).open;
		await node.mine();
		const head = probe(node).headBlock;
		out[name] = {
			open,
			sameInBlock: JSON.stringify(open) === JSON.stringify(head),
		};
	};
	await step('setBalance', 'evm_setBalance', [X, '0x64']);
	await step('setBalanceFresh', 'evm_setBalance', [FRESH, '0x1']);
	await step('setNonce', 'evm_setNonce', [X, '0x7']);
	await step('setCode', 'evm_setCode', [X, '0x6002']);
	await step('setStorageAt', 'evm_setStorageAt', [X, '0x1', word(0x2a)]);
	await step('setAccount', 'evm_setAccount', [
		X,
		{
			balance: '0xc8',
			nonce: '0x9',
			code: '0x6003',
			storage: {'0x1': word(0x77), '0x2': word(1)},
		},
	]);
	out.x = X;
	out.fresh = FRESH;
	out.slot1 = `${X}:${word(1)}`;
	out.slot2 = `${X}:${word(2)}`;
	await node.dispose();
	return out;
}

// ------------------------------------------------------------- baselines ----

async function runBaselines(
	makeEngine: EngineFactory | undefined,
	dump: SerializedState,
) {
	// Construction with `initialBalances` AND `initialState`.
	const built = await recordingNode(makeEngine);
	const afterConstruction = probe(built);
	await built.dispose();

	// `loadState` into a node whose open record is NOT empty (a pending cheat).
	const loaded = await recordingNode(makeEngine);
	await loaded.request({method: 'evm_setBalance', params: [RECIPIENT, '0x5']});
	const beforeLoad = probe(loaded);
	await loaded.loadState(dump);
	const afterLoad = probe(loaded);
	// ...and recording goes on normally from the loaded head.
	await loaded.request({method: 'evm_setBalance', params: [RECIPIENT, '0x6']});
	await loaded.mine();
	const afterLoadAndMine = probe(loaded);
	await loaded.dispose();

	// `loadState` at construction, through the persistence option.
	const persisted = await recordingNode(makeEngine, {
		persistence: createMemoryPersistence(dump),
	});
	const afterPersistedLoad = probe(persisted);
	await persisted.dispose();

	return {
		afterConstruction,
		afterConstructionEmpty: isEmptyJson(afterConstruction.open),
		beforeLoadEmpty: isEmptyJson(beforeLoad.open),
		afterLoad,
		afterLoadEmpty: isEmptyJson(afterLoad.open),
		afterLoadAndMine,
		afterPersistedLoad,
		afterPersistedLoadEmpty: isEmptyJson(afterPersistedLoad.open),
	};
}

// ---------------------------------------------------------------- flag off --

async function runFlagOff(makeEngine: EngineFactory | undefined) {
	const node = await createNodeWithInternals(
		{
			chainId: CHAIN_ID,
			miningConfig: {type: 'auto'},
			initialBalances: {[SENDER]: GENESIS_BALANCE},
			engine: makeEngine ? await makeEngine() : undefined,
		},
		{},
	);
	await node.request({method: 'evm_setBalance', params: [RECIPIENT, '0x5']});
	await send(node, 0, {to: RECIPIENT, value: 1n, gas: 21000n});
	await node.request({method: 'evm_setNonce', params: [RECIPIENT, '0x2']});
	await node.mine();
	const p = changeSetsForTests(node);
	await node.dispose();
	return {
		recording: p.recording,
		headBlockIsUndefined: p.headBlock === undefined,
		openIsUndefined: p.open === undefined,
	};
}

export async function runChangeSetChecks(
	params: {makeEngine?: EngineFactory} = {},
) {
	const {dump, ...differential} = await runDifferential(params.makeEngine);
	return {
		differential,
		cheats: await runCheats(params.makeEngine),
		baselines: await runBaselines(params.makeEngine, dump),
		flagOff: await runFlagOff(params.makeEngine),
	};
}

// ------------------------------------ the state manager, directly (default) --

/**
 * What only the state manager itself can show, run once (it has no engine):
 * `assertStateShape` REFUSES a manager lacking the synchronous writers, by name;
 * a write inside a REVERTED level leaves no record and a COMMITTED one records the
 * value from before the level opened; and a commit into committed state while
 * recording is suspended for a pure read is refused without moving the stacks.
 */
export async function runChangeSetStateManagerChecks() {
	const out: Record<string, unknown> = {};

	const sm = new OverlayStorageStateManager();
	try {
		assertStateShape(sm);
		out.shapeAcceptsNodeManager = 'accepted';
	} catch (e) {
		out.shapeAcceptsNodeManager = String((e as Error).message);
	}
	const without = (...names: string[]) => {
		const lacking = Object.create(sm) as Record<string, unknown>;
		for (const n of names) lacking[n] = undefined;
		try {
			assertStateShape(lacking as unknown as OverlayStorageStateManager);
			return 'DID_NOT_THROW';
		} catch (e) {
			return String((e as Error).message);
		}
	};
	out.shapeRefusesWithoutSetAccountAt = without('setAccountAt');
	out.shapeRefusesWithoutSetCodeAt = without('setCodeAt');
	out.shapeRefusesWithoutRemoveAccountAt = without('removeAccountAt');
	out.shapeRefusesWithoutAll = without(
		'setAccountAt',
		'setCodeAt',
		'removeAccountAt',
	);

	// Checkpoint semantics, on a recording manager.
	const r = new OverlayStorageStateManager();
	r.enableChangeSets();
	const A = createAddressFromString(
		'0x00000000000000000000000000000000000000a1',
	);
	const B = createAddressFromString(
		'0x00000000000000000000000000000000000000b2',
	);
	const key = A.toString();
	await r.putAccount(A, new Account(0n, 1n));
	r.takeChangeSet(); // the baseline: A has balance 1
	await r.checkpoint();
	await r.putAccount(B, new Account(0n, 5n));
	await r.revert();
	out.revertedLevelLeavesNoRecord = changeSetJson(r.peekChangeSet());

	await r.checkpoint();
	const inLevel = (await r.getAccount(A))!;
	inLevel.balance = 2n; // the in-place mutation @ethereumjs/vm does inside a frame
	await r.putAccount(A, inLevel);
	await r.checkpoint();
	const deeper = (await r.getAccount(A))!;
	deeper.balance = 3n;
	await r.putAccount(A, deeper);
	await r.commit();
	await r.commit();
	out.committedLevelsRecordTheOuterPrior =
		changeSetJson(r.peekChangeSet())?.accounts[key]?.balance ?? null;
	out.committedLevelsLiveValue = String((await r.getAccount(A))?.balance);

	// A commit INTO the bottom level while suspended is refused, stacks intact.
	let refused = 'DID_NOT_THROW';
	let depthAfterRefusal = -1;
	await r.withChangeSetsSuspended(async () => {
		await r.checkpoint();
		try {
			await r.commit();
		} catch (e) {
			refused = String((e as Error).message);
		}
		depthAfterRefusal = r.accountStack.length;
		await r.revert();
	});
	out.suspendedCommitIntoBottomRefused = refused;
	out.depthAfterRefusal = depthAfterRefusal;
	out.depthAfterRevert = r.accountStack.length;

	// Taking the record with a checkpoint open is refused.
	await r.checkpoint();
	try {
		r.takeChangeSet();
		out.takeWithCheckpointOpen = 'DID_NOT_THROW';
	} catch (e) {
		out.takeWithCheckpointOpen = String((e as Error).message);
	}
	await r.revert();

	// A copy made at the bottom level is not the stored object.
	const got = (await r.getAccount(A))!;
	got.balance = 999n;
	out.bottomLevelReadIsACopy =
		String((await r.getAccount(A))?.balance) !== '999';
	return out;
}
