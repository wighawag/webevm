---
title: Two remaining holes in the submit-and-mine refusal path, one of which commits state with no block
slug: two-remaining-holes-in-the-submit-and-mine-refusal-path
spec: revm-engine-behind-runtx
blockedBy: []
covers: []
---

## What to build

`replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors` made the node answer four classes of invalid transaction in its own words, with geth's clauses and a `-32000` code, identically on both engines. Gate 2 found two holes left in the same path. They share a file and a code path, so they are one task.

**1. A transaction priced below the block's base fee is still not pre-checked.** `refuseIfSenderCannotSend` covers nonce and funds only, and there is no base-fee refusal, so a transaction whose `maxFeePerGas` (or legacy `gasPrice`) is under the block's base fee still surfaces engine-shaped text, with no JSON-RPC code, differing by engine. That is exactly the divergence class the parent task removed for its four cases. It is not exotic: `baseFeePerGas` defaults to 1 gwei, so a `gasPrice: 0` transaction, or one carrying a stale fee, is an ordinary development mistake. The parent task's own comment enumerating what still reaches the engine backstop omits it, so the enumeration is incomplete as well as the check.

**2. A refused transaction in the middle of a mined BATCH commits the earlier ones and produces no block.** `mineBlock` splices `pending` before executing, and only stores the block after the loop, so a mid-batch throw leaves the earlier transactions' state changes COMMITTED and observable while no block exists to contain them, and the rest of the spliced batch is silently DROPPED rather than returned to pending. This was captured as pre-existing, and the parent task made it more reachable by moving refusals into the node itself, where they now throw mid-loop. State that exists in no block is the sharpest form of the node disagreeing with its own history.

Decide the honest resolution for 2 rather than the first that stops the symptom: either the batch is atomic (nothing commits unless the whole batch does), or a refused transaction is skipped and the batch continues without it, or the refusal happens entirely before any execution. The third is closest to what the node already does at submit, and the parent task's eager intrinsic-gas refusal is the precedent.

## Acceptance criteria

- [ ] A transaction priced below the block's base fee is refused by the NODE, in its own words, with the same `-32000` shape and the same clause style as the other refusals, identically on both engines, asserted per engine on the node's answer.
- [ ] The comment enumerating what still reaches the engine backstop is corrected to match whatever remains after this change.
- [ ] A refused transaction in a mined batch no longer leaves earlier transactions committed with no block containing them, and the surviving members of the batch are not silently dropped. The chosen resolution is recorded with the alternatives weighed.
- [ ] Both behaviours are asserted under manual/interval mining, not only auto-mining, since that is where a batch exists at all.
- [ ] Reference gas is unchanged: `number()` 2446, `sumTo(2000)` 498689, `keccakLoop(2000)` 1107052 returning `0x26812edce879c319b6c7baf99bf3c2f65aa4b81b023d72cd6dfc7ac31caafe5a`.
- [ ] If the refusal prose grows the default entry bundle, the baseline in `packages/benchmarks/test/evm.spec.ts` is re-pinned in THIS change with the reason in the comment block above it. It is never raised silently.
- [ ] A changeset: both halves change consumer-visible behaviour.

## Blocked by

- None — can start immediately.

## Prompt

> Goal: close the last two holes in the node's own refusal path, one of which can leave committed state that no block accounts for.
>
> FIRST, check this task against current reality: it was written on 2026-08-10 and may have DRIFTED. Reproduce BOTH holes before fixing either, and for the batch one assert the bad state directly (earlier transaction's balance changed, no block containing it) rather than inferring it.
>
> Read `refuseIfSenderCannotSend`, `refuseIfBelowIntrinsicGas` and `mineBlock` in `src/node.ts`, plus the decisions recorded in `docs/spikes/replayed-and-invalid-transactions-are-rejected-as-the-nodes-own-errors/measurements.md`, which pin the refusal contract you must match: geth's leading clauses, `RpcError` code `-32000`, no `data` field.
>
> Match that contract exactly for the new base-fee refusal. Those phrases are now pinned character for character in a spec and consumers branch on them, so a fifth refusal that words itself differently is a new inconsistency rather than a fix.
>
> On the batch hole, weigh the three resolutions rather than taking the first that stops the symptom. The node already refuses eagerly at submit for intrinsic gas, which is the nearest precedent in the codebase.

## Update (2026-10-27)

Since `logs-carry-their-blocks-timestamp`, the orphaned receipts hole 2 leaves behind are no longer served naming a block that does not exist: `logToRpc` looks up each log's block for its `blockTimestamp` and throws when the block is missing, so `eth_getTransactionReceipt` for an earlier transaction of a refused batch now refuses. Fixing hole 2 so no receipt is recorded without its block makes that guard unreachable again.
