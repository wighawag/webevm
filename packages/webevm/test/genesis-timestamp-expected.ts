/**
 * genesis-timestamp-expected.ts: the assertions on the genesisTimestamp battery
 * (helpers/genesis-timestamp.ts), shared by the default-engine spec and the revm
 * one, so both engines are held to ONE contract. It lives in its own module
 * because Playwright refuses to let one spec file import another.
 */
import {expect} from '@playwright/test';

export function assertGenesisTimestamp(c: Record<string, any>, label: string) {
	const T = c.genesisT;
	// The mined blocks are pinned to a DIFFERENT value, so neither is read for
	// the other.
	expect(c.minedT, label).not.toBe(T);

	// ---- block 0 carries T, over RPC and to a contract reading TIMESTAMP ----
	const p = c.pinned;
	expect(p.genesisBlockTimestamp, `${label}: block 0 over RPC`).toBe(T);
	expect(p.callAtHeadWhileGenesis, `${label}: TIMESTAMP at the head`).toBe(T);
	expect(p.callAtZeroWhileGenesis, `${label}: TIMESTAMP at 0x0`).toBe(T);
	expect(p.head, label).toBe('1');
	expect(
		p.callAtZeroAfterMining,
		`${label}: TIMESTAMP pinned to block 0 below the head`,
	).toBe(T);
	// ...and the mined block keeps blockEnv.timestamp.
	expect(p.minedBlockTimestamp, `${label}: mined block`).toBe(c.minedT);
	expect(p.callAtHeadAfterMining, `${label}: TIMESTAMP at block 1`).toBe(
		c.minedT,
	);

	// ---- the same chain in different seconds is byte-identical ----
	const s = c.sameChain;
	expect(s.differentSeconds, `${label}: the gap was forced`).toBe(true);
	expect(s.blocks, `${label}: a real chain ran`).toBeGreaterThan(5);
	expect(s.sameGenesisHash, label).toBe(true);
	expect(s.identicalDumps, `${label}: dumps, hashes included`).toBe(true);
	// The control: without the option the same gap changes the genesis hash.
	expect(s.controlGenesisHashesDiffer, `${label}: control`).toBe(true);

	// ---- without the option, block 0 is the wall clock ----
	const w = c.wallClock;
	expect(w.ts, `${label}: wall clock`).toBeGreaterThanOrEqual(w.before);
	expect(w.ts, `${label}: wall clock`).toBeLessThanOrEqual(w.after);

	// ---- a dump carries T; the dump's genesis wins over the loader's option ----
	const r = c.roundTrip;
	expect(r.dumpedGenesisTimestamp, label).toBe(T);
	expect(r.withoutOption, `${label}: load into a node without it`).toEqual({
		timestamp: T,
		sameHash: true,
	});
	expect(
		r.withOtherGenesisTimestamp,
		`${label}: load into a node with another genesisTimestamp`,
	).toEqual({timestamp: T, sameHash: true});
}
