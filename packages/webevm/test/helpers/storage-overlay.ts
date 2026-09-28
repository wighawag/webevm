/**
 * storage-overlay.ts: the correctness bar for the node's storage
 * representation (`src/state-manager.ts`).
 *
 * CORRECTNESS BEFORE SPEED, in that order. Storage is per-account with a
 * per-checkpoint OVERLAY, which is a real change to how a checkpoint, a commit
 * and a revert behave, and the plausible WRONG version of it fails SILENTLY: a
 * shallow copy of the outer map shares every inner map, so a child frame's write
 * mutates its parent's, survives a revert, and lands in committed state with no
 * error anywhere. So this file ships {@link NaiveSharedInnerMapStateManager} as a
 * CONTROL and the spec asserts it FAILS these checks. Assertions that nothing can
 * fail prove the assertions weak, not the code correct.
 *
 * What is checked, and why each one is here:
 *
 * 1. **Five checkpoint/commit/revert semantics**, the ones the spike ran against
 *    four candidate layouts. The control fails three of them.
 * 2. **A 20,000-operation randomised differential** against
 *    {@link FlatReferenceStateManager} — the layout the node SHIPPED before this
 *    change, frozen here — comparing every read and a full storage snapshot every
 *    500 operations. This is what proves the new layout ANSWERS identically
 *    rather than merely being faster. The control diverges on the same sequence.
 * 3. **The structural claims**: a checkpoint copies no storage, and
 *    `clearStorage` is O(that account). Asserted STRUCTURALLY (the pushed overlay
 *    is empty; the clear is one tombstone and no copied slots) rather than by
 *    wall clock, because a timing threshold in a browser test is a flake. The
 *    wall-clock half is measured in
 *    `docs/spikes/re-layer-storage-as-per-account-maps-with-per-frame-diffs/`.
 *    Plus the tombstone's OWN rule (3b): a tombstone hides what overlays BELOW
 *    it hold, so the BOTTOM overlay keeps none — otherwise the set grew by one
 *    permanent entry per contract creation, forever, and `liveStorage()` walked
 *    them all on every `dumpState`. Both halves are asserted, because pruning
 *    the tombstone must not turn into losing the CLEAR.
 * 4. **The three readers that answered WRONG rather than throwing** when the
 *    layout moved under them: the revm store's `getStorage`, the shape guard, and
 *    `dumpState`'s `'none'` branch. Each is asserted on the value it used to get
 *    silently wrong, plus: reading the retired `storageStack` now THROWS.
 * 5. **The serialised format did not move with the layout.** `dumpState`'s output
 *    is compared byte for byte against a dump captured from the pre-overlay
 *    build, and that same dump is loaded back into a node running the new one.
 * 6. **The storage KEY is packed, and both sides build the same one.**
 *    `@ethereumjs/evm` writes through the ASYNC `putStorage` and revm reads
 *    through the SYNCHRONOUS `storageAt`; two key formats that both "work" turn
 *    every cross-route read into a MISS, which reads as ZERO rather than as an
 *    error. Asserted here at the representation (the key really is 10 / 16 code
 *    units, not 42 / 66 hex characters) and in BOTH directions across the two
 *    routes; end to end, on two real engines, in ./revm-storage-keys.ts.
 */
import {SimpleStateManager} from '@ethereumjs/statemanager';
import {
	bytesToHex,
	createAddressFromString,
	hexToBytes,
	type Address,
} from '@ethereumjs/util';
import {createLegacyTx} from '@ethereumjs/tx';
import {Common, Hardfork, Mainnet} from '@ethereumjs/common';
import {createNode} from '../../src/index.js';
import {OverlayStorageStateManager} from '../../src/state-manager.js';
import {
	assertStateShape,
	SimpleStateManagerStore,
} from '../../src/revm-state-store.js';
import {packAddressKey, packSlotKey} from '../../src/storage-keys.js';
import flatLayoutDump from '../fixtures/dumpstate-flat-layout.json' with {type: 'json'};

// ---------------------------------------------------------------- fixtures --

const addr = (i: number): Address =>
	createAddressFromString(`0x${i.toString(16).padStart(40, '0')}`);
const slot = (i: number): Uint8Array =>
	hexToBytes(`0x${i.toString(16).padStart(64, '0')}`);
const val = (i: number): Uint8Array =>
	hexToBytes(`0x${i.toString(16).padStart(2, '0')}`);

const A1 = addr(1);
const A2 = addr(2);

// ------------------------------------------------- the reference and control -

/**
 * The layout the node SHIPPED before the overlay change: `SimpleStateManager`'s
 * one flat `${address}_${slot}` map, copied whole by every checkpoint, plus the
 * prefix-scan `clearStorage` the node had to add on top of upstream's no-op.
 *
 * FROZEN ON PURPOSE. It is the oracle the randomised differential compares
 * against, so it must keep answering the way the old node did even after
 * `src/state-manager.ts` moves on; taking it from the shipped class instead would
 * compare the new layout against itself and pass vacuously.
 */
export class FlatReferenceStateManager extends SimpleStateManager {
	override async clearStorage(address?: Address): Promise<void> {
		if (address === undefined) return;
		const top = this.topStorageStack();
		const prefix = `${address.toString()}_`;
		for (const key of top.keys()) {
			if (key.startsWith(prefix)) top.delete(key);
		}
	}

	/** `{'0xaddr_0xslot': '0xvalue'}` — the shape both layouts are diffed in. */
	dumpFlat(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [key, value] of this.topStorageStack())
			out[key] = bytesToHex(value);
		return out;
	}
}

/**
 * THE CONTROL: per-account storage where a checkpoint SHALLOW-copies the outer
 * map, i.e. what "just make it `Map<address, Map<slot, value>>`" produces if the
 * checkpoint contract is not thought about. Every inner map is shared with the
 * frame below, so a child frame's write IS a parent frame's write.
 *
 * It is the plausible wrong version, and it is wrong SILENTLY: nothing throws, a
 * reverted `SSTORE` simply stays. It exists so the checks below have something
 * they can fail against.
 */
export class NaiveSharedInnerMapStateManager extends SimpleStateManager {
	// No field initialiser: the base constructor calls checkpointSync() before a
	// subclass field would run. Same trap as src/state-manager.ts documents.
	declare naiveFrames: Map<string, Map<string, Uint8Array>>[];

	protected override checkpointSync(): void {
		this.accountStack.push(new Map(this.topAccountStack()));
		this.codeStack.push(new Map(this.topCodeStack()));
		const frames = this.naiveFrames as
			| Map<string, Map<string, Uint8Array>>[]
			| undefined;
		if (frames === undefined) {
			this.naiveFrames = [new Map()];
			return;
		}
		frames.push(new Map(frames[frames.length - 1])); // shares every inner map
	}
	override async commit(): Promise<void> {
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		this.naiveFrames.splice(-2, 1);
	}
	override async revert(): Promise<void> {
		this.accountStack.pop();
		this.codeStack.pop();
		this.naiveFrames.pop();
	}
	private naiveTop(): Map<string, Map<string, Uint8Array>> {
		return this.naiveFrames[this.naiveFrames.length - 1];
	}
	override async getStorage(
		address: Address,
		key: Uint8Array,
	): Promise<Uint8Array> {
		return (
			this.naiveTop().get(address.toString())?.get(bytesToHex(key)) ??
			new Uint8Array(0)
		);
	}
	override async putStorage(
		address: Address,
		key: Uint8Array,
		value: Uint8Array,
	): Promise<void> {
		const a = address.toString();
		let inner = this.naiveTop().get(a);
		if (inner === undefined) {
			inner = new Map();
			this.naiveTop().set(a, inner);
		}
		inner.set(bytesToHex(key), value);
	}
	override async clearStorage(address?: Address): Promise<void> {
		if (address === undefined) return;
		this.naiveTop().delete(address.toString());
	}
	dumpFlat(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [a, inner] of this.naiveTop())
			for (const [s, v] of inner) out[`${a}_${s}`] = bytesToHex(v);
		return out;
	}
}

/** Any of the three layouts, in the one shape the differential compares. */
interface Diffable {
	getStorage(address: Address, key: Uint8Array): Promise<Uint8Array>;
	putStorage(
		address: Address,
		key: Uint8Array,
		value: Uint8Array,
	): Promise<void>;
	clearStorage(address?: Address): Promise<void>;
	checkpoint(): Promise<void>;
	commit(): Promise<void>;
	revert(): Promise<void>;
}

/** `{'0xaddr_0xslot': '0xvalue'}` for the overlay layout, via its public view. */
function dumpOverlay(sm: OverlayStorageStateManager): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [a, inner] of sm.liveStorage())
		for (const [s, v] of inner) out[`${a}_${s}`] = bytesToHex(v);
	return out;
}

/**
 * Sorted, so the comparison is about CONTENT.
 *
 * The two layouts genuinely differ in iteration order (the flat map is in global
 * insertion order, the overlay one is grouped by account) and that is not a
 * divergence: nothing reads storage by iteration order. `dumpState`'s output
 * order is a separate, stricter claim, asserted against a real fixture below.
 */
function sortedDump(raw: Record<string, string>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		),
	);
}

function dumpOf(sm: Diffable): string {
	return sortedDump(
		sm instanceof OverlayStorageStateManager
			? dumpOverlay(sm)
			: (sm as FlatReferenceStateManager).dumpFlat(),
	);
}

// ------------------------------------------------------- the five semantics --

/** checkpoint -> write -> revert: the parent's value must be untouched. */
async function revertDoesNotLeak(make: () => Diffable): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint();
	await sm.putStorage(A1, slot(0), val(42));
	await sm.putStorage(A1, slot(9), val(9));
	await sm.revert();
	return (
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01' &&
		bytesToHex(await sm.getStorage(A1, slot(9))) === '0x'
	);
}

/** checkpoint -> write -> commit: the write must survive. */
async function commitKeeps(make: () => Diffable): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint();
	await sm.putStorage(A1, slot(0), val(42));
	await sm.commit();
	return bytesToHex(await sm.getStorage(A1, slot(0))) === '0x2a';
}

/** A committed frame must not have been mutating the frame below all along. */
async function commitThenRevertOuter(make: () => Diffable): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint(); // outer
	await sm.checkpoint(); // inner
	await sm.putStorage(A1, slot(0), val(7));
	await sm.commit(); // inner -> outer
	await sm.revert(); // outer dropped, so the 7 must go with it
	return bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01';
}

/** Three frames deep, inner committed into a reverted outer: nothing survives. */
async function nestedCommitInsideRevert(
	make: () => Diffable,
): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.checkpoint(); // frame 1
	await sm.putStorage(A1, slot(0), val(2));
	await sm.checkpoint(); // frame 2
	await sm.putStorage(A1, slot(0), val(3));
	await sm.commit(); // frame 2 into frame 1
	const mid = bytesToHex(await sm.getStorage(A1, slot(0)));
	await sm.revert(); // frame 1 dropped
	return (
		mid === '0x03' && bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01'
	);
}

/** clearStorage inside a reverted frame must not destroy the parent's storage. */
async function clearIsRevertSafe(make: () => Diffable): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.putStorage(A1, slot(1), val(2));
	await sm.putStorage(A2, slot(0), val(3));
	await sm.checkpoint();
	await sm.clearStorage(A1);
	const cleared = bytesToHex(await sm.getStorage(A1, slot(0))) === '0x';
	await sm.revert();
	const restored =
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01' &&
		bytesToHex(await sm.getStorage(A1, slot(1))) === '0x02';

	const sm2 = make();
	await sm2.putStorage(A1, slot(0), val(1));
	await sm2.putStorage(A2, slot(0), val(3));
	await sm2.checkpoint();
	await sm2.clearStorage(A1);
	await sm2.commit();
	return (
		cleared &&
		restored &&
		bytesToHex(await sm2.getStorage(A1, slot(0))) === '0x' &&
		bytesToHex(await sm2.getStorage(A2, slot(0))) === '0x03'
	);
}

/**
 * A slot written, cleared, then written again across nested frames — the case the
 * tombstone exists for, and the one a "clear = delete the slots I can see" fix
 * gets wrong: the clear must hide the OUTER frame's value even though the inner
 * frame never touched that slot.
 */
async function clearThenRewriteNested(make: () => Diffable): Promise<boolean> {
	const sm = make();
	await sm.putStorage(A1, slot(0), val(1));
	await sm.putStorage(A1, slot(1), val(2));
	await sm.checkpoint(); // frame 1
	await sm.putStorage(A1, slot(0), val(3));
	await sm.checkpoint(); // frame 2
	await sm.clearStorage(A1);
	await sm.putStorage(A1, slot(0), val(4));
	// inside frame 2: slot 0 was rewritten after the clear, slot 1 is hidden by it
	const inner =
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x04' &&
		bytesToHex(await sm.getStorage(A1, slot(1))) === '0x';
	await sm.commit(); // frame 2 -> frame 1: the clear must merge down, not vanish
	const merged =
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x04' &&
		bytesToHex(await sm.getStorage(A1, slot(1))) === '0x';
	await sm.revert(); // frame 1 dropped: the original state must come back whole
	const restored =
		bytesToHex(await sm.getStorage(A1, slot(0))) === '0x01' &&
		bytesToHex(await sm.getStorage(A1, slot(1))) === '0x02';
	return inner && merged && restored;
}

const SEMANTICS: [string, (make: () => Diffable) => Promise<boolean>][] = [
	['a write in a REVERTED frame does not survive', revertDoesNotLeak],
	['a write in a COMMITTED frame does survive', commitKeeps],
	[
		'commit into a frame that is then reverted takes the write with it',
		commitThenRevertOuter,
	],
	[
		'three frames deep, commit-then-revert leaves the original',
		nestedCommitInsideRevert,
	],
	['clearStorage is revert-safe and account-local', clearIsRevertSafe],
	[
		'written, cleared, then written again in nested frames',
		clearThenRewriteNested,
	],
];

// -------------------------------------------------------------- the fuzz ----

/** xorshift32, so the sequence is identical on every machine and every run. */
function prng(seed: number): () => number {
	let x = seed >>> 0;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x100000000;
	};
}

/**
 * Drive one layout through a deterministic random sequence of writes, reads,
 * clears, checkpoints, commits and reverts, recording EVERY read plus a full
 * storage snapshot every 500 operations.
 */
async function fuzz(
	make: () => Diffable,
	ops = 20_000,
	seed = 0x2b1d,
): Promise<string> {
	const rnd = prng(seed);
	const sm = make();
	let depth = 0;
	const trace: string[] = [];
	for (let i = 0; i < ops; i++) {
		const r = rnd();
		const A = addr(1 + Math.floor(rnd() * 8));
		const S = slot(Math.floor(rnd() * 12));
		if (r < 0.5) await sm.putStorage(A, S, val(1 + Math.floor(rnd() * 250)));
		else if (r < 0.62) trace.push(bytesToHex(await sm.getStorage(A, S)));
		else if (r < 0.68) await sm.clearStorage(A);
		else if (r < 0.84) {
			await sm.checkpoint();
			depth++;
		} else if (depth > 0) {
			if (rnd() < 0.5) await sm.commit();
			else await sm.revert();
			depth--;
		}
		if (i % 500 === 0) trace.push(dumpOf(sm));
	}
	while (depth-- > 0) await sm.commit();
	return trace.join('|') + '||' + dumpOf(sm);
}

// ------------------------------------------------- the dumpState fixture ----

const CHAIN_ID = 31337;
const PRIV = hexToBytes(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const SENDER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const PLAIN = '0x00000000000000000000000000000000000000ee';
const READER = '0x00000000000000000000000000000000000000a0';
const WRITER = '0x00000000000000000000000000000000000000a1';
const CHEATED = '0x00000000000000000000000000000000000000c0';

// The bytecode below is written as hex rather than as a byte array, because
// prettier explodes a `Uint8Array.from([...])` of opcodes to one byte per line
// and the instruction grouping is the only thing that makes it readable.

/** One byte as two hex digits. */
const b = (n: number): string => n.toString(16).padStart(2, '0');

/** Runtime code: `PUSH1 i+1, PUSH1 i, SSTORE` for `n` slots, then STOP. */
function writerRuntime(n: number): Uint8Array {
	let code = '';
	for (let i = 0; i < n; i++) code += `60${b(i + 1)}60${b(i)}55`;
	return hexToBytes(`0x${code}00`);
}

/** Runtime code: `PUSH1 0, SLOAD, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0, RETURN`. */
const READER_RUNTIME = hexToBytes('0x60005460005260206000f3');

/**
 * Init code that SSTOREs slot 0 <- 0x2a and then returns `runtime`, so the
 * created contract exercises create + clearStorage + a write in ONE frame.
 *
 * `SSTORE(0, 0x2a)`, then `CODECOPY(0, 17, L)`, then `RETURN(0, L)`. 17 (`0x11`)
 * is the length of those three instructions, i.e. where `runtime` starts.
 */
function initCodeFor(runtime: Uint8Array): Uint8Array {
	const L = b(runtime.length);
	const body = `602a600055` + `60${L}6011600039` + `60${L}6000f3`;
	return hexToBytes(`0x${body}${bytesToHex(runtime).slice(2)}`);
}

/**
 * Build EXACTLY the state `test/fixtures/dumpstate-flat-layout.json` was captured
 * from, on the pre-overlay build. Mixed on purpose: pre-state storage, storage
 * written by the EVM through nested checkpoints, a CREATE (which calls
 * `clearStorage`) that also writes a slot, a cheat that gives storage to an
 * account that had none, and a cheat that appends a slot to an account that had
 * some — so the dump exercises grouping AND within-account ordering.
 */
async function buildFixtureNode() {
	const common = new Common({
		chain: {...Mainnet, chainId: CHAIN_ID, name: 'webevm'},
		hardfork: Hardfork.Cancun,
	});
	const node = await createNode({
		chainId: CHAIN_ID,
		initialState: {
			[SENDER]: {balance: 100000000000000000000n},
			[READER]: {code: bytesToHex(READER_RUNTIME), storage: {'0x0': '0x2a'}},
			[WRITER]: {
				code: bytesToHex(writerRuntime(3)),
				storage: {'0x0': '0x11', '0x9': '0x99'},
			},
			[CHEATED]: {balance: 7n},
		},
	});
	const mk = (nonce: number, fields: Record<string, unknown>) =>
		createLegacyTx(
			{
				nonce: BigInt(nonce),
				gasPrice: 2000000000n,
				gasLimit: 1000000n,
				value: 0n,
				...fields,
			},
			{common},
		).sign(PRIV);
	for (const tx of [
		mk(0, {to: PLAIN, value: 1n}),
		mk(1, {to: WRITER}),
		mk(2, {data: bytesToHex(initCodeFor(writerRuntime(3)))}),
		mk(3, {to: PLAIN, value: 2n}),
	]) {
		await node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(tx.serialize())],
		});
	}
	await node.request({
		method: 'evm_setStorageAt',
		params: [CHEATED, '0x7', `0x${'00'.repeat(31)}2a`],
	});
	await node.request({
		method: 'evm_setStorageAt',
		params: [WRITER, '0x5', `0x${'00'.repeat(31)}09`],
	});
	return node;
}

// ------------------------------------------------------------------ checks --

export async function runStorageOverlayChecks(): Promise<
	Record<string, unknown>
> {
	const out: Record<string, unknown> = {};

	// ---------- 1. the semantics, and the control that must fail them ----------
	const shipped: string[] = [];
	const naiveFailures: string[] = [];
	for (const [label, fn] of SEMANTICS) {
		if (!(await fn(() => new OverlayStorageStateManager())))
			shipped.push(label);
		if (!(await fn(() => new NaiveSharedInnerMapStateManager())))
			naiveFailures.push(label);
	}
	out.semanticsFailedByOverlayLayout = shipped;
	out.semanticsFailedByNaiveControl = naiveFailures;

	// ---------- 2. the randomised differential against the shipped-before layout
	const flatTrace = await fuzz(() => new FlatReferenceStateManager());
	const overlayTrace = await fuzz(() => new OverlayStorageStateManager());
	const naiveTrace = await fuzz(() => new NaiveSharedInnerMapStateManager());
	out.fuzzOverlayMatchesFlat = overlayTrace === flatTrace;
	out.fuzzNaiveDivergesFromFlat = naiveTrace !== flatTrace;
	out.fuzzTraceLength = flatTrace.length;

	// ---------- 3. the structural claims ----------
	{
		const sm = new OverlayStorageStateManager();
		for (let i = 0; i < 500; i++) {
			await sm.putStorage(addr(100 + (i % 25)), slot(i), val(1 + (i % 250)));
		}
		const before = sm.storageOverlays.length;
		await sm.checkpoint();
		const top = sm.storageOverlays[sm.storageOverlays.length - 1];
		// A checkpoint COPIES NOTHING: the pushed overlay is empty whatever state holds.
		out.checkpointPushesEmptyOverlay =
			sm.storageOverlays.length === before + 1 &&
			top.written.size === 0 &&
			top.cleared.size === 0;
		// ...and the state below it is still readable through the empty overlay.
		out.readsThroughEmptyOverlay =
			bytesToHex(await sm.getStorage(addr(100), slot(0))) === '0x01';

		await sm.clearStorage(addr(100));
		// `clearStorage` is O(THAT ACCOUNT): one tombstone, no slots copied or
		// scanned, and every other account untouched.
		out.clearIsOneTombstone =
			top.written.size === 0 &&
			top.cleared.size === 1 &&
			// The tombstone is keyed the way every storage key is: PACKED, built by
			// src/storage-keys.ts. `addr(100).toString()` is the ACCOUNT key format
			// (upstream's, for accountStack/codeStack) and would find nothing here.
			top.cleared.has(packAddressKey(addr(100).bytes));
		out.clearLeavesNeighbourAlone =
			bytesToHex(await sm.getStorage(addr(101), slot(1))) === '0x02' &&
			bytesToHex(await sm.getStorage(addr(100), slot(0))) === '0x';
		await sm.revert();
		out.clearRevertRestoresAccount =
			bytesToHex(await sm.getStorage(addr(100), slot(0))) === '0x01';
	}

	// ---------- 3b. a tombstone hides what is BELOW it, so the bottom has none --
	// A tombstone exists to hide the slots overlays BELOW it hold. The BOTTOM
	// overlay has nothing below it, so a tombstone there hides nothing and simply
	// stays for the process's lifetime — and `@ethereumjs/evm` calls
	// `clearStorage` on EVERY contract creation, so an in-browser node accumulated
	// one permanent entry per CREATE ever executed plus an
	// O(addresses-ever-cleared) term in `liveStorage()`, i.e. in every
	// `dumpState`. Both halves are asserted, because dropping the tombstone must
	// not turn into dropping the CLEAR: the account still has to read as cleared.
	{
		const sm = new OverlayStorageStateManager();
		await sm.putStorage(A1, slot(0), val(1));
		await sm.putStorage(A1, slot(1), val(2));
		await sm.putStorage(A2, slot(0), val(3));
		await sm.checkpoint();
		await sm.clearStorage(A1);
		await sm.commit(); // into the BOTTOM overlay
		const bottom = sm.storageOverlays[0];
		out.bottomCommitLeavesNoTombstone =
			sm.storageOverlays.length === 1 &&
			bottom.cleared.size === 0 &&
			!bottom.written.has(packAddressKey(A1.bytes));
		out.bottomCommitStillReadsCleared =
			bytesToHex(await sm.getStorage(A1, slot(0))) === '0x' &&
			bytesToHex(await sm.getStorage(A1, slot(1))) === '0x' &&
			bytesToHex(await sm.getStorage(A2, slot(0))) === '0x03' &&
			!sm.liveStorage().has(A1.toString() as `0x${string}`);

		// ...and it repeats: 200 clear-and-commit cycles at the bottom leave the
		// bottom overlay exactly as empty as one does. This is the growth itself,
		// stated as the property rather than as a byte count.
		const sm2 = new OverlayStorageStateManager();
		for (let i = 0; i < 200; i++) {
			await sm2.checkpoint();
			await sm2.clearStorage(addr(1000 + i));
			await sm2.commit();
		}
		out.repeatedBottomCommitsLeaveNoTombstones =
			sm2.storageOverlays.length === 1 &&
			sm2.storageOverlays[0].cleared.size === 0;

		// The OTHER place a bottom tombstone can be created: a clear with NO
		// checkpoint open, where the top overlay IS the bottom one. The default
		// engine never gets here (`runTx` checkpoints, and the EVM clears at depth
		// 3), but the revm engine commits its state changes through the store's
		// SYNCHRONOUS callbacks with no checkpoint around them, so on that engine
		// every contract creation clears at depth 1 — measured: three CREATEs left
		// three permanent tombstones in the bottom overlay.
		const smBottom = new OverlayStorageStateManager();
		await smBottom.putStorage(A1, slot(0), val(1));
		await smBottom.putStorage(A2, slot(0), val(3));
		await smBottom.clearStorage(A1); // depth 1: the top IS the bottom
		out.clearAtBottomLeavesNoTombstone =
			smBottom.storageOverlays.length === 1 &&
			smBottom.storageOverlays[0].cleared.size === 0;
		out.clearAtBottomStillReadsCleared =
			bytesToHex(await smBottom.getStorage(A1, slot(0))) === '0x' &&
			bytesToHex(await smBottom.getStorage(A2, slot(0))) === '0x03' &&
			!smBottom.liveStorage().has(A1.toString() as `0x${string}`);

		// ...while a commit into a NON-bottom overlay still leaves the tombstone,
		// because there IS something below for it to hide. Skipping it there would
		// resurrect the outer frame's slots on commit.
		const sm3 = new OverlayStorageStateManager();
		await sm3.putStorage(A1, slot(0), val(1));
		await sm3.checkpoint(); // frame 1
		await sm3.checkpoint(); // frame 2
		await sm3.clearStorage(A1);
		await sm3.commit(); // frame 2 -> frame 1, which is NOT the bottom
		out.nonBottomCommitKeepsTombstone =
			sm3.storageOverlays.length === 2 &&
			sm3.storageOverlays[1].cleared.has(packAddressKey(A1.bytes));
		out.nonBottomCommitStillHidesBelow =
			bytesToHex(await sm3.getStorage(A1, slot(0))) === '0x';
		await sm3.revert(); // frame 1 dropped: the bottom's slot must come back
		out.nonBottomTombstoneRevertRestores =
			bytesToHex(await sm3.getStorage(A1, slot(0))) === '0x01';
	}

	// ---------- 4. the readers that used to answer WRONG, silently ----------
	{
		const sm = new OverlayStorageStateManager();
		await sm.putStorage(createAddressFromString(WRITER), slot(0), val(0x2a));

		// (a) the structural guard. It must ACCEPT the node's manager and REFUSE a
		// state manager with a different storage representation — the flat one it
		// used to wave through while every read answered zero.
		let shapeAccepted = 'DID_NOT_THROW';
		try {
			assertStateShape(sm);
			shapeAccepted = 'accepted';
		} catch (e) {
			shapeAccepted = `threw:${String((e as Error).message)}`;
		}
		out.shapeGuardAcceptsOverlayManager = shapeAccepted;
		let shapeRefused = 'DID_NOT_THROW';
		try {
			assertStateShape(
				new FlatReferenceStateManager() as unknown as OverlayStorageStateManager,
			);
		} catch (e) {
			shapeRefused = String((e as Error).message);
		}
		out.shapeGuardRefusesFlatManager = shapeRefused;

		// (b) the revm read store, on the exact value it used to report as zero.
		const store = new SimpleStateManagerStore();
		store.bind(sm);
		const viaStore = store.getStorage(
			hexToBytes(WRITER as `0x${string}`),
			slot(0),
		);
		out.revmStoreReadsTheSlot =
			viaStore === undefined ? 'undefined, i.e. ZERO' : bytesToHex(viaStore);
		out.revmStoreReadsZeroSlotAsUndefined =
			store.getStorage(hexToBytes(WRITER as `0x${string}`), slot(1)) ===
			undefined;

		// (c) the retired flat stack: reading it THROWS instead of reporting an
		// empty storage map as truth.
		let stackRead = 'DID_NOT_THROW';
		try {
			void (sm as unknown as {storageStack: unknown[]}).storageStack;
		} catch (e) {
			stackRead = String((e as Error).message);
		}
		out.readingRetiredStorageStack = stackRead;
	}

	// ---------- 5. dumpState: the SERIALISED format did not move ----------
	{
		const node = await buildFixtureNode();
		const dumped = await node.dumpState();
		const fixture = flatLayoutDump as unknown as typeof dumped;
		// Only the three state sections: the block list carries a wall-clock genesis
		// timestamp, so it cannot be byte-compared across two runs — and it is not
		// what the storage layout could possibly have changed.
		const stateOf = (s: typeof dumped) =>
			JSON.stringify({
				accounts: s.accounts,
				code: s.code,
				storage: s.storage,
			});
		out.dumpStateByteIdenticalToFlatLayout =
			stateOf(dumped) === stateOf(fixture);
		out.dumpStateStorage = JSON.stringify(dumped.storage);
		// The top-level fields the OLD dump carries and a new one does not: the
		// informational mode field, no longer written since `computeStateRoot`
		// replaced the mode option, and ignored on load.
		out.fixtureOnlyTopLevelFields = Object.fromEntries(
			Object.entries(flatLayoutDump).filter(([key]) => !(key in dumped)),
		);
		out.fixtureStorage = JSON.stringify(fixture.storage);

		// ...and a state dumped by the PREVIOUS version loads into this one.
		const fresh = await createNode({chainId: CHAIN_ID});
		await fresh.loadState(fixture);
		const reread = async (address: string, slotHex: string) =>
			String(
				await fresh.request({
					method: 'eth_getStorageAt',
					params: [address, slotHex, 'latest'],
				}),
			);
		out.loadedWriterSlot0 = await reread(WRITER, '0x0');
		out.loadedWriterSlot9 = await reread(WRITER, '0x9');
		out.loadedCheatedSlot7 = await reread(CHEATED, '0x7');
		out.loadedSenderBalance = String(
			await fresh.request({
				method: 'eth_getBalance',
				params: [SENDER, 'latest'],
			}),
		);
		out.loadedReloadedDumpMatches =
			JSON.stringify((await fresh.dumpState()).storage) ===
			JSON.stringify(fixture.storage);
		await node.dispose?.();
		await fresh.dispose?.();
	}

	// ---------- 6. the node's own surface, end to end ----------
	// A regression bar in the plainest possible terms: storage written by a
	// transaction is readable, a REVERTED sub-call's write is not, and a contract
	// created where storage already lives does not inherit it.
	{
		const node = await createNode({
			chainId: CHAIN_ID,
			initialState: {[SENDER]: {balance: 100000000000000000000n}},
		});
		const common = new Common({
			chain: {...Mainnet, chainId: CHAIN_ID, name: 'webevm'},
			hardfork: Hardfork.Cancun,
		});
		// A contract that SSTOREs then reverts: nothing may survive.
		// `SSTORE(0, 0x2a)` then `REVERT(0, 0)`.
		const revertingRuntime = hexToBytes('0x602a60005560006000fd');
		await node.request({
			method: 'evm_setCode',
			params: [PLAIN, bytesToHex(revertingRuntime)],
		});
		const tx = createLegacyTx(
			{
				nonce: 0n,
				gasPrice: 2000000000n,
				gasLimit: 1000000n,
				value: 0n,
				to: PLAIN,
			},
			{common},
		).sign(PRIV);
		await node.request({
			method: 'eth_sendRawTransaction',
			params: [bytesToHex(tx.serialize())],
		});
		out.revertedTxWroteNothing = String(
			await node.request({
				method: 'eth_getStorageAt',
				params: [PLAIN, '0x0', 'latest'],
			}),
		);
		await node.dispose?.();
	}

	// ---------- 7. the storage KEY, and the two-formats-that-both-work hazard --
	// The node owns the key format (ADR 0009), so it is PACKED: two bytes per
	// UTF-16 code unit, 10 code units for an account and 16 for a slot, which is
	// worth half of every cold revm access. The hazard the change brings is that
	// the async route (`putStorage`, which `@ethereumjs/evm` drives) and the
	// synchronous one (`storageAt`, which revm drives) could disagree about the key
	// and BOTH keep working on their own — every cross-route read then misses, and a
	// miss reads as zero rather than as an error.
	{
		const sm = new OverlayStorageStateManager();
		const A = createAddressFromString(WRITER);
		const S = slot(0x2a);
		// Written the way the DEFAULT engine writes: the async interface method.
		await sm.putStorage(A, S, val(0x2a));

		// (a) the representation really holds a PACKED key. The lengths are what say
		// so: a hex key would be 42 and 66 characters, and comparing only against
		// `packAddressKey()` would pass just as well if both sides went back to hex.
		const top = sm.storageOverlays[sm.storageOverlays.length - 1];
		const [addressKey, inner] = [...top.written][0];
		const [slotKey] = [...inner.keys()];
		out.writtenAddressKey = {
			codeUnits: addressKey.length,
			matchesEncoder: addressKey === packAddressKey(A.bytes),
		};
		out.writtenSlotKey = {
			codeUnits: slotKey.length,
			matchesEncoder: slotKey === packSlotKey(S),
		};

		// (b) ASYNC WRITE -> SYNCHRONOUS READ: the slot the default engine just wrote
		// is the slot revm's store finds. This is the direction that turns a genesis
		// account, a `loadState` and every `evm_setStorageAt` into zeroes.
		const store = new SimpleStateManagerStore();
		store.bind(sm);
		const viaStore = store.getStorage(A.bytes, S);
		out.syncReadOfAsyncWrite =
			viaStore === undefined ? 'undefined, i.e. ZERO' : bytesToHex(viaStore);

		// (c) SYNCHRONOUS WRITE -> ASYNC READ, the other direction: a slot revm's
		// store commits is the slot `eth_getStorageAt` and `dumpState` report.
		const S2 = slot(7);
		store.setStorage(A.bytes, S2, slot(0x99));
		out.asyncReadOfSyncWrite = bytesToHex(await sm.getStorage(A, S2));

		// (d) ...and the view `dumpState` serialises still speaks `0x`-HEX, because
		// that output is persisted data. The byte-identical fixture assertion above is
		// the real bar; this names the property it rests on.
		const live = sm.liveStorage();
		const [liveAddressKey, liveInner] = [...live][0];
		out.liveStorageKeys = {
			address: liveAddressKey,
			slots: [...liveInner.keys()],
		};
	}

	return out;
}
