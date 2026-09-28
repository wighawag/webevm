---
title: A creation at a zero-nonce, code-less address that holds storage succeeds and wipes it (the reference spec), and EIP-7610 is not the direction
source: "ethereum/execution-specs PR #3508 (merged 2026-09-23 into forks/amsterdam) and issue #3635; ethereum/EIPs PR #12296 (merged 2026-09-18, EIP-8037); eips.ethereum.org/EIPS/eip-7610 (status Last Call, deadline 2024-11-20); all retrieved 2026-09-28. Engine behaviour measured the same day by docs/spikes/revm-eip-7610-storage-collision/ (revm-wasm 0.3.1, @ethereumjs/* 10.1.2)."
---

# Storage-only creation collisions: what Ethereum says, and what each engine does

## The protocol side (external, dated)

- **EIP-7610** ("revert creation in case of non-empty storage") is still **Last Call**, never Final. It asked for a collision when the target has a non-zero nonce, non-empty code, OR non-empty storage.
- **The reference spec went the other way.** execution-specs PR #3508, merged 2026-09-23, "aligns EELS with the Yellow Paper and EIP-684: contract creation over a zero-nonce, code-less account that holds storage succeeds and wipes the old storage, and EIP-161 deletion of such an account drops its storage too" (quoted from issue #3635), applied from Cancun onward.
- **Clients agreed to leave the case undefined** until **EIP-8253** (proposed for Hegotá) bumps the nonce of the 28 mainnet accounts of that shape to 1, after which EIP-684's nonce rule rejects any creation there in every client. The storage-only tests are skip-marked and produce no fixtures until then (issue #3635). Nethermind already has an EIP-8253 implementation PR (#13943).
- **EIP-8037** removed its EIP-7610 collision rules on 2026-09-18 and uses EIP-684 throughout ("a collision requires a nonzero nonce or non-empty code").

So the forward-looking rule is EIP-684 (nonce or code), with storage WIPED on creation, and the storage-only shape made unreachable on mainnet by EIP-8253 rather than refused by a storage check.

## The engine side (measured)

| | storage-only target | nonce target |
| --- | --- | --- |
| `@ethereumjs/evm`, `stateMode:'none'` | created, storage wiped | collision |
| `@ethereumjs/evm`, `stateMode:'trie'` | **collision** (EIP-7610) | collision |
| revm-wasm 0.3.1, `stateMode:'none'` | created, storage wiped | collision |

Identical gas wherever the outcome agrees. revm cannot see storage through the node's store at all (it is handed `{balance, nonce, codeHash}`), so making it refuse would need either an upstream change or the store presenting such an account falsely (a non-zero nonce or a non-empty code hash). Both false presentations are writable back by revm: a value transfer into the account would commit the fake nonce, and a fake code hash would make a CALL try to execute code that does not exist.

## Consequence for webevm

The decision recorded in `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md` (make EIP-7610 spec-current in every mode) was taken on the premise that EIP-7610 is the spec-current rule. It is not: `'none'` mode and revm already implement what the reference spec now says, and `'trie'` mode is the outlier. Once `trie-derived-from-the-flat-state` moves trie mode onto the flat state, every node gets the reference behaviour with no further work. Decided with the user on 2026-09-28: the decision is reversed. `eip-7610-spec-current-in-every-mode` is cancelled, and `trie-derived-from-the-flat-state` makes every node follow the reference spec (EIP-684, storage wiped).
