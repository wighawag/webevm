---
title: Benchmark what computeStateRoot costs over a plain node
slug: computestateroot-cost-benchmark
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: [rename-statemode-to-computestateroot]
covers: [7]
---

> FORWARD-POINTER (conductor, 2026-09-28): the gate's `pnpm test` includes `packages/benchmarks`, whose `bundle size per backend` test pins the default entry's size (`DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts`). Any growth in `packages/webevm/src` core fails it. If your change grows the core bundle, re-pin it in the same change after `pnpm build`, with a history entry at the top of the RE-PINNED list saying what grew and why, as `state-change-set-capture` and `state-history-point-reads` did. Run the FULL verify (`pnpm format:check && pnpm build && pnpm test`), not only the webevm suite.

## What to build

Show, with numbers, that `computeStateRoot: true` costs a plain node's execution plus a per-block root update proportional to what the block changed, and nothing per opcode.

Add rows to the `webevm-benchmarks` package (`packages/benchmarks`) for the webevm backend with `computeStateRoot: true`, on both engines, beside the existing plain rows, on the same scenario. Report per-transaction and per-block cost, and the root-update cost as a function of keys changed per block (at least three sizes).

The benchmark suite is also a cross-backend GAS GATE: adding rows must not change what the existing rows compare (see ADR 0010's amendment for why widening it is handled carefully).

## Acceptance criteria

- [ ] New benchmark rows run and report; existing rows and the gas gate are unchanged.
- [ ] The README's state-root section states the measured cost, with the figures' source.
- [ ] If the per-block root update turns out to dominate for a realistic game block (say more than a few ms at a few hundred changed slots), that is recorded as an observation in `work/notes/observations/` rather than optimised in this task.

## Blocked by

- `rename-statemode-to-computestateroot`

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/benchmarks`, and the repo README). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md`, the done tasks of that spec, `packages/benchmarks/README.md`, and ADR 0010 with its amendment (measurement conventions and why the suite is a gas gate).

Goal: honest numbers for the option's cost.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Benchmarks can be long: give them an explicit timeout and do not run them in parallel with other heavy work. Done: rows report, gate unchanged, README updated.
