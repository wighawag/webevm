---
title: EIP-7610 storage collisions refused in every mode, on both engines
slug: eip-7610-spec-current-in-every-mode
spec: trie-mode-derives-its-root-from-the-flat-state
needsAnswers: true
blockedBy: [spike-revm-eip-7610-storage-collision, rename-statemode-to-computestateroot]
covers: [8]
---

<!-- open-questions -->

## Open questions

1. **Which route, if the spike finds revm-wasm does NOT refuse a storage-only collision?** Options the spike will cost: (a) an upstream fix in revm-wasm, this task then blocked on its release; (b) the revm state store presenting an account that holds storage in a way revm's existing nonce/code check refuses, with whatever that breaks. If the spike finds revm DOES refuse it on both the top-level and the inner path, answer "not needed" and clear `needsAnswers`.

<!-- /open-questions -->

## What to build

Decided with the user: creating a contract at an address that already holds storage fails with `CREATE_COLLISION` on every node (with or without `computeStateRoot`) and on both engines (EIP-7610, spec-current). Before this spec, `stateMode:'none'` cleared the storage and proceeds, because `SimpleStateManager`'s `storageRoot` never reflects storage and the default engine's guard reads `storageRoot`.

- The flat state gets a synchronous "does this account hold storage" answer (the overlay manager can give it in O(1)).
- The default engine's collision guard reads that answer instead of `storageRoot` (by presenting a non-empty `storageRoot` sentinel on such an account when the EVM asks, or by whichever seam the EVM's guard actually reads; verify against `@ethereumjs/evm@10.1.2`).
- revm follows the route decided in the open question.
- The creation-time `clearStorage` the EVM calls (ADR 0007) stays: it still matters for an address whose storage was cleared earlier in the same transaction.

This CHANGES `'none'` mode's behaviour: the changeset says so.

## Acceptance criteria

- [ ] The spike's cases (top-level CREATE and inner CREATE2 at a storage-only address) fail with a collision on both engines, in every mode; the controls behave as before.
- [ ] The post-state differential gains these cases and the two engines agree.
- [ ] The README's state-mode asymmetry paragraph and the EIP-7610 note in the `src/state-manager.ts` header are REWRITTEN (not appended to): there is no asymmetry any more.
- [ ] A changeset records the behaviour change.

## Blocked by

- `spike-revm-eip-7610-storage-collision` (the answer decides the revm route)
- `rename-statemode-to-computestateroot` (after it every node shares the flat state, so there is one guard to fix, and this task is written in the `computeStateRoot` vocabulary; it is ordered after the rename so that its open question cannot stall the rename)

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md`, the spike's finding in `work/notes/findings/` and its measurements under `docs/spikes/revm-eip-7610-storage-collision/`, ADR 0007 with its amendments, the header of `src/state-manager.ts`, and `src/revm-state-store.ts`.

Goal: one EIP-7610 behaviour everywhere, proven by the differential. Do not start until the open question is answered.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
