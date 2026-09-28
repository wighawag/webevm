/**
 * trie-derived.ts: `stateMode:'trie'` runs on the SAME flat state as every node
 * and DERIVES its trie from it (src/derived-trie.ts, ADR 0014). What that must
 * give a consumer, through the public surface:
 *
 * - a trie-mode `dumpState` carries STORAGE (it used to carry none), and a
 *   fresh trie-mode node that loads it reports EVERY root the original did: each
 *   block header's `stateRoot`, `getStateRoot()` with cheats pending since the
 *   head, and the root of the next block mined on both;
 * - `'none'` mode does NO trie work: not one derived-trie object is created by a
 *   node that does not compute roots, across construction, transactions, cheats,
 *   a dump and a load (a direct probe of the module's own counter, not a flag);
 * - `stateHistory` composes with trie mode (the state-history battery, run in
 *   trie mode: see ./state-history.ts).
 *
 * The roots themselves are held to the permanent oracles elsewhere: the
 * GeneralStateTests post-state roots (test/statetest.spec.ts, and with revm in
 * test/revm-statetest.spec.ts) and the conformance battery's trie-backed
 * reference. This file is about the derivation's LIFECYCLE (build, keep, reload).
 *
 * ENGINE-PARAMETERISED: ./cut.ts runs it on the default engine and
 * ./cut-revm.ts on revm (which could not run in trie mode at all before).
 */
import {createNode, type SlimNode} from '../../src/index.js';
import {derivedTriesCreatedForTests} from '../../src/derived-trie.js';
import type {EngineFactory} from './conformance.js';
import {
	chainNodeOptions,
	runChangeSetChain,
	send,
	word,
	SENDER,
} from './change-set.js';
import {OUTER_ADDR, INNER_ADDR} from './post-state.js';
import {runStateHistoryChecks} from './state-history.js';

const ZERO_ROOT = '0x' + '00'.repeat(32);

async function headerRoot(node: SlimNode, n: number): Promise<string> {
	const b = (await node.request({
		method: 'eth_getBlockByNumber',
		params: ['0x' + n.toString(16), false],
	})) as {stateRoot: string};
	return b.stateRoot;
}

async function nonceOf(node: SlimNode): Promise<number> {
	return Number(
		BigInt(
			String(
				await node.request({
					method: 'eth_getTransactionCount',
					params: [SENDER, 'latest'],
				}),
			),
		),
	);
}

/**
 * A trie-mode chain, dumped mid-flight (cheats pending since the head) and
 * reloaded into a fresh trie-mode node.
 */
async function runDumpReload(makeEngine: EngineFactory | undefined) {
	const original = await createNode(
		await chainNodeOptions(makeEngine, {stateMode: 'trie'}),
	);
	// The header root of every block, and `getStateRoot()` right after it: the
	// two must agree at a head with nothing pending.
	const roots: string[] = [await headerRoot(original, 0)];
	const headerVsGetStateRoot: string[] = [];
	const check = async (label: string, n: number) => {
		roots[n] = await headerRoot(original, n);
		const live = await original.getStateRoot();
		if (live !== roots[n])
			headerVsGetStateRoot.push(`${label}: header ${roots[n]} live ${live}`);
	};
	const chain = await runChangeSetChain(original, check);
	const head = roots.length - 1;

	// CHEATS AFTER THE HEAD: in the dump's flat state, in no block.
	await original.request({
		method: 'evm_setStorageAt',
		params: [OUTER_ADDR, '0x9', word(0x99)],
	});
	await original.request({
		method: 'evm_setBalance',
		params: [INNER_ADDR, '0x1234'],
	});
	const rootWithCheats = await original.getStateRoot();

	const dump = await original.dumpState();
	const reloaded = await createNode(
		await chainNodeOptions(makeEngine, {stateMode: 'trie'}),
	);
	await reloaded.loadState(dump);

	const rootMismatches: string[] = [];
	for (let n = 0; n <= head; n++) {
		const got = await headerRoot(reloaded, n);
		if (got !== roots[n])
			rootMismatches.push(`block ${n}: original ${roots[n]} reloaded ${got}`);
	}
	const reloadedRootWithCheats = await reloaded.getStateRoot();

	// ...and the SAME next block, mined on both, lands on the same root.
	const nonce = await nonceOf(original);
	const nextOriginal = await send(original, nonce, {
		to: OUTER_ADDR,
		data: '0x',
		gas: 200_000n,
	});
	const nextReloaded = await send(reloaded, nonce, {
		to: OUTER_ADDR,
		data: '0x',
		gas: 200_000n,
	});
	const next = {
		original: await headerRoot(
			original,
			Number(BigInt(nextOriginal.blockNumber)),
		),
		reloaded: await headerRoot(
			reloaded,
			Number(BigInt(nextReloaded.blockNumber)),
		),
	};

	const out = {
		engineId: original.engine.id,
		receipts: chain.receipts,
		head,
		distinctRoots: new Set(roots).size,
		anyZeroRoot: roots.includes(ZERO_ROOT),
		headerVsGetStateRoot,
		// The dump now carries storage: the genesis contract's, the chain's, and
		// the cheat written after the head.
		dumpStorageAccounts: Object.keys(dump.storage).length,
		dumpHasCheatSlot:
			dump.storage[OUTER_ADDR.toLowerCase()]?.[word(9)] !== undefined,
		rootMismatches,
		rootWithCheats,
		rootWithCheatsDiffersFromHead: rootWithCheats !== roots[head],
		reloadedRootWithCheats,
		next,
		nextDiffersFromBefore: next.original !== rootWithCheats,
	};
	await original.dispose();
	await reloaded.dispose();
	return out;
}

/** `'none'` creates no derived trie at all, anywhere in its lifecycle. */
async function runNoTrieInNoneMode(makeEngine: EngineFactory | undefined) {
	const before = derivedTriesCreatedForTests();
	const node = await createNode(await chainNodeOptions(makeEngine));
	await runChangeSetChain(node, async () => {});
	await node.request({
		method: 'evm_setStorageAt',
		params: [OUTER_ADDR, '0x9', word(1)],
	});
	let getStateRoot: string;
	try {
		getStateRoot = `DID_NOT_THROW:${await node.getStateRoot()}`;
	} catch (e) {
		getStateRoot = `threw:${(e as any)?.code}`;
	}
	const dump = await node.dumpState();
	const reloaded = await createNode(await chainNodeOptions(makeEngine));
	await reloaded.loadState(dump);
	const header = await headerRoot(reloaded, 1);
	const createdByNone = derivedTriesCreatedForTests() - before;
	await node.dispose();
	await reloaded.dispose();

	// The CONTROL: the same probe does see a trie-mode node's trie, so a zero
	// above is a measurement rather than a probe that cannot count.
	const beforeTrie = derivedTriesCreatedForTests();
	const trie = await createNode(
		await chainNodeOptions(makeEngine, {stateMode: 'trie'}),
	);
	const createdByTrie = derivedTriesCreatedForTests() - beforeTrie;
	await trie.dispose();
	return {createdByNone, createdByTrie, getStateRoot, header};
}

export async function runTrieDerivedChecks(
	params: {makeEngine?: EngineFactory} = {},
) {
	return {
		dumpReload: await runDumpReload(params.makeEngine),
		noTrieInNoneMode: await runNoTrieInNoneMode(params.makeEngine),
		history: await runStateHistoryChecks({
			makeEngine: params.makeEngine,
			stateMode: 'trie',
		}),
	};
}
