/**
 * derived-trie.ts: the Merkle-Patricia trie a `stateMode:'trie'` node DERIVES
 * from its flat state, and nothing else.
 *
 * Every node runs on ONE state representation: the flat
 * `OverlayStorageStateManager` (./state-manager.ts). A node in trie mode
 * ADDITIONALLY keeps this object, which mirrors that state as a real Ethereum
 * state trie so the node can report a real state root. The decision and what it
 * replaced (`MerkleStateManager` as the node's state manager) are in
 * `docs/adr/0014-the-trie-is-derived-from-the-flat-state-not-a-state-manager.md`.
 *
 * ## The shape, which is Ethereum's
 *
 * - ONE account trie, keyed by `keccak(address)` (the trie hashes the key
 *   itself: `useKeyHashing`), whose value is `RLP([nonce, balance, storageRoot,
 *   codeHash])`.
 * - ONE storage trie per account, keyed by `keccak(slot)`, whose value is
 *   `RLP(value)` with the value in shortest form; a zero value is ABSENT.
 * - An account's `storageRoot` is taken from ITS storage trie at the moment the
 *   account is written into the account trie. The flat state's own `Account`
 *   objects never carry a real `storageRoot` (`SimpleStateManager` has no trie),
 *   and that is deliberate: the collision rule every engine applies reads it, and
 *   every node follows the reference spec there (see the ADR).
 *
 * ## The flat state is the source, the change set is the index
 *
 * {@link DerivedStateTrie.build} reads the WHOLE flat state once (at
 * construction, after the genesis baselines, and at the end of `loadState`).
 * From then on {@link DerivedStateTrie.apply} takes a change set (the open record
 * of ./state-manager.ts) and uses it ONLY AS A LIST OF KEYS: every value is read
 * from the flat state as it stands now, never from the record, whose values are
 * the PRIOR ones. That makes `apply` idempotent, which is what lets the node
 * apply the open record for a `getStateRoot()` between blocks and again, as part
 * of the block's record, when the next block is mined.
 *
 * A storage CLEAR (`storageCleared`) replaces the account's storage trie with an
 * empty one before its named slots are re-read: the clear recorded every slot
 * the account held and every later write records its own slot, so the slots the
 * record names are a superset of what can be live afterwards.
 *
 * ## It never runs during execution
 *
 * Both entry points require NO checkpoint to be open (they read the bottom of
 * the flat state's stacks) and the node calls them only at the end of a mined
 * block and inside `getStateRoot()`, both inside the serialisation point. The
 * trie is async (`@ethereumjs/mpt`), and that costs no opcode anything because
 * no engine ever reads it: this is why revm can run in trie mode.
 *
 * ## Old nodes are pruned
 *
 * Each trie has its OWN in-memory database and runs with `useNodePruning`, so a
 * node replaced by a write is deleted rather than retained. The node reports the
 * root of its head and nothing older (history is `stateHistory`'s undo log, not
 * old tries), so a retained node could never be read again; keeping them would
 * make a long-lived in-browser node's memory grow with every block. A dropped
 * storage trie (account deleted, storage cleared) is simply released.
 */
import {MerklePatriciaTrie} from '@ethereumjs/mpt';
import {RLP} from '@ethereumjs/rlp';
import type {Common} from '@ethereumjs/common';
import {Account, equalsBytes, hexToBytes, unpadBytes} from '@ethereumjs/util';
import type {
	ChangeSet,
	OverlayStorageStateManager,
	PackedAddressKey,
} from './state-manager.js';
import {
	packAddressKey,
	packedKeyBytes,
	unpackAddressKey,
} from './storage-keys.js';

/**
 * How many {@link DerivedStateTrie} objects this module has ever created. TEST
 * ONLY: it is how `'none'` mode is PROVEN to do no trie work (not one is created
 * by a node that does not compute roots), which a flag on the node could only
 * claim.
 */
let created = 0;

/** See {@link created}. Not exported from `src/index.ts`. */
export function derivedTriesCreatedForTests(): number {
	return created;
}

export class DerivedStateTrie {
	private readonly accounts: MerklePatriciaTrie;
	/** Only accounts whose storage is non-empty have an entry. */
	private readonly storage = new Map<PackedAddressKey, MerklePatriciaTrie>();

	private constructor(
		private readonly flat: OverlayStorageStateManager,
		private readonly common: Common,
	) {
		created++;
		this.accounts = this.newTrie();
	}

	/**
	 * Build the trie from the WHOLE flat state. O(state), paid once per
	 * construction or load, never per block.
	 */
	static async build(
		flat: OverlayStorageStateManager,
		common: Common,
	): Promise<DerivedStateTrie> {
		const trie = new DerivedStateTrie(flat, common);
		trie.requireNoCheckpoint('build');
		// Storage first, so every account is written with its final storageRoot.
		// The bottom overlay IS committed storage and holds no tombstones
		// (./state-manager.ts), so its `written` map is the whole of it.
		for (const [addressKey, slots] of flat.storageOverlays[0].written) {
			const st = trie.newTrie();
			for (const [slotKey, value] of slots)
				await putSlot(st, packedKeyBytes(slotKey), value);
			if (!isEmptyTrie(st)) trie.storage.set(addressKey, st);
		}
		for (const [addressHex, account] of flat.accountStack[0])
			if (account !== undefined) await trie.writeAccount(addressHex);
		return trie;
	}

	/**
	 * Bring the trie up to date with every key `changes` names, reading each
	 * key's CURRENT value from the flat state. Idempotent. O(keys named).
	 */
	async apply(changes: ChangeSet): Promise<void> {
		this.requireNoCheckpoint('apply');
		const dirty = new Set<string>();
		for (const addressHex of changes.accounts.keys()) dirty.add(addressHex);
		for (const addressHex of changes.code.keys()) dirty.add(addressHex);
		for (const addressKey of changes.storageCleared) {
			this.storage.delete(addressKey);
			dirty.add(unpackAddressKey(addressKey));
		}
		for (const [addressKey, slots] of changes.storage) {
			const st = this.storage.get(addressKey) ?? this.newTrie();
			for (const slotKey of slots.keys()) {
				const value = this.flat.storageAt(addressKey, slotKey);
				await putSlot(st, packedKeyBytes(slotKey), value);
			}
			if (isEmptyTrie(st)) this.storage.delete(addressKey);
			else this.storage.set(addressKey, st);
			dirty.add(unpackAddressKey(addressKey));
		}
		for (const addressHex of dirty) await this.writeAccount(addressHex);
	}

	/** The state root: the account trie's root. */
	root(): Uint8Array {
		return this.accounts.root();
	}

	/**
	 * Write one account into the account trie as the flat state holds it now,
	 * with its `storageRoot` from its storage trie, or delete it when the flat
	 * state has none.
	 */
	private async writeAccount(addressHex: string): Promise<void> {
		const key = hexToBytes(addressHex as `0x${string}`);
		const account = this.flat.accountStack[0].get(addressHex as `0x${string}`);
		if (account === undefined) {
			await this.accounts.del(key);
			return;
		}
		const st = this.storage.get(packAddressKey(key));
		const derived = new Account(
			account.nonce,
			account.balance,
			st === undefined ? undefined : st.root(),
			account.codeHash,
		);
		await this.accounts.put(key, derived.serialize());
	}

	private newTrie(): MerklePatriciaTrie {
		return new MerklePatriciaTrie({
			useKeyHashing: true,
			useNodePruning: true,
			common: this.common,
		});
	}

	/**
	 * The trie reads the BOTTOM of the flat state's stacks, which is committed
	 * state only while no checkpoint is open. Anything else would put a
	 * mid-execution state into the root, so it is refused rather than guessed at.
	 */
	private requireNoCheckpoint(what: string): void {
		if (
			this.flat.accountStack.length !== 1 ||
			this.flat.storageOverlays.length !== 1
		)
			throw new Error(
				`webevm: the derived state trie was asked to ${what} with a checkpoint ` +
					'open; a state root is computed only between executions.',
			);
	}
}

/** One slot into a storage trie: shortest form, RLP-encoded; zero deletes. */
async function putSlot(
	trie: MerklePatriciaTrie,
	slot: Uint8Array,
	value: Uint8Array | undefined,
): Promise<void> {
	const short = value === undefined ? undefined : unpadBytes(value);
	if (short === undefined || short.length === 0) await trie.del(slot);
	else await trie.put(slot, RLP.encode(short));
}

function isEmptyTrie(trie: MerklePatriciaTrie): boolean {
	return equalsBytes(trie.root(), trie.EMPTY_TRIE_ROOT);
}
