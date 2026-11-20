/**
 * allocs.ts: the ALLOC EXPORT, a webevm dump as the genesis alloc map forge's
 * `vm.loadAllocs` accepts, so forge loads a deployment instead of replaying it.
 *
 * PURE: it reads a `SerializedState` (from `dumpState()`, a persisted dump, a
 * file) and nothing else, so a CLI calls it in Node as easily as a page does in
 * a browser. It carries STATE ONLY, which is why a chain whose transactions used
 * fabricated signatures (ADR 0002's `'trusted'` mode) exports as well as any:
 * no transaction, signature, block or receipt reaches the alloc.
 *
 * THE FORMS are what forge 1.7.1's `vm.loadAllocs` (alloy's `GenesisAccount`)
 * reads, as rocketh proved by hand from a webevm 0.9.1 dump:
 *
 * - `nonce` and `balance` are hex QUANTITIES (`0x0`, `0x1`, no leading zeros),
 *   decoded from the account's RLP `[nonce, balance, storageRoot, codeHash]`;
 * - `code` is the dump's code hex;
 * - `storage` is keyed by 32-byte `0x` slots, and its values are PADDED to 32
 *   bytes, because the dump writes them in shortest form and forge reads both
 *   sides as 32-byte words;
 * - the storage root and code hash are dropped: forge recomputes both.
 *
 * DECISIONS made here (task `devnode-alloc-export-for-forge`), each reversible
 * before 1.0:
 *
 * - EVERY ENTRY CARRIES ALL FOUR FIELDS, `code: '0x'` and `storage: {}`
 *   included, so a consumer reads one shape. Alternative: omitting empty
 *   fields, as geth's genesis files often do; forge accepts both.
 * - EVERY ACCOUNT THE DUMP HOLDS IS EXPORTED, an empty one (nonce 0, balance 0,
 *   no code, no storage) included, because an existing empty account and an
 *   absent one differ to the EVM (`EXTCODEHASH`), and the export should be the
 *   dump's state, not a reinterpretation of it. Alternative: dropping empty
 *   accounts, which a post-Spurious-Dragon chain rarely holds anyway.
 * - ADDRESSES, SLOTS AND VALUES ARE LOWERCASE, as every address webevm writes.
 * - A dump holding code or storage for an address with NO account RLP still
 *   exports it, with nonce and balance `0x0`. A dump webevm wrote never does
 *   this; a hand-edited one might, and its code is still state forge can load.
 * - A MALFORMED dump (an account that is not RLP, a slot or value longer than
 *   32 bytes, a non-hex string) THROWS a plain `Error` naming the address and
 *   field, rather than writing an alloc forge would reject or misread.
 */
import {
	bigIntToHex,
	bytesToHex,
	createAccountFromRLP,
	hexToBytes,
	setLengthLeft,
} from '@ethereumjs/util';
import type {SerializedState} from 'webevm';

/** One account in a genesis alloc, as forge's `vm.loadAllocs` reads it. */
export interface AllocAccount {
	/** The account's nonce, as a hex quantity (`0x0`, `0x1`, ...). */
	nonce: string;
	/** Its balance in wei, as a hex quantity. */
	balance: string;
	/** Its code, `0x` hex (`0x` for none). */
	code: string;
	/** Its storage, 32-byte slot to 32-byte value, both `0x` hex. */
	storage: Record<string, string>;
}

/** A genesis alloc map: lowercase address to {@link AllocAccount}. */
export type Allocs = Record<string, AllocAccount>;

const HEX = /^0x([0-9a-fA-F]{2})*$/;

function bytesOf(value: unknown, what: string): Uint8Array {
	if (typeof value !== 'string' || !HEX.test(value)) {
		throw new Error(
			`@webevm/devnode: toAllocs: ${what} is not even-length 0x hex (received ${String(value)}).`,
		);
	}
	return hexToBytes(value as `0x${string}`);
}

/** A slot or value as a 32-byte word, refusing one that does not fit. */
function word(value: unknown, what: string): string {
	const bytes = bytesOf(value, what);
	if (bytes.length > 32) {
		throw new Error(
			`@webevm/devnode: toAllocs: ${what} is longer than 32 bytes (${String(value)}).`,
		);
	}
	return bytesToHex(setLengthLeft(bytes, 32));
}

/**
 * The node's state as a genesis alloc for forge's `vm.loadAllocs`:
 *
 *   const allocs = toAllocs(await node.dumpState());
 *   writeFileSync('allocs.json', JSON.stringify(allocs));
 *   // in Solidity: vm.loadAllocs("allocs.json");
 *
 * Works on any dump (a live one, a persisted one, either engine's, either
 * sender mode's). Throws on a malformed dump, naming the address and field.
 */
export function toAllocs(state: SerializedState): Allocs {
	const allocs: Allocs = {};
	const entry = (address: string): AllocAccount =>
		(allocs[address.toLowerCase()] ??= {
			nonce: '0x0',
			balance: '0x0',
			code: '0x',
			storage: {},
		});

	for (const [address, rlp] of Object.entries(state.accounts ?? {})) {
		const bytes = bytesOf(rlp, `accounts[${address}]`);
		let account;
		try {
			account = createAccountFromRLP(bytes);
		} catch (e) {
			throw new Error(
				`@webevm/devnode: toAllocs: accounts[${address}] is not an account RLP (${(e as Error).message}).`,
			);
		}
		const out = entry(address);
		out.nonce = bigIntToHex(account.nonce);
		out.balance = bigIntToHex(account.balance);
	}
	for (const [address, code] of Object.entries(state.code ?? {})) {
		entry(address).code = bytesToHex(bytesOf(code, `code[${address}]`));
	}
	for (const [address, slots] of Object.entries(state.storage ?? {})) {
		const out = entry(address);
		for (const [slot, value] of Object.entries(slots)) {
			out.storage[word(slot, `storage[${address}] slot ${slot}`)] = word(
				value,
				`storage[${address}][${slot}]`,
			);
		}
	}
	return allocs;
}
