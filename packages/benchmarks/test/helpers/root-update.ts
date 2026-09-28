/**
 * root-update.ts: what `computeStateRoot: true` costs PER BLOCK, as a function of
 * how many storage slots the block changed.
 *
 * The shared scenario (./scenario.ts) changes ONE slot per block (`increment()`),
 * so its `callAvg` row says what the option costs a small transaction and nothing
 * about how that cost scales. This measurement answers the scaling question
 * (story 7 of `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md`:
 * "a plain node's cost plus a per-block root update proportional to what the
 * block changed").
 *
 * WHY IT IS NOT A NEW BACKEND OR A NEW SCENARIO PHASE. The shared scenario is the
 * cross-backend GAS GATE, and teaching it a new transaction shape means changing
 * all of its backends, several of which have no notion of a state root at all.
 * ADR 0010's amendment records the same call made for the same reason: widening
 * the gate to serve a measurement risks the gate. So this is a separate, webevm
 * only measurement that shares nothing with the gate but the page it runs in.
 *
 * WHAT IS MEASURED, two ways, on either engine:
 *
 * 1. THE BLOCK, BY DIFFERENCE. Two nodes identical except for
 *    `computeStateRoot` each mine the same sequence of blocks, one transaction
 *    per block (auto-mine), each transaction rewriting slots `0..K-1` of one
 *    contract with a value no earlier block wrote, so every one of the K slots
 *    really changes. The measured blocks are INTERLEAVED between the two nodes so
 *    drift (GC, thermal, a noisy neighbour) lands on both. `rootBlockMs -
 *    plainBlockMs` is what the option added to that block: the root update plus
 *    whatever else differs, which is nothing else by construction (execution
 *    never touches the trie, ADR 0014).
 * 2. THE ROOT UPDATE, DIRECTLY. On the root-computing node, K `evm_setStorageAt`
 *    cheats (untimed) followed by ONE timed `getStateRoot()`, which applies the
 *    open record to the derived trie and reads the root: the same
 *    `currentStateRoot` a mined block runs, with no execution around it.
 *
 * Keys changed per block is K slots plus the accounts the transaction touches
 * (the sender, the contract whose `storageRoot` moved, and the coinbase the
 * priority fee credits), so "K" is slots, which is what a game's block is made
 * of.
 *
 * THE SEND PATH is `evm_sendRawTransactionSyncAs` with a FABRICATED signature
 * (no secp256k1 anywhere, as the `webevm-fabricated` row does), chosen so the
 * baseline the delta sits on is as small as possible: signing and recovery would
 * add ~1.5 ms of identical noise to both sides of the subtraction. The delta is
 * unaffected by that choice; the absolute block times are the fabricated path's.
 *
 * THE CONTRACT is hand-assembled (27 bytes of runtime) rather than a new Solidity
 * source, because it is one loop and the repo's only compiled artefact is the
 * gate's Counter: `store(i, v)` for `i` in `0..n`, with `n` and `v` read from the
 * first two calldata words.
 */
import {createNode, type SlimNode} from 'webevm';
import {createRevmEngine} from 'webevm/revm';
import {pad, serializeTransaction} from 'viem';
import {DEPLOYER} from './scenario.js';
import {compiledRevmModule} from './revm-wasm-module.js';

const CHAIN_ID = 31337;

/**
 * Runtime: `PUSH1 0 CALLDATALOAD` (n), `PUSH1 32 CALLDATALOAD` (v), `PUSH1 0`
 * (i), then `loop: JUMPDEST DUP3 DUP2 LT ISZERO PUSH1 end JUMPI DUP2 DUP2 SSTORE
 * PUSH1 1 ADD PUSH1 loop JUMP end: JUMPDEST STOP`.
 */
const WRITER_RUNTIME =
	'6000356020356000' + '5b828110156019578181556001016008565b00';
/** Init code: CODECOPY the 27-byte runtime to memory 0 and RETURN it. */
export const WRITER_INITCODE =
	`0x601b600c600039601b6000f3${WRITER_RUNTIME}` as const;

export type RootUpdateEngine = 'default' | 'revm';

export interface RootUpdateParams {
	engine: RootUpdateEngine;
	/** Slots changed per block, ascending. */
	sizes: number[];
	/** Untimed blocks per size before measuring (the first also creates the slots). */
	warmupBlocks: number;
	/** Timed blocks per size and per node, and timed `getStateRoot()` reps. */
	measuredBlocks: number;
}

export interface RootUpdateRow {
	engine: RootUpdateEngine;
	slots: number;
	/** Median wall time of one mined block (one tx) on the plain node. */
	plainBlockMs: number;
	/** Same, on the `computeStateRoot: true` node. */
	rootBlockMs: number;
	/** `rootBlockMs - plainBlockMs`: what the option added to the block. */
	deltaMs: number;
	/** `deltaMs` per changed slot, in microseconds. */
	deltaPerSlotUs: number;
	/** Median of the direct `getStateRoot()` after K pending cheat writes. */
	cheatRootMs: number;
	/** Mean of the same (robust to WebKit's 1 ms clock clamp, see the spec). */
	cheatRootMeanMs: number;
}

export interface RootUpdateOutcome {
	rows: RootUpdateRow[];
	/** The root node's head `stateRoot` after the last block: must be real. */
	lastBlockStateRoot: string;
	/** The last slot's value on each node after the block series: must agree. */
	plainLastSlot: string;
	rootLastSlot: string;
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const word = (n: number | bigint) =>
	`0x${BigInt(n).toString(16).padStart(64, '0')}` as const;

/** One node plus the fabricated-signature send path, nonce tracked locally. */
async function makeWriterNode(
	engine: RootUpdateEngine,
	computeStateRoot: boolean,
) {
	const node: SlimNode = await createNode({
		chainId: CHAIN_ID,
		senderMode: 'trusted',
		miningConfig: {type: 'auto'},
		initialBalances: {[DEPLOYER]: 10n ** 24n},
		computeStateRoot,
		engine:
			engine === 'revm'
				? await createRevmEngine({wasm: await compiledRevmModule()})
				: undefined,
	});
	let nonce = 0;
	async function send(
		to: `0x${string}` | undefined,
		data: `0x${string}`,
		gas: bigint,
	): Promise<any> {
		const raw = serializeTransaction(
			{
				chainId: CHAIN_ID,
				nonce: nonce++,
				...(to ? {to} : {}),
				data,
				gas,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
				type: 'eip1559',
			} as any,
			{
				r: pad(DEPLOYER, {size: 32}),
				s: pad('0x1', {size: 32}),
				yParity: 0,
			},
		);
		const receipt = await node.request({
			method: 'evm_sendRawTransactionSyncAs',
			params: [raw, DEPLOYER],
		});
		if ((receipt as any).status !== '0x1')
			throw new Error(`writer transaction failed: ${JSON.stringify(receipt)}`);
		return receipt;
	}
	const deployed = await send(undefined, WRITER_INITCODE, 1_000_000n);
	const address = deployed.contractAddress as `0x${string}`;
	return {node, send, address};
}

export async function runRootUpdate(
	params: RootUpdateParams,
): Promise<RootUpdateOutcome> {
	const plain = await makeWriterNode(params.engine, false);
	const root = await makeWriterNode(params.engine, true);
	// Values are never reused, so every slot a block names really changes.
	let value = 1;
	// Enough for the first, slot-creating block at the largest size (22,100 gas
	// per fresh slot); under the node's default 30M block gas limit.
	const GAS = 29_000_000n;
	const block = async (w: typeof plain, slots: number, v: number) => {
		const data = `${word(slots)}${word(v).slice(2)}` as `0x${string}`;
		const t = performance.now();
		await w.send(w.address, data, GAS);
		return performance.now() - t;
	};

	const rows: RootUpdateRow[] = [];
	for (const slots of params.sizes) {
		for (let i = 0; i < params.warmupBlocks; i++) {
			const v = value++;
			await block(plain, slots, v);
			await block(root, slots, v);
		}
		const plainMs: number[] = [];
		const rootMs: number[] = [];
		for (let i = 0; i < params.measuredBlocks; i++) {
			const v = value++;
			// Alternate which node goes first, so neither always runs warm.
			if (i % 2 === 0) {
				plainMs.push(await block(plain, slots, v));
				rootMs.push(await block(root, slots, v));
			} else {
				rootMs.push(await block(root, slots, v));
				plainMs.push(await block(plain, slots, v));
			}
		}
		const cheatMs: number[] = [];
		for (let i = 0; i < params.measuredBlocks; i++) {
			const v = word(value++);
			for (let s = 0; s < slots; s++)
				await root.node.request({
					method: 'evm_setStorageAt',
					params: [root.address, word(s), v],
				});
			const t = performance.now();
			await root.node.getStateRoot();
			cheatMs.push(performance.now() - t);
		}
		// Bring the plain node's slots to the same values as the root node's, so
		// the next size starts both from identical state.
		const last = word(value - 1);
		for (let s = 0; s < slots; s++)
			await plain.node.request({
				method: 'evm_setStorageAt',
				params: [plain.address, word(s), last],
			});

		const plainBlockMs = median(plainMs);
		const rootBlockMs = median(rootMs);
		const deltaMs = rootBlockMs - plainBlockMs;
		rows.push({
			engine: params.engine,
			slots,
			plainBlockMs,
			rootBlockMs,
			deltaMs,
			deltaPerSlotUs: (deltaMs / slots) * 1000,
			cheatRootMs: median(cheatMs),
			cheatRootMeanMs: mean(cheatMs),
		});
	}

	// One more block on each so the head's header carries the cheats' writes too.
	const v = value++;
	const lastSize = params.sizes[params.sizes.length - 1];
	await block(plain, lastSize, v);
	await block(root, lastSize, v);
	const head = (await root.node.request({
		method: 'eth_getBlockByNumber',
		params: ['latest', false],
	})) as {stateRoot: string};
	const slotOf = (w: typeof plain) =>
		w.node.request({
			method: 'eth_getStorageAt',
			params: [w.address, word(lastSize - 1), 'latest'],
		}) as Promise<string>;
	return {
		rows,
		lastBlockStateRoot: head.stateRoot,
		plainLastSlot: await slotOf(plain),
		rootLastSlot: await slotOf(root),
	};
}
