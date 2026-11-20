/**
 * snapshot-cost.ts: what `evm_snapshot` and `evm_revert` COST, at a few state
 * sizes, through the public surface. A snapshot holds a `dumpState()` and a
 * revert replays it through `loadState()` (src/node.ts), so both are O(state):
 * this measures how much, so the README can state it.
 *
 * Each size is a genesis of N accounts, each with a balance and one storage
 * slot, plus a few blocks of transactions; each round takes a snapshot and
 * reverts to it, and the MEDIAN of the rounds is reported. With
 * `computeStateRoot` a revert also rebuilds the derived trie, so that mode is
 * measured too. Default engine only: neither method executes anything, so the
 * engine does not enter into it.
 *
 * The numbers this produced are recorded in
 * docs/spikes/snapshots-in-the-core/measurement.md and quoted in the README.
 */
import {createNode} from '../../src/node.js';
import type {GenesisAccount, SlimNode} from '../../src/types.js';
import {privateKeyToAccount} from 'viem/accounts';
import {BASE_FEE, CHAIN_ID, PK, TIMESTAMP} from './post-state.js';

const account = privateKeyToAccount(PK);
const ROUNDS = 5;

function genesis(n: number): Record<string, GenesisAccount> {
	const out: Record<string, GenesisAccount> = {};
	for (let i = 1; i <= n; i++) {
		const addr = '0x' + i.toString(16).padStart(40, '0');
		out[addr] = {
			balance: BigInt(i),
			storage: {'0x0': '0x' + i.toString(16).padStart(64, '0')},
		};
	}
	return out;
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};
const round = (ms: number) => Math.round(ms * 100) / 100;

async function measure(n: number, computeStateRoot: boolean) {
	const node: SlimNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		genesisTimestamp: TIMESTAMP,
		blockEnv: {timestamp: TIMESTAMP},
		initialBalances: {[account.address]: 10n ** 24n},
		initialState: genesis(n),
		computeStateRoot,
	});
	try {
		for (let nonce = 0; nonce < 4; nonce++) {
			const raw = await account.signTransaction({
				chainId: CHAIN_ID,
				type: 'eip1559',
				nonce,
				gas: 21_000n,
				maxFeePerGas: BASE_FEE,
				maxPriorityFeePerGas: 0n,
				to: '0x0000000000000000000000000000000000000001',
				value: 1n,
			});
			await node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		}
		const dumpBytes = JSON.stringify(await node.dumpState()).length;
		const snapshot: number[] = [];
		const revert: number[] = [];
		for (let r = 0; r < ROUNDS; r++) {
			let t = performance.now();
			const id = await node.request({method: 'evm_snapshot', params: []});
			snapshot.push(performance.now() - t);
			t = performance.now();
			const ok = await node.request({method: 'evm_revert', params: [id]});
			revert.push(performance.now() - t);
			if (ok !== true) throw new Error(`revert ${String(id)} returned ${ok}`);
		}
		return {
			accounts: n,
			computeStateRoot,
			dumpBytes,
			snapshotMs: round(median(snapshot)),
			revertMs: round(median(revert)),
		};
	} finally {
		await node.dispose();
	}
}

export async function runSnapshotCost() {
	const rows = [];
	for (const n of [100, 1_000, 10_000, 50_000])
		rows.push(await measure(n, false));
	for (const n of [100, 1_000, 10_000]) rows.push(await measure(n, true));
	return rows;
}
