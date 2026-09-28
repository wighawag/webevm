/**
 * storage-collision-expected.ts: the ONE contract both engines are held to by
 * trie-derived.spec.ts and revm-trie-derived.spec.ts (the battery is
 * helpers/storage-collision.ts). Its own module because Playwright refuses to
 * let one spec import another.
 *
 * Every node follows the reference spec (EIP-684 plus the Yellow Paper,
 * execution-specs PR #3508): a nonce or code at the target is a collision, a
 * storage-only target is created over and its storage WIPED. See ADR 0014.
 */
import {expect} from '@playwright/test';

export function assertStorageCollisions(c: Record<string, any>, label: string) {
	for (const mode of ['none', 'trie'] as const) {
		const m = c[mode];
		const where = (what: string) => `${label} ${mode} ${what}`;
		// STORAGE ONLY: created, and the old slot is gone.
		for (const k of ['storageTop', 'storageInner']) {
			expect(m[k].verdict, where(k)).toBe('created');
			expect(m[k].status, where(k)).toBe('success');
			expect(m[k].targetCode, where(k)).toBe('0x42');
			expect(m[k].targetNonce, where(k)).toBe('0x1');
			expect(m[k].targetSlot7, where(k)).toBe('0');
		}
		expect(m.storageInner.create2Returned, where('storageInner')).toBe(
			'target',
		);
		// NONCE and CODE: refused everywhere. A top-level collision consumes all
		// the gas; an inner one fails the CREATE2 (which returns 0) inside a
		// successful call. The target keeps what it had.
		for (const kind of ['nonce', 'code'] as const) {
			const top = `${kind}Top`;
			const inner = `${kind}Inner`;
			expect(m[top].verdict, where(top)).toBe('collision');
			expect(m[top].status, where(top)).toBe('reverted');
			expect(m[top].gasUsed, where(top)).toBe('300000');
			expect(m[inner].verdict, where(inner)).toBe('collision');
			expect(m[inner].status, where(inner)).toBe('success');
			expect(m[inner].create2Returned, where(inner)).toBe('0');
		}
		for (const k of ['codeTop', 'codeInner']) {
			expect(m[k].targetCode, where(k)).toBe('0x43');
			expect(m[k].targetNonce, where(k)).toBe('0x0');
		}
		// EMPTY: created.
		expect(m.emptyTop.verdict, where('emptyTop')).toBe('created');
		expect(m.emptyInner.verdict, where('emptyInner')).toBe('created');
		// The storage-only case costs exactly what the empty one does (the wipe is
		// not metered), which is also what the spike measured on every engine.
		expect(m.storageTop.gasUsed, where('gas')).toBe(m.emptyTop.gasUsed);
		expect(m.storageInner.gasUsed, where('gas')).toBe(m.emptyInner.gasUsed);
	}
	// THE MODES AGREE on everything but the root, case for case.
	for (const k of Object.keys(c.none)) {
		const {root: _n, ...none} = c.none[k];
		const {root: _t, ...trie} = c.trie[k];
		expect(trie, `${label} ${k}: trie mode behaves as 'none' mode`).toEqual(
			none,
		);
	}
	// ...and in trie mode the wipe reaches the ROOT: a creation over storage
	// leaves exactly the state a creation over an empty account does, so the two
	// roots are EQUAL. A storage trie left behind would make them differ.
	expect(c.trie.storageTop.root, `${label} root`).toMatch(/^0x[0-9a-f]{64}$/);
	expect(c.trie.storageTop.root, `${label} root top`).toBe(
		c.trie.emptyTop.root,
	);
	expect(c.trie.storageInner.root, `${label} root inner`).toBe(
		c.trie.emptyInner.root,
	);
	expect(c.trie.nonceTop.root, `${label} root nonce`).not.toBe(
		c.trie.emptyTop.root,
	);
	expect(c.trie.codeTop.root, `${label} root code`).not.toBe(
		c.trie.emptyTop.root,
	);
}
