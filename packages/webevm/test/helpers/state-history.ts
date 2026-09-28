/**
 * state-history.ts: with `stateHistory: {blocks: N}`, the four POINT reads
 * (`eth_getBalance`, `eth_getCode`, `eth_getStorageAt`,
 * `eth_getTransactionCount`) pinned to any block K in the window answer exactly
 * what they answered when K was the head; a block older than the window is
 * refused, naming the window and the option; and the node keeps exactly N sealed
 * records.
 *
 * ## The oracle is the node's own answer AT THE TIME
 *
 * After every block, every key the chain ever touches is read through the four
 * methods at `latest`: that is the SNAPSHOT of block K, taken while K was the
 * head. When the chain is done, every read is repeated at every K in the window,
 * through every way of naming K (number, hash, EIP-1898 `{blockNumber}` /
 * `{blockHash}`, `earliest` for block 0), and must equal K's snapshot. Nothing
 * is compared against the undo log itself.
 *
 * THE KEY UNIVERSE COMES FROM A FIRST RUN of the same (deterministic) chain on a
 * separate node: the keys a block touches are not known until it has run, and a
 * snapshot of block 3 must already contain a slot block 7 is the first to write.
 * The two runs are asserted to end in the same state (`dumpState` less the
 * wall-clock-derived block hashes), so the universe is the second run's too.
 *
 * THE CHAIN IS `runChangeSetChain` of ./change-set.ts, the same write routes the
 * change-set differential covers (transfers, creation over storage, nested
 * creation and frames, a reverted transaction, EIP-161 removal, both
 * `SELFDESTRUCT` halves, all five `evm_set*` cheats between blocks, and pure
 * reads interleaved), rather than a second copy of them.
 *
 * ENGINE-PARAMETERISED: `test/state-history.spec.ts` runs it on the default
 * engine through ./cut.ts, `test/revm-state-history.spec.ts` on revm through
 * ./cut-revm.ts, and both hold the report to ONE contract
 * (`test/state-history-expected.ts`).
 */
import {changeSetsForTests, createNode} from '../../src/node.js';
import type {NodeOptions, SlimNode} from '../../src/types.js';
import {privateKeyToAccount} from 'viem/accounts';
import type {EngineFactory} from './conformance.js';
import {chainNodeOptions, runChangeSetChain, word} from './change-set.js';
import {BASE_FEE, CHAIN_ID, PK} from './post-state.js';

/** Wide enough that the whole chain (10 blocks) stays inside the window. */
const WIDE_WINDOW = 64;

type Outcome = {ok: unknown} | {code: number; message: string};

async function outcome(
	node: SlimNode,
	method: string,
	params: unknown[],
): Promise<Outcome> {
	try {
		return {ok: await node.request({method, params})};
	} catch (e: any) {
		return {code: e?.code, message: String(e?.message ?? e)};
	}
}

/**
 * Every key of a `dumpState`, as `address` and `address:slot`. Exported for
 * ./historical-call.ts, which builds the same key universe.
 */
export function keysOfDump(
	dump: Awaited<ReturnType<SlimNode['dumpState']>>,
	addresses: Set<string>,
	slots: Set<string>,
): void {
	for (const a of Object.keys(dump.accounts)) addresses.add(a.toLowerCase());
	for (const a of Object.keys(dump.code)) addresses.add(a.toLowerCase());
	for (const [a, s] of Object.entries(dump.storage))
		for (const slot of Object.keys(s))
			slots.add(`${a.toLowerCase()}:${slot.toLowerCase()}`);
}

/**
 * Every read of the universe at `block`, keyed `method address[:slot]`.
 * Exported for ./state-history-persistence.ts, which asks the same questions of
 * a node before and after a dump / load.
 */
export async function readAll(
	node: SlimNode,
	addresses: string[],
	slots: string[],
	block: unknown,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	const put = (k: string, o: Outcome) => {
		out[k] = 'ok' in o ? o.ok : `ERROR ${o.code} ${o.message}`;
	};
	for (const a of addresses) {
		put(`balance ${a}`, await outcome(node, 'eth_getBalance', [a, block]));
		put(
			`nonce ${a}`,
			await outcome(node, 'eth_getTransactionCount', [a, block]),
		);
		put(`code ${a}`, await outcome(node, 'eth_getCode', [a, block]));
	}
	for (const k of slots) {
		const [a, s] = k.split(':');
		put(`storage ${k}`, await outcome(node, 'eth_getStorageAt', [a, s, block]));
	}
	return out;
}

function diff(
	expected: Record<string, unknown>,
	got: Record<string, unknown>,
	where: string,
): string[] {
	const out: string[] = [];
	for (const k of Object.keys(expected))
		if (expected[k] !== got[k])
			out.push(`${where} ${k}: expected ${expected[k]}, got ${got[k]}`);
	return out;
}

/**
 * The part of a `dumpState` two runs of the same chain must agree on: the
 * state (accounts, code, storage), the history and the block count. Block
 * HASHES are left out, and with them the headers, receipts and transactions
 * that carry them: genesis is stamped with the wall clock in whole seconds, so
 * two nodes created either side of a second boundary hash every block
 * differently while holding identical state. Comparing the whole dump made the
 * determinism check flaky under load (both runs straddling a tick).
 */
function stateOfDump(dump: Awaited<ReturnType<SlimNode['dumpState']>>) {
	return JSON.stringify({
		accounts: dump.accounts,
		code: dump.code,
		storage: dump.storage,
		history: dump.history,
		blocks: dump.blocks.length,
	});
}

// ------------------------------------------------------ the differential ----

async function runDifferential(makeEngine: EngineFactory | undefined) {
	const opts = (): Promise<NodeOptions> =>
		chainNodeOptions(makeEngine, {stateHistory: {blocks: WIDE_WINDOW}});

	// ---- run 1: the key universe ----
	const scout = await createNode(await opts());
	const addressSet = new Set<string>();
	const slotSet = new Set<string>();
	keysOfDump(await scout.dumpState(), addressSet, slotSet);
	const scoutChain = await runChangeSetChain(scout, async () => {
		keysOfDump(await scout.dumpState(), addressSet, slotSet);
	});
	for (const a of scoutChain.addresses) addressSet.add(a);
	// Slots the chain writes that a dump may never hold (written and cleared in
	// one block), and slot 0 of every address, which most of them use.
	for (const a of addressSet) slotSet.add(`${a}:${word(0)}`);
	const scoutDump = stateOfDump(await scout.dumpState());
	await scout.dispose();
	const addresses = [...addressSet].sort();
	const slots = [...slotSet].sort();

	// ---- run 2: snapshot every key at every block, while it is the head ----
	const node = await createNode(await opts());
	const snapshots = new Map<number, Record<string, unknown>>();
	const hashes = new Map<number, string>();
	const takeSnapshot = async (n: number) => {
		snapshots.set(n, await readAll(node, addresses, slots, 'latest'));
		const b = (await node.request({
			method: 'eth_getBlockByNumber',
			params: ['0x' + n.toString(16), false],
		})) as {hash: string};
		hashes.set(n, b.hash);
	};
	await takeSnapshot(0);
	const chain = await runChangeSetChain(node, async (_label, n) =>
		takeSnapshot(n),
	);
	const deterministic = stateOfDump(await node.dumpState()) === scoutDump;
	const head = Number(
		BigInt(String(await node.request({method: 'eth_blockNumber'}))),
	);

	// ---- cheats AFTER the head: visible at the head, at no older block ----
	const [cheatedAccount] = addresses.filter((a) => a.endsWith('7777'));
	const cheatedSlot = slots.find((k) => k.startsWith(cheatedAccount + ':'))!;
	await node.request({
		method: 'evm_setBalance',
		params: [cheatedAccount, '0xabcdef'],
	});
	await node.request({
		method: 'evm_setNonce',
		params: [cheatedAccount, '0x33'],
	});
	await node.request({
		method: 'evm_setCode',
		params: [cheatedAccount, '0x60016002'],
	});
	await node.request({
		method: 'evm_setStorageAt',
		params: [cheatedAccount, cheatedSlot.split(':')[1], word(0x77)],
	});
	const headAfterCheats = await readAll(node, addresses, slots, 'latest');
	const cheatsChangedTheHead = [
		`balance ${cheatedAccount}`,
		`nonce ${cheatedAccount}`,
		`code ${cheatedAccount}`,
		`storage ${cheatedSlot}`,
	].filter((k) => headAfterCheats[k] !== snapshots.get(head)![k]);

	// ---- every K in the window, through every way of naming it ----
	const mismatches: string[] = [];
	const refsChecked: string[] = [];
	for (let k = 0; k <= head; k++) {
		const expected = k === head ? headAfterCheats : snapshots.get(k)!;
		const hash = hashes.get(k)!;
		const refs: Record<string, unknown> = {
			number: '0x' + k.toString(16),
			hash,
			objectNumber: {blockNumber: '0x' + k.toString(16)},
			objectHash: {blockHash: hash},
		};
		if (k === 0) refs.earliest = 'earliest';
		for (const [name, ref] of Object.entries(refs)) {
			refsChecked.push(`${k}:${name}`);
			mismatches.push(
				...diff(
					expected,
					await readAll(node, addresses, slots, ref),
					`block ${k} by ${name}:`,
				),
			);
		}
	}
	// ...and the blocks really differ from each other, so agreement is not vacuous.
	let distinctSnapshots = 0;
	for (let k = 1; k <= head; k++)
		if (
			JSON.stringify(snapshots.get(k)) !== JSON.stringify(snapshots.get(k - 1))
		)
			distinctSnapshots++;

	await node.dispose();
	return {
		engineId: node.engine.id,
		head,
		receipts: chain.receipts,
		deterministic,
		keyCount: addresses.length * 3 + slots.length,
		refsChecked: refsChecked.length,
		distinctSnapshots,
		cheatsChangedTheHead,
		mismatches: mismatches.slice(0, 50),
		mismatchCount: mismatches.length,
	};
}

// ----------------------------------------------- a cheat between blocks ----

/**
 * A cheat applied between blocks j-1 and j is invisible at j-1 and visible from
 * j on; a cheat applied after the head is visible at the head and nowhere else.
 */
async function runCheatVisibility(makeEngine: EngineFactory | undefined) {
	const X = '0x000000000000000000000000000000000000c0de';
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: makeEngine ? await makeEngine() : undefined,
		stateHistory: {blocks: 8},
	});
	const read = async (block: string) => ({
		balance: await node.request({method: 'eth_getBalance', params: [X, block]}),
		slot: await node.request({
			method: 'eth_getStorageAt',
			params: [X, '0x1', block],
		}),
	});
	await node.mine(); // block 1: nothing
	await node.request({method: 'evm_setBalance', params: [X, '0x5']});
	await node.request({method: 'evm_setStorageAt', params: [X, '0x1', word(5)]});
	await node.mine(); // block 2 = j: the cheat belongs here
	await node.mine(); // block 3
	await node.request({method: 'evm_setBalance', params: [X, '0x9']});
	await node.request({method: 'evm_setStorageAt', params: [X, '0x1', word(9)]});
	// The head is 3; the cheat since it is visible at 3 only.
	const out = {
		at1: await read('0x1'),
		at2: await read('0x2'),
		at3: await read('0x3'),
		latest: await read('latest'),
	};
	await node.dispose();
	return out;
}

// ------------------------------------------------- the window and memory ----

/**
 * The window's two edges and the memory bound. Before mining block b a cheat
 * sets X's balance to b, so X's balance AT block K is K: an answer from the
 * wrong block cannot pass.
 */
async function runWindow(makeEngine: EngineFactory | undefined) {
	const N = 3;
	const X = '0x000000000000000000000000000000000000beef';
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: makeEngine ? await makeEngine() : undefined,
		stateHistory: {blocks: N},
	});
	const balanceAt = (k: number) =>
		outcome(node, 'eth_getBalance', [X, '0x' + k.toString(16)]);
	const mineTo = async (target: number) => {
		for (;;) {
			const head = Number(
				BigInt(String(await node.request({method: 'eth_blockNumber'}))),
			);
			if (head >= target) return;
			await node.request({
				method: 'evm_setBalance',
				params: [X, '0x' + (head + 1).toString(16)],
			});
			await node.mine();
		}
	};
	const sealed = () => [...changeSetsForTests(node).sealedBlocks];

	// Young chain: the whole of it, genesis included, is in the window.
	await mineTo(2);
	const young = {
		earliest: await outcome(node, 'eth_getBalance', [X, 'earliest']),
		at0: await balanceAt(0),
		sealed: sealed(),
	};

	await mineTo(6);
	const atHead6 = {
		edge: await balanceAt(6 - N), // served
		beyond: await balanceAt(6 - N - 1), // refused
		all: [await balanceAt(4), await balanceAt(5), await balanceAt(6)],
		sealed: sealed(),
	};
	await mineTo(7);
	const atHead7 = {
		edge: await balanceAt(7 - N),
		beyond: await balanceAt(7 - N - 1),
		sealed: sealed(),
	};
	// The refusal covers every point read and every way of naming the block.
	const beyondByMethod = {
		code: await outcome(node, 'eth_getCode', [X, '0x2']),
		storage: await outcome(node, 'eth_getStorageAt', [X, '0x0', '0x2']),
		nonce: await outcome(node, 'eth_getTransactionCount', [X, '0x2']),
		earliest: await outcome(node, 'eth_getBalance', [X, 'earliest']),
		// The executing reads are gated by the same window.
		call: await outcome(node, 'eth_call', [{to: X}, '0x2']),
		estimateGas: await outcome(node, 'eth_estimateGas', [{to: X}, '0x2']),
	};
	// eth_call / eth_estimateGas inside the window are SERVED (at that block; see
	// ./historical-call.ts for what they see there).
	const callInWindow = await outcome(node, 'eth_call', [{to: X}, '0x6']);
	const estimateInWindow = await outcome(node, 'eth_estimateGas', [
		{to: X},
		'0x6',
	]);
	const callAtHead = await outcome(node, 'eth_call', [{to: X}, '0x7']);

	// Well past N: still exactly N records, the N newest.
	await mineTo(40);
	const atHead40 = {sealed: sealed(), edge: await balanceAt(40 - N)};
	await node.dispose();
	return {
		n: N,
		young,
		atHead6,
		atHead7,
		beyondByMethod,
		callInWindow,
		estimateInWindow,
		callAtHead,
		atHead40,
	};
}

// --------------------------------------- a batch that throws mid-block ----

/**
 * A refused sender stops a manual-mining batch after an earlier transaction
 * committed: no block is stored, and the committed writes stay in the open
 * record, so they are attributed to the NEXT block. Before it: the head reads
 * them (live), the block below does not. After it: the old head reads the state
 * it was mined with, the new head the committed writes.
 */
async function runMidBlockThrow(makeEngine: EngineFactory | undefined) {
	const signer = privateKeyToAccount(PK);
	const TO = '0x000000000000000000000000000000000000d00d';
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'manual'},
		initialBalances: {[signer.address]: 10n ** 24n},
		engine: makeEngine ? await makeEngine() : undefined,
		stateHistory: {blocks: 8},
	});
	const sign = (nonce: number) =>
		signer.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip1559',
			nonce,
			gas: 21000n,
			maxFeePerGas: BASE_FEE,
			maxPriorityFeePerGas: 0n,
			to: TO,
			value: 1234n,
		});
	await node.mine(); // block 1
	await node.request({
		method: 'eth_sendRawTransaction',
		params: [await sign(0)],
	});
	// Nonce 5 is refused at mine time ("nonce too high"), after nonce 0 ran.
	await node.request({
		method: 'eth_sendRawTransaction',
		params: [await sign(5)],
	});
	let refused = 'DID_NOT_THROW';
	try {
		await node.mine();
	} catch (e) {
		refused = String((e as Error).message);
	}
	const bal = (block: string) =>
		node.request({method: 'eth_getBalance', params: [TO, block]});
	const before = {
		head: await node.request({method: 'eth_blockNumber'}),
		latest: await bal('latest'),
		at0: await bal('0x0'),
		openHoldsTheWrite: Object.keys(
			Object.fromEntries(changeSetsForTests(node).open?.accounts ?? []),
		).includes(TO),
	};
	await node.mine(); // block 2 takes the committed writes
	const after = {
		head: await node.request({method: 'eth_blockNumber'}),
		at1: await bal('0x1'),
		at2: await bal('0x2'),
	};
	await node.dispose();
	return {refused, before, after};
}

// --------------------------------------------------------- no history ----

/** Without the option the node seals nothing and still refuses below the head. */
async function runWithoutHistory(makeEngine: EngineFactory | undefined) {
	const node = await createNode({
		chainId: CHAIN_ID,
		engine: makeEngine ? await makeEngine() : undefined,
	});
	await node.mine();
	await node.mine();
	const p = changeSetsForTests(node);
	const out = {
		recording: p.recording,
		sealed: [...p.sealedBlocks],
		belowHead: await outcome(node, 'eth_getBalance', [
			'0x000000000000000000000000000000000000beef',
			'0x1',
		]),
	};
	await node.dispose();
	return out;
}

export async function runStateHistoryChecks(
	params: {makeEngine?: EngineFactory} = {},
) {
	return {
		differential: await runDifferential(params.makeEngine),
		cheats: await runCheatVisibility(params.makeEngine),
		window: await runWindow(params.makeEngine),
		midBlockThrow: await runMidBlockThrow(params.makeEngine),
		withoutHistory: await runWithoutHistory(params.makeEngine),
	};
}

// ------------------------------------------- construction (engine-free) ----

/**
 * `stateHistory` is validated at construction: absent is off, `{blocks: N}` with
 * N a positive safe integer is on, anything else throws, and so does combining
 * it with `stateMode:'trie'`. No engine is involved, so this runs once.
 */
export async function runStateHistoryConstructionChecks() {
	const attempt = async (opts: unknown) => {
		try {
			const node = await createNode(opts as NodeOptions);
			await node.dispose();
			return 'accepted';
		} catch (e) {
			return String((e as Error).message);
		}
	};
	const invalid: Record<string, unknown> = {
		zero: {blocks: 0},
		negative: {blocks: -1},
		fraction: {blocks: 1.5},
		string: {blocks: '3'},
		nan: {blocks: Number.NaN},
		unsafe: {blocks: 2 ** 53},
		missingBlocks: {},
		bareNumber: 3,
		null: null,
	};
	const refusals: Record<string, string> = {};
	for (const [name, value] of Object.entries(invalid))
		refusals[name] = await attempt({stateHistory: value});
	return {
		refusals,
		trie: await attempt({stateMode: 'trie', stateHistory: {blocks: 4}}),
		trieWithout: await attempt({stateMode: 'trie'}),
		one: await attempt({stateHistory: {blocks: 1}}),
		absent: await attempt({}),
	};
}
