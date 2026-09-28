/**
 * state-manager.ts — the node's `stateMode:'none'` state manager.
 *
 * `@ethereumjs/statemanager@10.1.2`'s `SimpleStateManager` keeps storage in ONE
 * FLAT `Map` keyed `` `${address}_${slot}` ``, and `checkpointSync()` pushes a
 * full COPY of it. `@ethereumjs/evm` checkpoints once per MESSAGE FRAME, so every
 * transaction pays `frames + 1` copies of ALL of state, and `clearStorage` (which
 * the EVM calls on every contract creation) can only be a prefix scan of the whole
 * map. Measured end to end: four ordinary transactions cost 289 ms at 100,000
 * slots on that layout and 10 ms on this one, and one transaction at 10,000 slots
 * already ate between a third and nine tenths of a 16.6 ms frame budget through
 * the node's own public surface. All of it is in
 * `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`.
 *
 * So this subclass re-layers storage. It is `Map<address, Map<slot, value>>`, and
 * a checkpoint pushes a **storage overlay** — one checkpoint's worth of CHANGE —
 * rather than copying anything:
 *
 * - `checkpointSync()` pushes an EMPTY overlay: O(1), whatever state holds.
 * - `putStorage` writes into the TOP overlay only.
 * - `getStorage` walks the overlay stack DOWNWARDS until it finds the slot, or an
 *   overlay that cleared the account (which hides every overlay below it).
 * - `commit()` merges the top overlay into the one below and pops it; `revert()`
 *   just pops it, so an uncommitted write was never anywhere else to begin with.
 * - `clearStorage(address)` is one `delete` plus one tombstone: O(that account)
 *   (no tombstone on the BOTTOM overlay, which has nothing below it to hide).
 *
 * ## The key is PACKED, and both sides of it import ONE encoder
 *
 * The keys in that `Map<address, Map<slot, value>>` are the NODE'S — the point
 * of owning the representation — so they are packed rather than `0x`-hex: two
 * bytes per UTF-16 code unit, 10 code units for an account and 16 for a slot.
 * That takes a cold revm storage access from 1.31-1.33 µs to 0.36-0.39 µs —
 * 70-73%, nearly all of it JS-side key handling — and the encoder, the
 * measurement and the fixed-width rule are in
 * `src/storage-keys.ts` — build a key with {@link packAddressKey} /
 * {@link packSlotKey} and never by hand, because the synchronous revm store
 * (`src/revm-state-store.ts`) builds its keys with the same two functions and a
 * silent disagreement between the two would read as ZERO rather than as an error.
 *
 * ACCOUNTS AND CODE ARE NOT AFFECTED: those stacks are `SimpleStateManager`'s and
 * stay keyed `address.toString()`. Neither is `dumpState`'s output, which stays
 * `0x`-hex — {@link OverlayStorageStateManager.liveStorage} converts on the way
 * out.
 *
 * ONE WORD FOR THE CONCEPT: **overlay**. The spike that produced this design
 * called the same thing an overlay, a diff frame and a journal frame in different
 * places; "frame" already means an EVM message frame (and, in `CONTEXT.md`, the
 * 16.6 ms frame budget) and "journal" already means the one `@ethereumjs/evm`
 * keeps ABOVE the state manager, so neither is free. `overlay` is, and it is
 * defined in `CONTEXT.md`'s glossary. Use it in code, tests and commits.
 *
 * ## Copy-on-write is not enough, and the naive version fails SILENTLY
 *
 * The plausible wrong version of this is `new Map(outer)` per checkpoint: it
 * copies the outer map and SHARES every inner map, so a child frame's write
 * mutates the parent's map, survives a revert, and lands in committed state with
 * no error anywhere. `test/helpers/storage-overlay.ts` keeps that version as a
 * CONTROL and asserts it fails the same checks this class passes — a correctness
 * claim with nothing to fail against is not a claim. (Cloning the inner map on
 * first write fixes the leak but leaves the checkpoint O(accounts-with-storage),
 * which is the same O(total) when state is one slot per account, i.e. exactly
 * what per-player game state looks like. Hence overlays.)
 *
 * ## `storageStack` is GONE, and reading it THROWS
 *
 * The base class's `storageStack` is not maintained here, because it is the thing
 * being replaced. It is deliberately made unreadable rather than left present and
 * empty: with an empty stack still sitting there, three shipped readers answered
 * WRONG rather than throwing (the revm store reported "this slot is zero" for a
 * slot holding `0x2a`, `dumpState` dumped no storage at all, and the guard meant
 * to catch a shape change passed). Wrong-but-plausible is the failure this repo's
 * honest-edge convention exists to prevent, so any remaining reader now gets a
 * loud error naming the replacement instead of a believable zero.
 *
 * ## The field-initialiser trap, which will bite the next person
 *
 * `SimpleStateManager`'s CONSTRUCTOR calls `this.checkpointSync()`. A subclass
 * field declaration runs AFTER `super()` returns, so `storageOverlays = []` would
 * overwrite whatever that first checkpoint created. There is therefore NO field
 * declaration for it: it is created lazily inside the override.
 *
 * ## `clearStorage` is also an upstream-bug fix, and still is
 *
 * `SimpleStateManager` ships `clearStorage` as `async clearStorage() { }`: an
 * empty body taking NO parameter, while the `StateManagerInterface` it implements
 * declares `clearStorage(address)`. A zero-parameter method satisfies a
 * one-parameter interface member, so TypeScript never flagged it and the address
 * argument is silently dropped. `@ethereumjs/evm` calls it on EVERY contract
 * creation (`evm.js:555`) precisely to guarantee a fresh contract starts with
 * empty storage, so with the upstream no-op a contract created at an address that
 * already holds storage INHERITS it. Reported upstream; see
 * `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`.
 *
 * WHY AN OVERRIDE RATHER THAN A `pnpm patch`: a patch would fix only THIS repo's
 * own test runs. `webevm` is a library, so a consumer resolves
 * `@ethereumjs/statemanager` themselves and would never see our patch. The fix
 * has to live in code we publish. That argument is even stronger for the layout,
 * which is a representation our own `dumpState` and revm store read directly.
 *
 * WHAT THIS DOES NOT FIX (and cannot, in this mode): the EIP-7610 collision guard
 * sitting just above that call rejects creation outright when the target account
 * has non-empty storage, and it reads `account.storageRoot`. `SimpleStateManager`
 * implements no state-root logic at all, so `storageRoot` never reflects its
 * storage and the guard cannot fire. `stateMode:'trie'` gets the correct,
 * spec-current behaviour from `MerkleStateManager` (creation fails with
 * `CREATE_COLLISION`); `stateMode:'none'` clears and proceeds, which is the
 * pre-EIP-7610 semantics and what the EVM's own call asks for. Both are far
 * better than silently inheriting; they are not identical to each other, and that
 * asymmetry is documented in the README's state-mode section.
 *
 * ## The per-block CHANGE SET (the open record), and why it lives HERE
 *
 * When switched on ({@link OverlayStorageStateManager.enableChangeSets}, an
 * INTERNAL switch the node flips; no option exposes it yet), this class keeps
 * the OPEN RECORD: every account, code entry and storage slot changed since the
 * record was last taken, with the value each had when it was (FIRST WRITE WINS),
 * plus a per-account "storage was cleared" marker. The node takes it at the end
 * of each mined block, so it names what that block (and any `evm_set*` cheat
 * issued before it) changed, and the value at the end of the previous block. It
 * is the seam bounded state history (an undo log) and trie-from-flat-state (the
 * keys to rehash) both stand on: `work/specs/tasked/bounded-state-history.md`.
 *
 * IT IS HERE, IN ONE PLACE, because every write reaches this class: the default
 * engine's through the async `StateManagerInterface` methods overridden below,
 * revm's through the SYNCHRONOUS by-key methods ({@link setAccountAt},
 * {@link setCodeAt}, {@link removeAccountAt}, {@link setStorageAt},
 * {@link clearStorageAt}) that `src/revm-state-store.ts` is required to call
 * instead of writing the maps itself. The async writers are thin wrappers over
 * the same by-key methods, so there is ONE recording path per key kind.
 *
 * CHECKPOINT-AWARE, the same way the storage overlays are. A record is kept PER
 * CHECKPOINT LEVEL (lazily: a level with no write allocates nothing), holding the
 * value each key had at the START of that level, which is its value in the level
 * BELOW (frozen while this one is open, so reading it at first-write time is the
 * same as reading it at checkpoint time). `commit()` merges the top record into
 * the one below with the BELOW entry winning (it is older), `revert()` drops it.
 * So a write inside a reverted frame, a reverted transaction's inner writes, and
 * every `eth_call` / `eth_estimateGas` / state override leave no trace, by
 * construction rather than by bookkeeping. Pure reads additionally SUSPEND
 * recording ({@link withChangeSetsSuspended}) because their levels are always
 * reverted: a cost rule, not a correctness one.
 *
 * THE PRIOR IS READ FROM THE LEVEL BELOW, NOT FROM THE LEVEL BEING WRITTEN, and
 * that is what makes it immune to an in-place mutation inside a checkpoint
 * (`@ethereumjs/vm` mutates the `Account` object it got and then `putAccount`s
 * it). At the BOTTOM level there is no level below, so the prior is the map's
 * current value, and {@link getAccount} hands out a COPY there so that no caller
 * can mutate it before the write arrives. See {@link getAccount} for the
 * decision and its measured cost.
 */
import {SimpleStateManager} from '@ethereumjs/statemanager';
import type {AccountFields} from '@ethereumjs/common';
import {Account, type Address} from '@ethereumjs/util';
import {keccak_256} from '@noble/hashes/sha3.js';
import {
	packAddressKey,
	packSlotKey,
	unpackAddressKey,
	unpackSlotKey,
	type HexKey,
	type PackedAddressKey,
	type PackedSlotKey,
} from './storage-keys.js';

export type {PackedAddressKey, PackedSlotKey, HexKey} from './storage-keys.js';

/**
 * ONE CHECKPOINT'S WORTH OF STORAGE CHANGE: the slots written since that
 * checkpoint, plus the accounts cleared in it.
 *
 * `written` holds ONLY what this overlay touched, which is what makes a
 * checkpoint O(1): nothing is copied forward. `cleared` is the tombstone half —
 * an account in it reads as EMPTY through this overlay, hiding every overlay
 * below, which is what makes `clearStorage` O(that account) rather than a scan.
 * Both are needed: without `cleared`, a clear could only be expressed by copying
 * the account's slots forward as zeroes, which is the cost being removed.
 *
 * THE BOTTOM OVERLAY HOLDS NO TOMBSTONES. It is committed state, so there is
 * nothing below it for a tombstone to hide and dropping the account's `written`
 * entry has already cleared everything there was. Nothing ever removes an entry
 * from a bottom `cleared` set either, so keeping them made this the one part of
 * the layout that grew without bound — the EVM calls `clearStorage` on EVERY
 * contract creation. Both places one could arrive are pruned at the source:
 * {@link OverlayStorageStateManager.clearStorageAt} when no checkpoint is open,
 * and {@link OverlayStorageStateManager.commit} when the merge target is the
 * bottom.
 */
export interface StorageOverlay {
	/** address key -> (slot key -> value) written IN THIS overlay, PACKED. */
	readonly written: Map<PackedAddressKey, Map<PackedSlotKey, Uint8Array>>;
	/** Accounts cleared in this overlay: every overlay below it is hidden for them. */
	readonly cleared: Set<PackedAddressKey>;
}

function emptyOverlay(): StorageOverlay {
	return {written: new Map(), cleared: new Set()};
}

/**
 * THE PER-BLOCK CHANGE SET: for every key changed since the record was opened,
 * the value it had THEN (`undefined` = absent). See the header's change-set
 * section.
 *
 * Keys are the representation's own: accounts and code by `address.toString()`
 * (the upstream stacks' key), storage by PACKED key (the overlays' key).
 */
export interface ChangeSet {
	/** Account (whole) before the first change, `undefined` if it was absent. */
	readonly accounts: Map<string, Account | undefined>;
	/** Code by address before the first change, `undefined` if there was none. */
	readonly code: Map<string, Uint8Array | undefined>;
	/** Slot values before the first change, `undefined` if the slot was unset. */
	readonly storage: Map<
		PackedAddressKey,
		Map<PackedSlotKey, Uint8Array | undefined>
	>;
	/**
	 * Accounts whose storage was CLEARED (creation over storage, `SELFDESTRUCT`,
	 * EIP-161 removal). A clear also records every slot the account held, so this
	 * marker is not needed to restore a value; it tells a consumer that the
	 * account's WHOLE storage changed (a trie must rebuild it).
	 */
	readonly storageCleared: Set<PackedAddressKey>;
}

function emptyChangeSet(): ChangeSet {
	return {
		accounts: new Map(),
		code: new Map(),
		storage: new Map(),
		storageCleared: new Set(),
	};
}

/** `true` when the change set records nothing. */
export function isEmptyChangeSet(cs: ChangeSet): boolean {
	return (
		cs.accounts.size === 0 &&
		cs.code.size === 0 &&
		cs.storage.size === 0 &&
		cs.storageCleared.size === 0
	);
}

/**
 * Merge `newer` INTO `older`, the OLDER entry winning for a key both name: it
 * holds the value from before the first of the two changes, which is what a
 * change set means. `newer` is consumed (its inner storage maps may be handed to
 * `older` whole), so the caller must not use it afterwards.
 *
 * Two callers, one rule: {@link OverlayStorageStateManager.commit} merging a
 * checkpoint level's record down, and the node sealing a block under the number
 * of the block it replaces (`sealBlock` in ./node.ts).
 */
export function mergeChangeSetOlderWins(
	older: ChangeSet,
	newer: ChangeSet,
): void {
	for (const [key, value] of newer.accounts)
		if (!older.accounts.has(key)) older.accounts.set(key, value);
	for (const [key, value] of newer.code)
		if (!older.code.has(key)) older.code.set(key, value);
	for (const [addressKey, slots] of newer.storage) {
		const target = older.storage.get(addressKey);
		if (target === undefined) {
			older.storage.set(addressKey, slots);
			continue;
		}
		for (const [slotKey, value] of slots)
			if (!target.has(slotKey)) target.set(slotKey, value);
	}
	for (const addressKey of newer.storageCleared)
		older.storageCleared.add(addressKey);
}

/**
 * A copy of an `Account` that shares no mutable state with it: the same trick
 * `checkpointSync()` uses (upstream's, kept byte for byte), which copies the
 * instance's own fields onto a fresh object of the same prototype. The fields are
 * bigints and `Uint8Array`s that are REPLACED rather than mutated, so a shallow
 * copy is independent.
 */
function copyAccount(account: Account): Account {
	return Object.assign(Object.create(Object.getPrototypeOf(account)), account);
}

const STORAGE_STACK_IS_GONE =
	"webevm: SimpleStateManager's flat `storageStack` is not maintained " +
	"by this node. `stateMode:'none'` storage is per-account with per-checkpoint " +
	'OVERLAYS — read it through `storageAt(addressKey, slotKey)` (one slot, ' +
	'synchronously), `liveStorage()` (every live slot, grouped by account) or the ' +
	'async `getStorage(address, key)`. This throws on purpose: an empty ' +
	'`storageStack` left in place answers "that slot is zero" for a slot that ' +
	'holds a value, and a plausible wrong answer is worse than an error. See ' +
	"src/state-manager.ts. (Its keys were not this layout's either: a storage " +
	'key here is PACKED, built by src/storage-keys.ts.)';

export class OverlayStorageStateManager extends SimpleStateManager {
	/**
	 * The overlay stack, bottom (committed state) to top (the innermost open
	 * checkpoint). Always non-empty: the base constructor's `checkpointSync()`
	 * seeds it.
	 *
	 * Public for the same reason `accountStack` and `codeStack` are: the revm store
	 * reads AND WRITES state SYNCHRONOUSLY and `StateManagerInterface` is async
	 * throughout (ADR 0005). Prefer {@link storageAt} / {@link liveStorage} /
	 * {@link setStorageAt} / {@link clearStorageAt} over walking this by hand.
	 *
	 * NO INITIALISER — see the header's field-initialiser trap.
	 */
	declare storageOverlays: StorageOverlay[];

	/**
	 * The change set PER CHECKPOINT LEVEL, parallel to `accountStack` (index 0 is
	 * the OPEN RECORD). `undefined` as a whole means recording is OFF, which is the
	 * default and costs nothing; an `undefined` entry means that level has written
	 * nothing yet. NO INITIALISER, for the header's field-initialiser trap: the
	 * base constructor's `checkpointSync()` runs before any field would.
	 */
	declare private changeLevels: (ChangeSet | undefined)[] | undefined;
	/** > 0 while a pure read runs: see {@link withChangeSetsSuspended}. */
	declare private changeSetsSuspended: number | undefined;

	constructor(opts?: ConstructorParameters<typeof SimpleStateManager>[0]) {
		super(opts);
		// The base constructor assigned `this.storageStack = []`. Replace that own
		// property with a throwing accessor, so a reader that has not been migrated
		// fails loudly here instead of reporting an empty storage map as truth. The
		// setter swallows writes rather than throwing, because the base class also
		// assigns to it and a constructor that throws is not the honest edge — a
		// READ is where a wrong answer would escape.
		Object.defineProperty(this, 'storageStack', {
			configurable: true,
			get(): never {
				throw new Error(STORAGE_STACK_IS_GONE);
			},
			set(): void {},
		});
	}

	// --- the checkpoint contract --------------------------------------------

	/**
	 * Push a frame. Accounts and code exactly as upstream (they are not what this
	 * class re-layers, and copying them byte-for-byte keeps the diff honest);
	 * storage pushes an EMPTY overlay, which copies nothing at any state size.
	 */
	protected override checkpointSync(): void {
		const newTopA = new Map(this.topAccountStack());
		for (const [address, account] of newTopA) {
			newTopA.set(
				address,
				account !== undefined
					? Object.assign(
							Object.create(Object.getPrototypeOf(account)),
							account,
						)
					: undefined,
			);
		}
		this.accountStack.push(newTopA);
		this.codeStack.push(new Map(this.topCodeStack()));
		// A new level records nothing until it writes (lazy), so a frame that only
		// reads allocates nothing here.
		this.changeLevels?.push(undefined);
		// First call comes from the BASE constructor, before any subclass field
		// could have run. `as ... | undefined` because the declared type says it is
		// always there, and at this one instant it is not.
		const overlays = this.storageOverlays as StorageOverlay[] | undefined;
		if (overlays === undefined) {
			this.storageOverlays = [emptyOverlay()];
			return;
		}
		overlays.push(emptyOverlay());
	}

	/**
	 * Merge the top overlay into the one below and drop it.
	 *
	 * The clear is merged FIRST and in O(1) per account: dropping the account from
	 * the overlay below and re-tombstoning it there hides everything deeper,
	 * without touching a single slot. Then the writes land on top of that, so a
	 * clear-then-write inside one frame commits as "only the new slots".
	 *
	 * EXCEPT ON THE BOTTOM OVERLAY, WHICH KEEPS NO TOMBSTONES. A tombstone exists
	 * to hide the slots overlays BELOW it hold; the bottom overlay is committed
	 * state and has nothing below, so a tombstone there hides nothing and is never
	 * removed by anything. `@ethereumjs/evm` calls `clearStorage` on EVERY contract
	 * creation, so keeping them cost a long-lived in-browser node one permanent
	 * entry per CREATE ever executed, plus an O(addresses-ever-cleared) term in
	 * {@link liveStorage} and therefore in every `dumpState`. The `delete` is what
	 * performs the clear and it still runs, so the account still reads as cleared —
	 * {@link storageAt} falls off the end of the stack, which is the same
	 * `undefined` a tombstone would have produced. Pruned HERE, at one of the two
	 * places a bottom tombstone can be created (the other is
	 * {@link clearStorageAt}, with no checkpoint open), rather than swept later.
	 */
	override async commit(): Promise<void> {
		// Refused BEFORE anything moves, so a refusal leaves the stacks as they were.
		this.refuseCommitIntoBottomWhileSuspended();
		this.accountStack.splice(-2, 1);
		this.codeStack.splice(-2, 1);
		const overlays = this.storageOverlays;
		const top = overlays[overlays.length - 1];
		const below = overlays[overlays.length - 2];
		if (top === undefined || below === undefined) {
			throw new Error(
				'webevm: commit() with no open storage checkpoint below the ' +
					'top one. Every commit must be preceded by a checkpoint.',
			);
		}
		// After the `pop()` below, `below` is the bottom overlay exactly when the
		// stack is two deep now.
		const belowIsBottom = overlays.length === 2;
		this.mergeChangeLevelDown();
		for (const address of top.cleared) {
			below.written.delete(address);
			if (!belowIsBottom) below.cleared.add(address);
		}
		for (const [address, inner] of top.written) {
			const target = below.written.get(address);
			// `inner` was created by `top`, which is about to disappear, so no overlay
			// below can be holding a reference to it: handing the object over is safe
			// and O(1). This is the one place ownership moves, and it is why nothing
			// here needs copy-on-write bookkeeping.
			if (target === undefined) below.written.set(address, inner);
			else for (const [slot, value] of inner) target.set(slot, value);
		}
		overlays.pop();
	}

	/** Drop the top overlay. Everything written since the checkpoint goes with it. */
	override async revert(): Promise<void> {
		this.accountStack.pop();
		this.codeStack.pop();
		this.storageOverlays.pop();
		// ...and the change set it recorded goes with it: a reverted write was never
		// a change.
		this.changeLevels?.pop();
	}

	// --- the change set (the open record) -------------------------------------

	/**
	 * Switch change-set recording ON. INTERNAL: called by the node when a feature
	 * that consumes change sets is on (bounded state history, trie-from-flat-state);
	 * no option exposes it directly. Only with no checkpoint open, so the level
	 * array starts parallel to the stacks.
	 */
	enableChangeSets(): void {
		if (this.accountStack.length !== 1)
			throw new Error(
				'webevm: change sets can only be switched on with no checkpoint open.',
			);
		this.changeLevels ??= [emptyChangeSet()];
	}

	/** Whether {@link enableChangeSets} was called. */
	get recordsChangeSets(): boolean {
		return this.changeLevels !== undefined;
	}

	/**
	 * The OPEN RECORD as it stands, without taking it. `undefined` when recording
	 * is off. Read-only by contract: the node's test-only probe and the next
	 * consumers read it; nothing may mutate it.
	 */
	peekChangeSet(): ChangeSet | undefined {
		return this.changeLevels?.[0];
	}

	/**
	 * TAKE the open record and open a fresh one: the node calls this at the end of
	 * each mined block. `undefined` when recording is off. Refused with a
	 * checkpoint open, because the writes of an open level are not in the open
	 * record yet and would be attributed to the wrong block.
	 */
	takeChangeSet(): ChangeSet | undefined {
		const levels = this.changeLevels;
		if (levels === undefined) return undefined;
		if (levels.length !== 1)
			throw new Error(
				'webevm: the change set was taken with a checkpoint open; its writes ' +
					'would be attributed to the wrong block.',
			);
		const taken = levels[0] ?? emptyChangeSet();
		levels[0] = emptyChangeSet();
		return taken;
	}

	/**
	 * Run a PURE READ (`eth_call`, `eth_estimateGas`, a state override) with
	 * recording suspended. Its levels are always reverted, so recording there is
	 * wasted work that the revert would throw away: a COST rule. Correctness does
	 * not depend on it, and it is guarded anyway: a write at the bottom level (no
	 * checkpoint open) is still recorded, and a commit INTO the bottom level while
	 * suspended throws, since that would be a suspended write becoming state.
	 */
	async withChangeSetsSuspended<T>(read: () => Promise<T>): Promise<T> {
		if (this.changeLevels === undefined) return read();
		this.changeSetsSuspended = (this.changeSetsSuspended ?? 0) + 1;
		try {
			return await read();
		} finally {
			this.changeSetsSuspended = (this.changeSetsSuspended ?? 1) - 1;
		}
	}

	/**
	 * The record of the CURRENT (top) level, created on first use, or `undefined`
	 * when nothing should be recorded: recording off, or a suspended pure read above
	 * the bottom level.
	 */
	private recordingLevel(): ChangeSet | undefined {
		const levels = this.changeLevels;
		if (levels === undefined) return undefined;
		const depth = levels.length - 1;
		if (depth > 0 && (this.changeSetsSuspended ?? 0) > 0) return undefined;
		let record = levels[depth];
		if (record === undefined) {
			record = emptyChangeSet();
			levels[depth] = record;
		}
		return record;
	}

	/**
	 * The stack index the PRIOR of a write is read from: the level below the top
	 * (frozen while the top is open), or the bottom itself when no checkpoint is
	 * open (read before the write lands).
	 */
	private priorIndex(): number {
		return Math.max(this.accountStack.length - 2, 0);
	}

	private recordAccountPrior(key: string): void {
		const record = this.recordingLevel();
		if (record === undefined || record.accounts.has(key)) return;
		const prior = this.accountStack[this.priorIndex()].get(
			key as `0x${string}`,
		);
		// A COPY: the object may be handed to (and mutated by) somebody later, and
		// the record must keep saying what it was.
		record.accounts.set(key, prior && copyAccount(prior));
	}

	private recordCodePrior(key: string): void {
		const record = this.recordingLevel();
		if (record === undefined || record.code.has(key)) return;
		record.code.set(
			key,
			this.codeStack[this.priorIndex()].get(key as `0x${string}`),
		);
	}

	private recordSlotPrior(
		addressKey: PackedAddressKey,
		slotKey: PackedSlotKey,
	): void {
		const record = this.recordingLevel();
		if (record === undefined) return;
		let inner = record.storage.get(addressKey);
		if (inner?.has(slotKey)) return;
		if (inner === undefined) {
			inner = new Map();
			record.storage.set(addressKey, inner);
		}
		inner.set(
			slotKey,
			this.storageAtDepth(addressKey, slotKey, this.priorIndex()),
		);
	}

	/**
	 * A storage CLEAR: record every slot the account held (as seen from the level
	 * below) that is not already recorded, plus the cleared marker. O(slots of
	 * that account), paid only on a clear and only with recording on.
	 */
	private recordClearPrior(addressKey: PackedAddressKey): void {
		const record = this.recordingLevel();
		if (record === undefined) return;
		record.storageCleared.add(addressKey);
		let inner = record.storage.get(addressKey);
		const overlays = this.storageOverlays;
		// Walk downwards exactly as `storageAt` does: a higher overlay shadows a
		// lower one (the `has` check keeps the first, i.e. highest, value seen), and
		// an overlay that cleared the account hides everything below it.
		for (let i = this.priorIndex(); i >= 0; i--) {
			const overlay = overlays[i];
			const written = overlay.written.get(addressKey);
			if (written !== undefined) {
				for (const [slotKey, value] of written) {
					if (inner === undefined) {
						inner = new Map();
						record.storage.set(addressKey, inner);
					}
					if (!inner.has(slotKey)) inner.set(slotKey, value);
				}
			}
			if (overlay.cleared.has(addressKey)) break;
		}
	}

	/**
	 * A commit INTO the bottom level while recording is suspended would turn a
	 * pure read's unrecorded writes into committed state behind the record, so it
	 * is refused. No pure read does it (each reverts the level it opened); this is
	 * the guard that makes the suspension a cost rule and never a correctness one.
	 */
	private refuseCommitIntoBottomWhileSuspended(): void {
		if (
			this.changeLevels !== undefined &&
			(this.changeSetsSuspended ?? 0) > 0 &&
			this.accountStack.length === 2
		)
			throw new Error(
				'webevm: a checkpoint was committed into committed state while change ' +
					'sets were suspended for a pure read. A pure read must revert its ' +
					'levels; its writes were not recorded.',
			);
	}

	/**
	 * `commit()`'s half for the change set: merge the top level's record into the
	 * one below, the BELOW entry winning (it holds the older value: the key was
	 * written there before the checkpoint).
	 */
	private mergeChangeLevelDown(): void {
		const levels = this.changeLevels;
		if (levels === undefined) return;
		const top = levels.pop();
		if (top === undefined) return;
		const belowIndex = levels.length - 1;
		const below = levels[belowIndex];
		// The top level is gone after this, so nobody else holds its maps: hand them
		// down whole when the level below has recorded nothing.
		if (below === undefined) {
			levels[belowIndex] = top;
			return;
		}
		mergeChangeSetOlderWins(below, top);
	}

	// --- accounts and code ------------------------------------------------------
	// Every write to the account and code maps goes through the three by-key
	// methods below, which record the prior first. The async `StateManagerInterface`
	// writers are wrappers over them; `src/revm-state-store.ts` calls them directly
	// (it cannot await). Upstream's writers, enumerated from
	// `@ethereumjs/statemanager@10.1.2`'s `SimpleStateManager`: `putAccount`,
	// `deleteAccount`, `modifyAccountFields` and `putCode` (which writes the code
	// map and then the account's `codeHash`). All four are overridden.

	/**
	 * Write one account SYNCHRONOUSLY, by key, into the TOP level: the account
	 * twin of {@link setStorageAt}, for revm's synchronous commit callback. The key
	 * is `address.toString()` (`0x`, lowercase), the upstream stack's key.
	 * `undefined` tombstones the account, as upstream's `putAccount` does.
	 */
	setAccountAt(addressKey: string, account: Account | undefined): void {
		this.recordAccountPrior(addressKey);
		this.topAccountStack().set(addressKey as `0x${string}`, account);
	}

	/**
	 * Tombstone one account SYNCHRONOUSLY, by key. The ACCOUNT only: the storage
	 * half is {@link clearStorageAt}, which revm's binding sends immediately
	 * before (see `removeAccount` in `src/revm-state-store.ts`), and the async
	 * {@link deleteAccount} does both. Code is left in place, as upstream leaves it.
	 */
	removeAccountAt(addressKey: string): void {
		this.setAccountAt(addressKey, undefined);
	}

	/**
	 * Write one account's CODE SYNCHRONOUSLY, by key, into the TOP level. The code
	 * map only: the account's `codeHash` is the caller's to write (revm's
	 * `setAccount` carries it; the async {@link putCode} writes it itself).
	 */
	setCodeAt(addressKey: string, code: Uint8Array): void {
		this.recordCodePrior(addressKey);
		this.topCodeStack().set(addressKey as `0x${string}`, code);
	}

	/**
	 * Read one account, handing out a COPY WHEN NO CHECKPOINT IS OPEN.
	 *
	 * THE HAZARD: upstream returns the object stored IN the top account map.
	 * Inside a checkpoint that is harmless, because a level holds copies and the
	 * change set reads a write's prior from the level below. At the BOTTOM level
	 * (where the `evm_set*` cheats, `refuseIfSenderCannotSend` and every RPC read
	 * run) there is no level below: a caller that edits the object and then calls
	 * `putAccount` (the node's `mutateAccount`, upstream `modifyAccountFields`,
	 * reached from `putCode`) has overwritten the prior before any write hook
	 * runs, and the record would hold the NEW value as the old one.
	 *
	 * DECISION (state-change-set-capture, 2026-09-28): close it at the seam, by
	 * copying at the bottom level only, and regardless of whether change sets are
	 * on, so aliasing semantics do not depend on an internal flag. Rejected: fixing
	 * `mutateAccount` alone (upstream `modifyAccountFields` does the same);
	 * recording the prior on the first bottom-level READ (it would put every
	 * `eth_getBalance`'d key in the record, a superset the history would then
	 * store per block); copying at every level (the default engine's hot path runs
	 * inside checkpoints and needs no copy). MEASURED COST: one object allocation
	 * per bottom-level read, which is only RPC reads and cheats, never the
	 * interpreter; see
	 * `docs/spikes/state-change-set-capture/measurements.md`.
	 */
	override async getAccount(address: Address): Promise<Account | undefined> {
		const account = this.topAccountStack().get(address.toString());
		if (account === undefined || this.accountStack.length > 1) return account;
		return copyAccount(account);
	}

	override async putAccount(
		address: Address,
		account?: Account | undefined,
	): Promise<void> {
		this.setAccountAt(address.toString(), account);
	}

	/**
	 * Read-modify-write of named fields. Overridden rather than inherited so the
	 * write provably goes through {@link putAccount} and the read through
	 * {@link getAccount}'s bottom-level copy, instead of depending on upstream's
	 * `modifyAccountFields` helper keeping that shape.
	 */
	override async modifyAccountFields(
		address: Address,
		accountFields: AccountFields,
	): Promise<void> {
		const account = (await this.getAccount(address)) ?? new Account();
		account.nonce = accountFields.nonce ?? account.nonce;
		account.balance = accountFields.balance ?? account.balance;
		account.storageRoot = accountFields.storageRoot ?? account.storageRoot;
		account.codeHash = accountFields.codeHash ?? account.codeHash;
		account.codeSize = accountFields.codeSize ?? account.codeSize;
		await this.putAccount(address, account);
	}

	/**
	 * Upstream's `putCode`, restated so the code-map write goes through
	 * {@link setCodeAt}: the code, then an empty account if there was none, then
	 * the account's `codeHash`.
	 */
	override async putCode(address: Address, value: Uint8Array): Promise<void> {
		this.setCodeAt(address.toString(), value);
		if ((await this.getAccount(address)) === undefined)
			await this.putAccount(address, new Account());
		await this.modifyAccountFields(address, {
			codeHash: (this.common?.customCrypto.keccak256 ?? keccak_256)(value),
		});
	}

	// --- storage -------------------------------------------------------------

	private topOverlay(): StorageOverlay {
		const overlays = this.storageOverlays;
		const top = overlays[overlays.length - 1];
		if (top === undefined) {
			throw new Error(
				'webevm: the storage overlay stack is empty, so there is no ' +
					'state to read or write. More reverts than checkpoints.',
			);
		}
		return top;
	}

	/**
	 * Read one slot SYNCHRONOUSLY, by key, walking the overlay stack downwards.
	 *
	 * BOTH KEYS ARE PACKED and must come from `src/storage-keys.ts`
	 * ({@link packAddressKey} / {@link packSlotKey}). A hand-built key that happens
	 * to be a string compiles and MISSES, and a miss here is indistinguishable from
	 * a slot holding zero.
	 *
	 * `undefined` means "no overlay holds this slot", i.e. zero. A zero-LENGTH
	 * `Uint8Array` is different: it means an overlay explicitly stored the empty
	 * value (the interpreter strips leading zeros before `putStorage`, so a slot
	 * zeroed by `SSTORE` is stored as empty rather than deleted) and it must stop
	 * the walk, or a cleared slot would read through to a stale value below.
	 *
	 * The stack walk is the cost this layout ADDS, and it is two map lookups per
	 * open checkpoint. Measured against frame depths 1/2/4/8 it is not
	 * distinguishable from the flat map's single lookup; see the spike.
	 */
	storageAt(
		addressKey: PackedAddressKey,
		slotKey: PackedSlotKey,
	): Uint8Array | undefined {
		return this.storageAtDepth(
			addressKey,
			slotKey,
			this.storageOverlays.length - 1,
		);
	}

	/** {@link storageAt} as seen from overlay `from` downwards. */
	private storageAtDepth(
		addressKey: PackedAddressKey,
		slotKey: PackedSlotKey,
		from: number,
	): Uint8Array | undefined {
		const overlays = this.storageOverlays;
		for (let i = from; i >= 0; i--) {
			const overlay = overlays[i];
			const hit = overlay.written.get(addressKey)?.get(slotKey);
			if (hit !== undefined) return hit;
			if (overlay.cleared.has(addressKey)) return undefined;
		}
		return undefined;
	}

	/**
	 * Write one slot SYNCHRONOUSLY, by key, into the TOP overlay — the write-side
	 * twin of {@link storageAt}, and for the same reason it exists: revm's commit
	 * runs inside a synchronous wasm callback and every method on
	 * `StateManagerInterface` returns a `Promise` (ADR 0005). `putStorage` below is
	 * this function plus an `Address`.
	 *
	 * THE VALUE MUST ALREADY BE IN SHORTEST FORM, because that is what this
	 * representation holds and what `dumpState` serialises: `@ethereumjs/evm`
	 * strips leading zeros before `putStorage` (a zeroed slot arrives as a
	 * ZERO-LENGTH array, which {@link storageAt} treats as "explicitly empty" and
	 * stops the walk at). A caller handing over 32 padded bytes would write state
	 * that reads back correctly and dumps differently from the same state written
	 * by the default engine.
	 */
	setStorageAt(
		addressKey: PackedAddressKey,
		slotKey: PackedSlotKey,
		value: Uint8Array,
	): void {
		const top = this.topOverlay();
		this.recordSlotPrior(addressKey, slotKey);
		let inner = top.written.get(addressKey);
		if (inner === undefined) {
			inner = new Map();
			top.written.set(addressKey, inner);
		}
		inner.set(slotKey, value);
	}

	/**
	 * Clear one account's storage SYNCHRONOUSLY, by key — {@link clearStorage}
	 * without an `Address`, for the same synchronous-callback reason as
	 * {@link setStorageAt}. Still O(1): one `delete` plus one tombstone.
	 *
	 * NO TOMBSTONE WHEN THE TOP OVERLAY *IS* THE BOTTOM ONE, i.e. when no
	 * checkpoint is open. It is the same invariant {@link commit} keeps: a
	 * tombstone hides what overlays BELOW hold, and the bottom overlay has nothing
	 * below, so the `delete` above has already removed everything there was and the
	 * tombstone would be an entry nothing can ever remove.
	 *
	 * THIS IS THE SITE THE REVM ENGINE REACHES, and it is why the rule is here as
	 * well as in `commit()`. `runTx` checkpoints, so the DEFAULT engine's
	 * `clearStorage` on every contract creation lands three overlays deep and is
	 * pruned on the way down; `webevm/revm` commits its state changes
	 * through `src/revm-state-store.ts`'s SYNCHRONOUS callbacks with no checkpoint
	 * around them, so every CREATE on that engine clears at depth 1 and arrives
	 * straight here. Measured before this line existed: three contract creations
	 * left three permanent tombstones in the bottom overlay, one per CREATE, each
	 * of them then walked by {@link liveStorage} and therefore by every
	 * `dumpState`.
	 */
	clearStorageAt(addressKey: PackedAddressKey): void {
		const top = this.topOverlay();
		this.recordClearPrior(addressKey);
		top.written.delete(addressKey);
		if (this.storageOverlays.length > 1) top.cleared.add(addressKey);
	}

	override async getStorage(
		address: Address,
		key: Uint8Array,
	): Promise<Uint8Array> {
		return (
			this.storageAt(packAddressKey(address.bytes), packSlotKey(key)) ??
			new Uint8Array(0)
		);
	}

	override async putStorage(
		address: Address,
		key: Uint8Array,
		value: Uint8Array,
	): Promise<void> {
		this.setStorageAt(packAddressKey(address.bytes), packSlotKey(key), value);
	}

	/**
	 * Delete every storage slot belonging to `address`. O(THAT ACCOUNT) — in fact
	 * O(1): drop this overlay's own writes for it and tombstone it, which hides
	 * every overlay below. The flat layout could only prefix-scan the whole map,
	 * 14 ms at 100,000 slots, on every contract creation.
	 *
	 * Revert-safe by construction: both effects live in the TOP overlay, so a
	 * clear inside a checkpoint that is later reverted disappears with it.
	 *
	 * The parameter is OPTIONAL for an irritating reason that is itself a symptom
	 * of the upstream bug: the base class declares `clearStorage()` with ZERO
	 * parameters, and TypeScript refuses an override that ADDS a required one
	 * (TS2416). Callers reaching us through `StateManagerInterface` always pass an
	 * address, because THAT declares `clearStorage(address)`. A no-argument call
	 * keeps the base's do-nothing behaviour rather than guessing which account was
	 * meant.
	 */
	override async clearStorage(address?: Address): Promise<void> {
		if (address === undefined) return;
		this.clearStorageAt(packAddressKey(address.bytes));
	}

	/**
	 * Delete an account AND the storage that belonged to it.
	 *
	 * THE STORAGE HALF IS OURS, and it is the second gap in the same upstream
	 * shape as the `clearStorage` no-op above. `SimpleStateManager.deleteAccount`
	 * tombstones the account and never touches storage — it has no per-account
	 * index to clear with — so a `SELFDESTRUCT` (or an EIP-161 empty-account
	 * clearing) left every slot of the dead account READABLE at its address, and
	 * `dumpState` kept serialising them. Measured through the node's own surface:
	 * after a contract that writes slot 0 and selfdestructs in the same
	 * transaction, `eth_getStorageAt` answered `0x2a` in `stateMode:'none'` and
	 * `0x0` in `stateMode:'trie'`
	 * (`docs/spikes/revm-write-callbacks-reproduce-the-post-state/measurements.md`).
	 *
	 * A DELETED ACCOUNT HAS NO STORAGE, in a trie by construction: the account is
	 * removed and its storage trie goes with it, which is why
	 * `MerkleStateManager` needs no equivalent line and why `'trie'` was already
	 * right. This makes `'none'` say the same thing rather than leaving the two
	 * modes disagreeing about a destroyed contract, and it is the reason the revm
	 * engine — whose host is handed `clearStorage` then `removeAccount` for exactly
	 * these two cases, with revm's commit semantics already applied — now leaves
	 * post-state a diff cannot tell apart from `@ethereumjs/vm`'s. See
	 * `docs/adr/0007-we-override-simplestatemanagers-no-op-clearstorage.md`, whose
	 * amendment records this decision and what it changes for the DEFAULT engine.
	 *
	 * Still O(1), and revert-safe for the same reason {@link clearStorageAt} is:
	 * the tombstone lands in the TOP overlay, beside the account tombstone the base
	 * class writes into the top account frame, so both disappear together if the
	 * frame is reverted.
	 */
	override async deleteAccount(address: Address): Promise<void> {
		this.removeAccountAt(address.toString());
		this.clearStorageAt(packAddressKey(address.bytes));
	}

	/**
	 * Every live storage slot, grouped by account, flattened across the whole
	 * overlay stack — the view `dumpState` serialises.
	 *
	 * Bottom-up, applying each overlay's clears before its writes, so the result is
	 * what {@link storageAt} would answer for every key. Iteration order is
	 * insertion order (accounts in first-write order, slots likewise), which is the
	 * order the flat map produced, so the serialised `dumpState` output is
	 * byte-identical to the pre-overlay node's for the same state.
	 *
	 * THE KEYS COME BACK AS `0x`-HEX, not as the packed keys the overlays hold.
	 * This is the boundary where the internal format stops: `dumpState` output is
	 * PERSISTED data (IndexedDB, `loadState` fixtures) with existing state behind
	 * it, and `test/storage-overlay.spec.ts` asserts it byte-identical — key order
	 * included — against a dump captured before the layout ever changed. So the
	 * conversion lives here, on the dump path, rather than costing every read.
	 *
	 * O(live slots) and allocating, so it is a dump/persist operation, not a read
	 * path. Read one slot with {@link storageAt}.
	 */
	liveStorage(): Map<HexKey, Map<HexKey, Uint8Array>> {
		const out = new Map<HexKey, Map<HexKey, Uint8Array>>();
		for (const overlay of this.storageOverlays) {
			for (const address of overlay.cleared)
				out.delete(unpackAddressKey(address));
			for (const [address, inner] of overlay.written) {
				const addressHex = unpackAddressKey(address);
				let target = out.get(addressHex);
				if (target === undefined) {
					target = new Map();
					out.set(addressHex, target);
				}
				for (const [slot, value] of inner)
					target.set(unpackSlotKey(slot), value);
			}
		}
		return out;
	}

	/**
	 * An INDEPENDENT copy. Overlays are cloned two levels deep (the stack, each
	 * overlay's outer map and each inner map), because the copy's overlays are not
	 * this object's: sharing an inner map would let a write on the copy land in
	 * this manager's committed state.
	 *
	 * CHANGE-SET RECORDING IS NOT COPIED: the copy starts with it off. A copy's
	 * writes are not this node's blocks.
	 */
	override shallowCopy(): OverlayStorageStateManager {
		const copy = new OverlayStorageStateManager({common: this.common});
		copy.accountStack = this.accountStack.map((m) => new Map(m));
		copy.codeStack = this.codeStack.map((m) => new Map(m));
		copy.storageOverlays = this.storageOverlays.map((overlay) => {
			const written = new Map<
				PackedAddressKey,
				Map<PackedSlotKey, Uint8Array>
			>();
			for (const [address, inner] of overlay.written)
				written.set(address, new Map(inner));
			return {written, cleared: new Set(overlay.cleared)};
		});
		return copy;
	}
}
