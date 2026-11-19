---
'webevm': minor
---

Prague and Osaka. `createNode()` takes a `hardfork` option, `'cancun' | 'prague' | 'osaka'`, and **defaults to `'osaka'`** (it was always Cancun). Both engines serve all three, and `webevm/revm` now admits `prague` and `osaka` (`amsterdam` is the fork it refuses).

- **Prague**: type-4 (EIP-7702) transactions execute on both engines, and `eth_call` / `eth_estimateGas` apply a request's `authorizationList` (charged 25,000 per entry, delegations applied), so an estimate executes the delegated code. EIP-7623's calldata floor is charged on receipts, a transaction whose gas limit is below it is refused with `-32000 insufficient gas for floor data gas cost`, and `eth_estimateGas` never recommends less.
- **Osaka**: EIP-7825 caps a transaction at 16,777,216 gas. A transaction above it is refused with `-32000 transaction gas limit too high`, `eth_estimateGas` never searches above it, and the default `eth_call` budget shrinks so the call fits under it. An `eth_call` whose explicit `gas` would exceed it is refused (geth lifts the cap for `eth_call`; revm cannot, so both engines hold it). Also `CLZ`, `P256VERIFY` and the re-priced `MODEXP`.
- **A type-4 transaction on Cancun** is refused with `-32000 transaction type not supported` instead of a raw parser error.

**Upgrading.** The default fork moved, so a node created without `hardfork` now runs Osaka: a transaction with a gas limit above 16,777,216 is refused, and calldata-heavy transactions cost the floor. Pass `hardfork: 'cancun'` to keep the old behaviour. `dumpState()` now records the fork and `loadState()` refuses a dump from another one; a dump without the field (every dump written before this release, and every chain persisted to IndexedDB by one) is a Cancun dump, so a node restored from one needs `hardfork: 'cancun'`, and otherwise fails at construction naming the option, leaving the stored chain untouched.
