# We override `SimpleStateManager`'s no-op `clearStorage`, in our own code rather than a patch

> **Renamed 2026-09-28** (`rename-statemode-to-computestateroot`): the `stateMode: 'none' | 'trie'` option is now `computeStateRoot: boolean` (default `false`), with no alias; `'trie'` below is `computeStateRoot: true` and `'none'` is a node without it. Separately, the difference between the two modes described under the collision case below is gone since [ADR 0014](0014-the-trie-is-derived-from-the-flat-state-not-a-state-manager.md): every node now succeeds and wipes the storage.

`@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage` as `async clearStorage() { }`: an empty body taking NO parameter, while the `StateManagerInterface` it implements declares `clearStorage(address: Address): Promise<void>`. `@ethereumjs/evm` calls it on every contract creation (`evm.js:555`, immediately after `journal.putAccount`) precisely to guarantee a fresh contract starts with empty storage. With the no-op, a contract created at an address that already holds storage INHERITS that storage, with a success receipt and no warning. `stateMode:'none'` is our default, so this was reachable by default: seed slot 0 with `evm_setStorageAt`, deploy a Counter that lands on that address, and `number()` returned 99 instead of 0.

We therefore ship a subclass that implements it (`src/state-manager.ts`) and use it for `stateMode:'none'`. *(That class is now called `OverlayStorageStateManager`, because it also re-layers storage — [ADR 0009](0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md). The `clearStorage` fix below is unchanged; only its cost is.)*

Reported upstream with a reproduction and a fix: issue [ethereumjs/ethereumjs-monorepo#4357](https://github.com/ethereumjs/ethereumjs-monorepo/issues/4357), PR [#4358](https://github.com/ethereumjs/ethereumjs-monorepo/pull/4358). This subclass is what protects consumers until that lands and we bump past it.

## Why a subclass and not a `pnpm patch`

A patch was the first instinct and it is the wrong tool here: it would fix only THIS repo's own test runs. `embedded-eth-node` is a LIBRARY, so a consumer installs `@ethereumjs/statemanager` through their own dependency resolution and would never see our patch. Every consumer would keep the bug while our CI went green, which is the worst combination available. The fix has to live in code we publish.

The subclass was also cheaper than it looked: `topStorageStack()` is `protected`, so a subclass reached the live frame through the API the base class already offers, with no cast and no reach past the type. *(2026-08-09: no longer how it works. ADR 0009 replaced the flat storage map itself, so the subclass owns the representation rather than reaching into upstream's, and `clearStorage` is one `delete` plus a tombstone on the top overlay.)*

One irritation worth recording, because it will confuse the next person: the override's `address` parameter is OPTIONAL. TypeScript refuses an override that adds a REQUIRED parameter the base does not declare (TS2416), and the base declares zero. So the signature is `clearStorage(address?: Address)` and a no-argument call keeps the base's do-nothing behaviour rather than guessing an account. The bug's own signature is what prevents typing the fix properly.

## Amendment, 2026-08-10: deleting an account also clears its storage

The same gap has a SECOND mouth, and this one was found by pointing a second EVM at the same state. `SimpleStateManager.deleteAccount` sets the account key to `undefined` and never touches storage — for the same reason `clearStorage` is a no-op, namely that a flat `${address}_${slot}` map has no per-account clear to call. `@ethereumjs/evm`'s journal calls exactly that for BOTH a `SELFDESTRUCT` and an EIP-161 empty-account clearing, so in `stateMode:'none'` a destroyed contract's slots stayed READABLE at its address and `dumpState` kept serialising them.

Measured through the node's own public surface, one transaction that writes slot 0 and selfdestructs in the same transaction (`docs/spikes/revm-write-callbacks-reproduce-the-post-state/`):

| configuration | slot 0 of the destroyed contract |
| --- | --- |
| `'trie'` / `@ethereumjs/vm` | `0x…00` |
| `'none'` / `@ethereumjs/vm` | **`0x…2a`** |
| `'none'` / `revm-wasm` | `0x…00` |

**So we clear storage on delete, in `OverlayStorageStateManager.deleteAccount`.** The decision is which side to move, and a trie settles it: deleting an account removes it from the trie and its storage trie goes with it, so `MerkleStateManager` needs no equivalent line and `'trie'` was already right. `revm-wasm` hands its host `clearStorage` then `removeAccount` for exactly these two cases — its own commit semantics, applied BEFORE the host is called — so it was right too. The odd one out was the DEFAULT engine in `'none'` mode. Moving revm to match it instead would have meant teaching our host to ignore what the binding documents, and re-deriving EVM rules on the host side is how a host ends up disagreeing with its engine about what a selfdestruct means.

The rejected alternative was to leave both engines as they were and narrow the post-state assertion. It was rejected because the divergence is a real one a consumer can read (`eth_getStorageAt` on a dead contract, and every `dumpState` / IndexedDB snapshot taken after a selfdestruct), and because a documented mode difference is only affordable when the mode cannot do better. Here it can: ADR 0009's per-account overlays make the clear O(1) — one `delete` plus a tombstone on the top overlay, revert-safe beside the account tombstone the base class writes — which is precisely the cost that did not exist when the flat map was the layout.

**What it changes for the DEFAULT engine**, since this is the one amendment here that is not purely additive: in `stateMode:'none'`, an account that is DELETED now takes its storage with it. A destroyed contract's slots read zero rather than their last value, and `dumpState` (hence IndexedDB persistence) no longer carries them. Nothing else moves. Asserted in `test/slim-node-checks.spec.ts` in BOTH state modes — the two modes AGREE here, unlike the EIP-7610 asymmetry below — and diffed engine-against-engine by `test/revm-post-state.spec.ts`.

One thing this deliberately does NOT do: it does not remove the account's CODE. Neither does upstream, and neither does the revm host (`removeAccount` in `src/revm-state-store.ts`), so both engines answer `eth_getCode` on a destroyed contract identically — with stale bytes, where `'trie'` mode answers `0x`. That is a separate `'none'`-mode staleness with no cross-engine consequence, captured in `work/notes/observations/none-mode-keeps-a-deleted-accounts-code.md` rather than fixed here.

## What this does NOT fix, and the mode asymmetry it leaves

The EIP-7610 collision guard directly above that call rejects creation outright when the target account has non-empty storage, and it decides by reading `account.storageRoot`. `SimpleStateManager` implements no state-root logic at all, so `storageRoot` never reflects its flat storage map and that guard CANNOT fire in `'none'` mode. Clearing is therefore the most we can do there.

The two state modes consequently differ on this case, and the difference is asserted in `test/slim-node-checks.spec.ts` so it cannot drift unnoticed:

- **`stateMode:'none'`** clears the storage and the creation SUCCEEDS. That is pre-EIP-7610 semantics, and exactly what the EVM's own call asks for.
- **`stateMode:'trie'`** computes a real `storageRoot`, so the guard fires and the creation is REJECTED with `CREATE_COLLISION`. That is the spec-current behaviour, and it needs no fix from us.

Neither mode inherits storage, which is the property that matters. They are not identical to each other, and we accept that rather than fake a `storageRoot` on accounts in `'none'` mode: a sentinel non-empty root would make the guard fire, but it would also lie to `dumpState`, to persistence, and to anything else that reads the field, in a mode whose whole premise (ADR 0001) is that there is no root. A documented asymmetry in a trie-less mode is a smaller cost than a fabricated hash.

`stateMode:'trie'` remains the conformance-testable mode, and this is one more instance of the general rule already stated in ADR 0001: `'none'` is fast and non-conformant in specified, documented ways.

## Cost

> **No longer applies, as of 2026-08-09 — [ADR 0009](0009-none-mode-storage-is-per-account-with-per-checkpoint-overlays.md).** Storage is per-account with per-checkpoint overlays, so `clearStorage` is O(that account): one `delete` plus a tombstone, measured at 0.55 microseconds at every state size, against 17,458 microseconds at 100,000 slots for the prefix scan described below. The paragraph is kept because it is the reasoning that pointed at the fix.

`clearStorage` here is O(total storage), because `SimpleStateManager` keys storage in ONE flat map as `${address}_${slot}` with no per-account index. A create or a `SELFDESTRUCT` is rare next to a read, so this is acceptable, but it is the same flat-layout cost ADR 0005 records for revm's `clearStorage` requirement (which must be O(that account)). Both point at the same eventual fix, a per-account storage layout, which `revm-engine-behind-runtx` will have to decide on for its write half.

## Removing this later

When upstream fixes it and we bump past the fixed version, this PART of the subclass can go — but the subclass itself stays, because ADR 0009 gave it a second job (the storage representation) that upstream has no equivalent for.

The original wording, for the record: when upstream fixes it and we bump past the fixed version, this subclass can go, and the `'none'` branch can construct `SimpleStateManager` directly again. The test in `slim-node-checks` is what tells you it is safe: it asserts the BEHAVIOUR through the node's public surface, not our class, so it keeps passing if upstream's own implementation is correct. Do not delete the test with the subclass.
