---
title: "Spike: does revm-wasm refuse a creation at an address that holds storage (EIP-7610)?"
slug: spike-revm-eip-7610-storage-collision
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: []
covers: [8]
---

## What to build

A measurement, not a feature. EIP-7610 says a contract creation must fail with a collision when the target address has a non-zero nonce, non-empty code, OR non-empty storage. The decision (taken with the user) is to make webevm spec-current in EVERY mode, which only works if BOTH engines refuse. Find out whether each does, today, on the node's own state.

Cases, on each engine, through the node:

1. Top-level CREATE (a deployment transaction) targeting an address that holds storage only (nonce 0, no code). The address is placed with `evm_setStorageAt` at the address the deployment will get.
2. An INNER `CREATE2` from a factory, targeting an address that holds storage only.
3. Controls: the same with nonce 1 (both engines should refuse), and with an empty address (both should succeed).

Record, per engine and case: outcome (created / collision / other), receipt status, gas used, and the post-state of the address. On the default engine, record separately `stateMode:'none'` (expected: clears and proceeds, since `storageRoot` never reflects storage) and `stateMode:'trie'` (expected: collision).

For revm, also read how revm-wasm's binding presents an account to revm (`src/revm-state-store.ts`, `getAccount`): whether revm's collision check could see storage at all through this store, and what the store would have to present for the check to fire.

## Acceptance criteria

- [ ] A probe under `docs/spikes/revm-eip-7610-storage-collision/` (script plus `measurements.md` with the table above) that exits non-zero if a recorded figure changes.
- [ ] A finding in `work/notes/findings/` with a `source:` line, stating plainly: does revm-wasm refuse the storage-only collision, top-level and inner, and what the default engine does per state mode.
- [ ] If revm does NOT refuse it, the finding lists the options with their cost (an upstream fix in revm-wasm; the store presenting such an account so revm's nonce/code check fires, with what that would break), and the task `eip-7610-spec-current-in-every-mode` gets that answer added to its Open questions.

## Blocked by

None: can start immediately.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md` (the EIP-7610 decision and its risk), ADR 0007 and its amendments, the header of `src/state-manager.ts` (the EIP-7610 note), and `src/revm-state-store.ts`. Existing spikes under `docs/spikes/` show the house style for a probe plus measurements.

Goal: answer ONE question with evidence. Do not change `src/`. This is a prototype in the sense of the `prototype` skill: the answer is the deliverable.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified/wasm files (read revm-wasm's JS glue with a bounded window if you must). No em dash characters. Done: the probe runs, the finding exists, and the downstream task is updated if needed.
