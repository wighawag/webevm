/**
 * trie-derived-expected.ts: the assertions on helpers/trie-derived.ts, shared by
 * trie-derived.spec.ts (default engine) and revm-trie-derived.spec.ts, so both
 * engines are held to ONE contract. Its own module because Playwright refuses
 * to let one spec import another.
 */
import {expect} from '@playwright/test';
import {CHANGE_SET_BLOCKS} from './change-set-expected.js';
import {assertStateHistory} from './state-history-expected.js';

const ROOT = /^0x[0-9a-f]{64}$/;

export function assertTrieDerived(c: Record<string, any>, label: string) {
	// ---- DUMP AND RELOAD: storage is in the dump, every root survives ----
	const d = c.dumpReload;
	// The chain ran as named, INCLUDING the creation over a storage-only account,
	// which trie mode used to refuse (EIP-7610) and now creates over, as every
	// node does (ADR 0014).
	expect(Object.keys(d.receipts), label).toEqual(
		CHANGE_SET_BLOCKS.filter((b) => b !== 'cheatsThenEmptyBlock'),
	);
	for (const [name, status] of Object.entries(d.receipts))
		expect(status, `${label}: ${name}`).toBe(
			name === 'revertedTx' ? '0x0' : '0x1',
		);
	expect(d.head, label).toBe(CHANGE_SET_BLOCKS.length);
	// Real roots that move: every block of the chain changes state.
	expect(d.anyZeroRoot, label).toBe(false);
	expect(d.distinctRoots, label).toBe(d.head + 1);
	// The header of each block carries exactly what getStateRoot() said then.
	expect(d.headerVsGetStateRoot, label).toEqual([]);
	// STORAGE IS IN THE DUMP (a trie-mode dump used to carry none at all).
	expect(d.dumpStorageAccounts, label).toBeGreaterThan(3);
	expect(d.dumpHasCheatSlot, label).toBe(true);
	// ...and the reload reproduces EVERY root: each block's header, the root with
	// the cheats pending since the head, and the next block mined on both.
	expect(d.rootMismatches, label).toEqual([]);
	expect(d.rootWithCheats, label).toMatch(ROOT);
	expect(d.rootWithCheatsDiffersFromHead, label).toBe(true);
	expect(d.reloadedRootWithCheats, label).toBe(d.rootWithCheats);
	expect(d.next.reloaded, label).toBe(d.next.original);
	expect(d.nextDiffersFromBefore, label).toBe(true);

	// ---- A NODE WITHOUT computeStateRoot DOES NO TRIE WORK ----
	const n = c.noTrieInNoneMode;
	expect(n.createdByNone, label).toBe(0);
	// The control: the same probe counts a trie-mode node's trie.
	expect(n.createdByTrie, label).toBe(1);
	expect(n.getStateRoot, label).toBe('threw:-32004');
	expect(n.header, label).toBe('0x' + '00'.repeat(32));

	// ---- HISTORY COMPOSES WITH computeStateRoot ----
	expect(c.history.computeStateRoot, label).toBe(true);
	assertStateHistory(c.history, `${label} (computeStateRoot)`);
}
