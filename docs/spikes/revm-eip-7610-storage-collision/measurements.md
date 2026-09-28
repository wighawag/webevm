# Does each engine refuse a creation at an address that holds storage?

Task: `spike-revm-eip-7610-storage-collision`. Probe: [`probe-storage-collision.mjs`](probe-storage-collision.mjs), run against the node's own build (`packages/webevm/dist`, built from `76d0c73`), through the public RPC surface only. It exits non-zero if any row stops matching.

```
(cd packages/webevm && pnpm build)
node docs/spikes/revm-eip-7610-storage-collision/probe-storage-collision.mjs
```

Environment: Node v24.19.0, revm-wasm 0.3.1, @ethereumjs/* 10.1.2, hardfork Cancun, measured 2026-09-28.

## Setup

The target always exists with a balance of 1 wei, so the three shapes differ in exactly one field: `storage` (slot `0x7` = 7, nonce 0, no code), `nonce` (nonce 1, no storage, no code) and `empty`. "Top" is a deployment transaction; "Inner" is `CREATE2` from a factory whose runtime stores the returned address in its slot 0. Init code deploys the single byte `0x42`. Every transaction has a 300,000 gas limit.

## Results

"created" means code `0x42` at the target; "collision" means no code at the target.

| engine @ mode | case | outcome | status | gasUsed | CREATE2 returned | target nonce / slot 0x7 after |
| --- | --- | --- | --- | --- | --- | --- |
| default @ none | storageTop | created | 0x1 | 53,356 | | 1 / 0 |
| default @ none | storageInner | created | 0x1 | 75,487 | target | 1 / 0 |
| default @ none | nonceTop | collision | 0x0 | 300,000 | | 1 / 0 |
| default @ none | nonceInner | collision | 0x1 | 298,346 | 0 | 1 / 0 |
| default @ none | emptyTop | created | 0x1 | 53,356 | | 1 / 0 |
| default @ none | emptyInner | created | 0x1 | 75,487 | target | 1 / 0 |
| default @ trie | storageTop | **collision** | 0x0 | 300,000 | | 0 / 7 |
| default @ trie | storageInner | **collision** | 0x1 | 298,346 | 0 | 0 / 7 |
| default @ trie | nonceTop | collision | 0x0 | 300,000 | | 1 / 0 |
| default @ trie | nonceInner | collision | 0x1 | 298,346 | 0 | 1 / 0 |
| default @ trie | emptyTop | created | 0x1 | 53,356 | | 1 / 0 |
| default @ trie | emptyInner | created | 0x1 | 75,487 | target | 1 / 0 |
| revm @ none | storageTop | created | 0x1 | 53,356 | | 1 / 0 |
| revm @ none | storageInner | created | 0x1 | 75,487 | target | 1 / 0 |
| revm @ none | nonceTop | collision | 0x0 | 300,000 | | 1 / 0 |
| revm @ none | nonceInner | collision | 0x1 | 298,346 | 0 | 1 / 0 |
| revm @ none | emptyTop | created | 0x1 | 53,356 | | 1 / 0 |
| revm @ none | emptyInner | created | 0x1 | 75,487 | target | 1 / 0 |

## What it says

1. **revm-wasm 0.3.1 does not refuse a storage-only collision**, top-level or inner. It creates the contract and WIPES the old storage (slot `0x7` reads 0 afterwards), exactly as the default engine does in `stateMode:'none'`. The two `'none'` rows are identical to the gas.
2. **It could not refuse it through this store even if it wanted to.** The store answers `getAccount` with `{balance, nonce, codeHash}` only (`src/revm-state-store.ts`); nothing tells revm an account holds storage, and revm did not ask for storage before creating. Only `@ethereumjs/evm` over `MerkleStateManager` (`stateMode:'trie'`) refuses, because there `storageRoot` is real.
3. **The nonce collision (EIP-684) is refused identically everywhere**, same status and same gas. The only disagreement anywhere in this table is `default @ trie` on the two storage rows.
4. **In webevm a storage-only account only arises from a cheat or a loaded state** (`evm_setStorageAt`, `evm_setAccount`, `initialState`, `loadState`): under Cancun (EIP-6780) `SELFDESTRUCT` keeps code and storage unless the contract was created in the same transaction, in which case both go, so execution alone does not leave storage without code.

What this means for the decision is in `work/notes/findings/storage-only-creation-collisions-are-not-refused-by-the-reference-spec.md`.
