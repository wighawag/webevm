/**
 * state-history-persistence.ts: the `stateHistory` undo log survives
 * `dumpState` / `loadState`. A node loaded from a dump serves the same window,
 * with the same answers, as the node that wrote it; an old dump (no `history`)
 * still loads with history starting at its head; a node with a larger window
 * serves what the dump has, one with a smaller window truncates it, and one
 * without the option ignores the field.
 *
 * ## The oracle is the WRITING node's own answers
 *
 * The change-set chain (./change-set.ts, every write route the history is
 * proven against) is run with a window wide enough to hold all of it, plus
 * cheats after the head (the OPEN record, which the dump folds into the head's
 * record). Every key is then read at every K, through the four point reads
 * (./state-history.ts's `readAll`) and BY EXECUTION (./historical-call.ts's
 * `executeAll`, an `eth_call` per account and per slot), on the writing node.
 * The dump goes through a JSON round trip (what any persistence adapter that
 * serialises would do to it) into a FRESH node created with no state of its own
 * and the same window, which must give every answer at every K identically.
 *
 * ENGINE-PARAMETERISED: `test/state-history-persistence.spec.ts` runs it on the
 * default engine through ./cut.ts, `test/revm-state-history-persistence.spec.ts`
 * on revm through ./cut-revm.ts, and both hold the report to ONE contract
 * (`test/state-history-persistence-expected.ts`).
 */
import {changeSetsForTests, createNode} from '../../src/node.js';
import type {SerializedState, SlimNode} from '../../src/types.js';
import type {EngineFactory} from './conformance.js';
import {chainNodeOptions, runChangeSetChain, word} from './change-set.js';
import {keysOfDump, readAll} from './state-history.js';
import {executeAll, READER} from './historical-call.js';
import {CHAIN_ID} from './post-state.js';
import flatLayoutDump from '../fixtures/dumpstate-flat-layout.json' with {type: 'json'};

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

const hexN = (n: number) => '0x' + n.toString(16);

async function headOf(node: SlimNode): Promise<number> {
	return Number(
		BigInt(String(await node.request({method: 'eth_blockNumber'}))),
	);
}

/** What a persistence adapter that serialises would hand back. */
function throughJson(dump: SerializedState): SerializedState {
	return JSON.parse(JSON.stringify(dump));
}

/** Every answer (point reads and execution) at every block 0..head. */
async function answersAtEveryBlock(
	node: SlimNode,
	head: number,
	addresses: string[],
	slots: string[],
): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	const executable = addresses.filter((a) => a !== READER);
	for (let k = 0; k <= head; k++)
		out.push({
			...(await readAll(node, addresses, slots, hexN(k))),
			...(await executeAll(node, executable, slots, hexN(k))),
		});
	return out;
}

// ------------------------------------------------------ the round trip ----

async function runRoundTrip(makeEngine: EngineFactory | undefined) {
	const opts = () =>
		chainNodeOptions(makeEngine, {stateHistory: {blocks: WIDE_WINDOW}});

	// The key universe: every key a dump of the chain ever holds, plus the
	// addresses the chain names and slot 0 of each (as ./state-history.ts builds it).
	const node = await createNode(await opts());
	const addressSet = new Set<string>();
	const slotSet = new Set<string>();
	keysOfDump(await node.dumpState(), addressSet, slotSet);
	const chain = await runChangeSetChain(node, async () => {
		keysOfDump(await node.dumpState(), addressSet, slotSet);
	});
	for (const a of chain.addresses) addressSet.add(a);
	for (const a of addressSet) slotSet.add(`${a}:${word(0)}`);
	addressSet.delete(READER);
	const addresses = [...addressSet].sort();
	const slots = [...slotSet].sort();

	// Writes since the head: in the OPEN record, which the dump must not lose.
	const [cheated] = addresses.filter((a) => a.endsWith('7777'));
	await node.request({method: 'evm_setBalance', params: [cheated, '0xabcdef']});
	await node.request({method: 'evm_setCode', params: [cheated, '0x60016002']});
	await node.request({
		method: 'evm_setStorageAt',
		params: [cheated, '0x0', word(0x77)],
	});

	const head = await headOf(node);
	const before = await answersAtEveryBlock(node, head, addresses, slots);
	const dump = throughJson(await node.dumpState());
	const writerSealed = [...changeSetsForTests(node).sealedBlocks];
	await node.dispose();

	// A FRESH node: no initial state of its own, the same window and engine.
	const loaded = await createNode({
		chainId: CHAIN_ID,
		stateHistory: {blocks: WIDE_WINDOW},
		engine: makeEngine ? await makeEngine() : undefined,
	});
	await loaded.loadState(dump);
	const loadedHead = await headOf(loaded);
	const after = await answersAtEveryBlock(loaded, head, addresses, slots);
	const loadedSealed = [...changeSetsForTests(loaded).sealedBlocks];
	// dump -> load -> dump is a fixed point, history included.
	const redump = JSON.stringify(throughJson(await loaded.dumpState()));
	await loaded.dispose();

	const mismatches: string[] = [];
	let answersCompared = 0;
	for (let k = 0; k <= head; k++)
		for (const key of Object.keys(before[k])) {
			answersCompared++;
			if (before[k][key] !== after[k][key])
				mismatches.push(
					`block ${k}: ${key}: before ${before[k][key]}, after ${after[k][key]}`,
				);
		}
	let distinctBlocks = 0;
	for (let k = 1; k <= head; k++)
		if (JSON.stringify(before[k]) !== JSON.stringify(before[k - 1]))
			distinctBlocks++;
	const errorsBefore = before.flatMap((b) =>
		Object.values(b).filter(
			(v) => typeof v === 'string' && v.startsWith('ERROR'),
		),
	).length;

	return {
		engineId: loaded.engine.id,
		head,
		loadedHead,
		historyBlocks: (dump.history ?? []).map((r) => r.number),
		writerSealed,
		loadedSealed,
		answersCompared,
		distinctBlocks,
		errorsBefore,
		// The cheats since the head reached the head's record, not a new field.
		cheatedInHeadRecord:
			dump.history?.[dump.history.length - 1]?.accounts[cheated] !== undefined,
		fixedPoint: redump === JSON.stringify(dump),
		mismatches: mismatches.slice(0, 50),
		mismatchCount: mismatches.length,
	};
}

// ---------------------------------------------- changing N between loads ----

/**
 * A dump of blocks 0..8 written with N = 6 (so it holds records 3..8), where
 * before mining block b a cheat set X's balance to b, so X's balance AT block K
 * is K and an answer from the wrong block cannot pass. A last cheat after the
 * head (0x99) is visible at the head only, before and after the load. Loaded
 * with a smaller window, the same one, a larger one, and none.
 */
async function runWindows(makeEngine: EngineFactory | undefined) {
	const X = '0x000000000000000000000000000000000000beef';
	const makeNode = async (blocks: number | undefined) =>
		createNode({
			chainId: CHAIN_ID,
			miningConfig: {type: 'auto'},
			engine: makeEngine ? await makeEngine() : undefined,
			...(blocks === undefined ? {} : {stateHistory: {blocks}}),
		});
	const writer = await makeNode(6);
	for (let b = 1; b <= 8; b++) {
		await writer.request({method: 'evm_setBalance', params: [X, hexN(b)]});
		await writer.mine();
	}
	await writer.request({method: 'evm_setBalance', params: [X, '0x99']});
	const dump = throughJson(await writer.dumpState());
	const balanceAt = (node: SlimNode, k: number | string) =>
		outcome(node, 'eth_getBalance', [X, typeof k === 'number' ? hexN(k) : k]);
	const survey = async (node: SlimNode) => {
		const out: Record<string, Outcome> = {};
		for (let k = 0; k <= 8; k++) out[k] = await balanceAt(node, k);
		out.latest = await balanceAt(node, 'latest');
		return out;
	};
	const writerSurvey = await survey(writer);
	await writer.dispose();

	const load = async (blocks: number | undefined) => {
		const node = await makeNode(blocks);
		await node.loadState(dump);
		const result: Record<string, unknown> = {
			sealed: [...changeSetsForTests(node).sealedBlocks],
			survey: await survey(node),
			call: await outcome(node, 'eth_call', [{to: X}, '0x5']),
		};
		// Mining on moves the window by one, from the loaded history.
		await node.mine();
		result.afterMine = {
			sealed: [...changeSetsForTests(node).sealedBlocks],
			survey: await survey(node),
		};
		result.dumpHasHistory = 'history' in (await node.dumpState());
		await node.dispose();
		return result;
	};
	return {
		dumpHistory: (dump.history ?? []).map((r) => r.number),
		writerSurvey,
		smaller: await load(3),
		same: await load(6),
		larger: await load(20),
		none: await load(undefined),
	};
}

// ----------------------------------------------------------- old dumps ----

/**
 * A dump with no `history`: the flat-layout fixture (written before history
 * existed, blocks 0..4), and a history node's own dump with the field removed.
 * Both load into a node with a window, with history starting at the head.
 */
async function runOldDumps(makeEngine: EngineFactory | undefined) {
	const makeNode = async () =>
		createNode({
			chainId: CHAIN_ID,
			engine: makeEngine ? await makeEngine() : undefined,
			stateHistory: {blocks: 8},
		});
	const X = '0x000000000000000000000000000000000000beef';

	const fixture = throughJson(flatLayoutDump as unknown as SerializedState);
	const fromFixture = await makeNode();
	await fromFixture.loadState(fixture);
	const fixtureResult = {
		hadHistory: 'history' in fixture,
		head: await headOf(fromFixture),
		sealed: [...changeSetsForTests(fromFixture).sealedBlocks],
		atHead: await outcome(fromFixture, 'eth_getBalance', [X, '0x4']),
		belowHead: await outcome(fromFixture, 'eth_getBalance', [X, '0x3']),
	};
	await fromFixture.mine();
	const fixtureAfterMine = {
		sealed: [...changeSetsForTests(fromFixture).sealedBlocks],
		at4: await outcome(fromFixture, 'eth_getBalance', [X, '0x4']),
		at3: await outcome(fromFixture, 'eth_getBalance', [X, '0x3']),
	};
	await fromFixture.dispose();

	const writer = await makeNode();
	for (let b = 1; b <= 3; b++) {
		await writer.request({method: 'evm_setBalance', params: [X, hexN(b)]});
		await writer.mine();
	}
	const stripped = throughJson(await writer.dumpState());
	const writerHadHistory = (stripped.history ?? []).map((r) => r.number);
	delete stripped.history;
	await writer.dispose();
	const fromStripped = await makeNode();
	await fromStripped.loadState(stripped);
	const strippedResult = {
		writerHadHistory,
		sealed: [...changeSetsForTests(fromStripped).sealedBlocks],
		atHead: await outcome(fromStripped, 'eth_getBalance', [X, '0x3']),
		belowHead: await outcome(fromStripped, 'eth_getBalance', [X, '0x2']),
	};
	await fromStripped.dispose();

	return {
		fixture: fixtureResult,
		fixtureAfterMine,
		stripped: strippedResult,
	};
}

// --------------------------------------------------- no history, no field ----

/** A node without `stateHistory` writes no `history` field at all. */
async function runWithoutHistory(makeEngine: EngineFactory | undefined) {
	const node = await createNode({
		chainId: CHAIN_ID,
		engine: makeEngine ? await makeEngine() : undefined,
	});
	await node.mine();
	await node.mine();
	const dump = await node.dumpState();
	await node.dispose();
	return {hasHistoryKey: 'history' in dump, keys: Object.keys(dump)};
}

export async function runStateHistoryPersistenceChecks(
	params: {makeEngine?: EngineFactory} = {},
) {
	return {
		roundTrip: await runRoundTrip(params.makeEngine),
		windows: await runWindows(params.makeEngine),
		oldDumps: await runOldDumps(params.makeEngine),
		withoutHistory: await runWithoutHistory(params.makeEngine),
	};
}
