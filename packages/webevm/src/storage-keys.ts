/**
 * storage-keys.ts: the node's STORAGE KEY encoding (on every node), and the
 * ONE place either side of it is allowed to build a key.
 *
 * A storage key here is **PACKED**: two bytes per UTF-16 code unit, so an
 * address is 10 code units and a slot is 16, rather than the 42- and
 * 66-character `0x`-hex strings the node used to build. It is `revm-wasm`'s own
 * `MemoryStore` encoding, adopted for the reason it exists there.
 *
 * ## Why, with the number
 *
 * A cold revm storage access with the `0x`-hex key was 1.21-1.33 µs through the
 * real wasm module, and **83-87% of that was JS-side key handling**, not the wasm
 * crossing (0.17-0.20 µs). Per-account NESTING recovers none of it (the cost is
 * building hex at all, not concatenating it). This encoding takes the access to
 * **0.36-0.39 µs: 70-73% recovered**, measured against the SHIPPED store, arm for
 * arm, in `docs/spikes/revm-state-store-packed-storage-keys/measurements.md`. The
 * question was first asked, of four candidate stores, in
 * `docs/spikes/spike-storage-layout-cost-for-the-revm-write-half/measurements.md`
 * (Q4), which predicted 50% from a prototype.
 *
 * The win was only available once the NODE owned the representation, which it
 * does as of ADR 0009; before that the key format was `SimpleStateManager`'s and
 * had to be reproduced byte for byte (ADR 0005).
 *
 * ## THE DANGEROUS FAILURE IS TWO KEY FORMATS THAT BOTH WORK
 *
 * `@ethereumjs/evm` writes storage through the ASYNC `putStorage`; revm reads it
 * through the SYNCHRONOUS `storageAt`. If those two disagreed about the key,
 * every read would be a MISS — and a miss reads as ZERO, not as an error, and
 * costs identical gas, so neither the cross-backend gas gate nor any receipt
 * diff could see it. That is why this module exists at all instead of two
 * private helpers: `src/state-manager.ts` (the async half, plus `dumpState`'s
 * view) and `src/revm-state-store.ts` (the synchronous half) both import THESE
 * functions, so the two formats cannot drift without an edit that is visible
 * here. `test/helpers/revm-storage-keys.ts` then asserts the agreement end to
 * end, in both directions, on a real slot.
 *
 * ## Fixed width, and why it is not a generic "pack any bytes"
 *
 * A length-agnostic pack is NOT injective: a 31-byte key and the 32-byte key
 * with a trailing zero byte produce the same string, i.e. two different slots
 * would silently become one. So the two encoders take a FIXED width (20 bytes
 * for an address, 32 for a slot) and NORMALISE anything else by left-padding it
 * to that width rather than encoding it ambiguously. Normalising is safe and
 * unreachable in practice: `@ethereumjs/evm` always hands over a 32-byte slot
 * key, every caller in `src/node.ts` pads to 32 first, and `MerkleStateManager`
 * (which trie mode, as it was then called, ran on) REFUSES a key that is not 32 bytes at all, so a short
 * key names the slot it obviously means instead of an unreadable one.
 *
 * ## What this is NOT the key format for
 *
 * ACCOUNTS and CODE. Those live in `SimpleStateManager`'s own `accountStack` /
 * `codeStack`, keyed `address.toString()` (`0x`-prefixed lowercase hex), and
 * that format is upstream's to dictate — ADR 0005's "reproduce it byte for byte"
 * still applies there, unchanged.
 *
 * The SERIALISED format is not this either. `dumpState` / `loadState` output is
 * persisted data (IndexedDB, `loadState` fixtures) and stays `{address: {slot:
 * value}}` in `0x`-hex: {@link OverlayStorageStateManager.liveStorage} converts
 * back through {@link unpackAddressKey} / {@link unpackSlotKey} on the way out,
 * and `test/storage-overlay.spec.ts` asserts the dump byte-identical against a
 * fixture captured from the pre-overlay build. The internal key moves under that
 * format; the format does not move.
 */
import {setLengthLeft} from '@ethereumjs/util';

/** One byte as two lowercase hex digits, for the dump-path conversions below. */
const HEX_BYTE = /* @__PURE__ */ (() => {
	const t: string[] = [];
	for (let i = 0; i < 256; i++) t.push(i.toString(16).padStart(2, '0'));
	return t;
})();

/** An account's storage key: 10 UTF-16 code units, two address bytes each. */
export type PackedAddressKey = string;
/** A slot's storage key: 16 UTF-16 code units, two slot bytes each. */
export type PackedSlotKey = string;
/** `0x`-prefixed lowercase hex — the SERIALISED (dumpState) form of either. */
export type HexKey = string;

/**
 * The storage key for an account, from its 20 address bytes.
 *
 * Takes the BYTES rather than an `Address` on purpose: the synchronous revm
 * store is handed revm's own 20-byte scratch buffer and must not have to
 * construct anything to build a key. Pass `address.bytes` from the async side.
 */
export function packAddressKey(address: Uint8Array): PackedAddressKey {
	if (address.length !== 20) return packAddressKey(setLengthLeft(address, 20));
	return String.fromCharCode(
		(address[0] << 8) | address[1],
		(address[2] << 8) | address[3],
		(address[4] << 8) | address[5],
		(address[6] << 8) | address[7],
		(address[8] << 8) | address[9],
		(address[10] << 8) | address[11],
		(address[12] << 8) | address[13],
		(address[14] << 8) | address[15],
		(address[16] << 8) | address[17],
		(address[18] << 8) | address[19],
	);
}

/** The storage key for one slot, from its 32 key bytes. */
export function packSlotKey(slot: Uint8Array): PackedSlotKey {
	if (slot.length !== 32) return packSlotKey(setLengthLeft(slot, 32));
	return String.fromCharCode(
		(slot[0] << 8) | slot[1],
		(slot[2] << 8) | slot[3],
		(slot[4] << 8) | slot[5],
		(slot[6] << 8) | slot[7],
		(slot[8] << 8) | slot[9],
		(slot[10] << 8) | slot[11],
		(slot[12] << 8) | slot[13],
		(slot[14] << 8) | slot[15],
		(slot[16] << 8) | slot[17],
		(slot[18] << 8) | slot[19],
		(slot[20] << 8) | slot[21],
		(slot[22] << 8) | slot[23],
		(slot[24] << 8) | slot[25],
		(slot[26] << 8) | slot[27],
		(slot[28] << 8) | slot[29],
		(slot[30] << 8) | slot[31],
	);
}

/** `0x` + 40 hex digits, i.e. exactly what `address.toString()` would give. */
export function unpackAddressKey(key: PackedAddressKey): HexKey {
	return unpack(key);
}

/** `0x` + 64 hex digits, i.e. exactly what `bytesToHex(slot32)` would give. */
export function unpackSlotKey(key: PackedSlotKey): HexKey {
	return unpack(key);
}

/**
 * The RAW BYTES a packed key encodes (20 for an account, 32 for a slot): the
 * inverse of {@link packAddressKey} / {@link packSlotKey} without the hex
 * detour. For the derived trie (`src/derived-trie.ts`), which keys its tries by
 * the raw address and slot and reaches them from the change set's packed keys.
 * Allocates, so it is a per-changed-key cost, never a read path.
 */
export function packedKeyBytes(
	key: PackedAddressKey | PackedSlotKey,
): Uint8Array {
	const out = new Uint8Array(key.length * 2);
	for (let i = 0; i < key.length; i++) {
		const c = key.charCodeAt(i);
		out[2 * i] = c >>> 8;
		out[2 * i + 1] = c & 0xff;
	}
	return out;
}

/**
 * The inverse of the two encoders, for the dump path ONLY — it allocates a
 * string per key and is O(live slots) over a whole dump. Read one slot with
 * `storageAt()`; never round-trip a key through here to read it.
 */
function unpack(key: string): HexKey {
	let s = '0x';
	for (let i = 0; i < key.length; i++) {
		const c = key.charCodeAt(i);
		s += HEX_BYTE[c >>> 8] + HEX_BYTE[c & 0xff];
	}
	return s;
}
