---
title: Replace stateMode with computeStateRoot (breaking, no alias)
slug: rename-statemode-to-computestateroot
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: [trie-derived-from-the-flat-state]
covers: [1]
---

> FORWARD-POINTER (conductor, 2026-09-28): the gate's `pnpm test` includes `packages/benchmarks`, whose `bundle size per backend` test pins the default entry's size (`DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts`). Any growth in `packages/webevm/src` core fails it. If your change grows the core bundle, re-pin it in the same change after `pnpm build`, with a history entry at the top of the RE-PINNED list saying what grew and why, as `state-change-set-capture` and `state-history-point-reads` did. Run the FULL verify (`pnpm format:check && pnpm build && pnpm test`), not only the webevm suite.

> FORWARD-POINTER (conductor, 2026-09-28), two small items this gate needs:
>
> 1. **Fix the `state-history-transports` flake first.** `test/helpers/state-history-transports.ts` computes `sameState` by comparing WHOLE `dumpState`s of two nodes. Genesis is stamped with the wall clock in whole seconds, so two nodes created either side of a second boundary hash every block differently while holding identical state. It fails about 1 run in 4 (observations `2026-09-28-state-history-transports-sameState-flakes-on-the-genesis-timestamp.md` and `2026-09-28-state-history-transports-flake-rate-is-about-one-in-four.md`) and will bounce this gate. Apply the same test-only fix `state-history-docs-and-worker` applied to `test/helpers/state-history.ts` (`stateOfDump`: compare accounts, code, storage, history and the block count, not hashes); share the helper rather than copying it if that is simple. Do NOT change the node's genesis behaviour. Record it as a decision and set those two observations' `status` to resolved.
> 2. **Unreleased changesets are in scope of the rename.** `.changeset/*.md` entries not yet released (for example `bounded-state-history.md` and `trie-derived-from-the-flat-state.md`) ship in the SAME release as this rename, so any `stateMode` wording in them must be rewritten in the new terms, or the release notes will name an option that no longer exists.

## What to build

Once every node runs on the flat state, `stateMode: 'none' | 'trie'` no longer names a mode; it names whether a root is computed. Replace it with `computeStateRoot: boolean` (default `false`). Decided with the user: the package has no users, so this is a BREAKING change with NO compatibility alias. (`stateRoot: true` was rejected: an option named `stateRoot` reads as "pass a root".)

Every occurrence goes, not only the option:

- `NodeOptions.stateMode` becomes `computeStateRoot`; the `StateMode` type is deleted.
- `SlimNode.stateMode` becomes `SlimNode.computeStateRoot`.
- `EngineContext.stateMode` is removed from the engine seam (no engine needs it once revm serves both).
- `SerializedState.stateMode` is no longer written; a dump that still carries it loads with the field ignored.
- Error messages, the README, code comments, test names and ADR forward references that say `stateMode:'none'` / `'trie'` are rewritten in the new terms. Historical ADR text that records what was true at the time stays as written; add a short dated note where a reader would otherwise be misled.

Blast radius measured at tasking: 127 occurrences in 62 files across `packages/webevm/src`, `packages/webevm/test`, `packages/benchmarks/test`, the README and `docs/`. It lands as ONE task because, with no alias, the rename is one mechanical edit that stays green in a single commit; grep before you start and after you finish.

## Acceptance criteria

- [ ] `grep -rn stateMode` over `packages/*/src`, `packages/*/test` and the README finds nothing, EXCEPT dump fixtures under `test/fixtures/` (for example `dumpstate-flat-layout.json` carries `"stateMode": "none"` and must keep it: it is the proof that an old dump still loads) and docs/ADRs only where the history note applies.
- [ ] An old dump carrying `stateMode` still loads.
- [ ] A `minor` changeset whose entry leads with `**BREAKING (no alias):**`, the repo's pre-1.0 convention (see the 0.3.0 entry in the CHANGELOG), with the migration: `stateMode: 'trie'` becomes `computeStateRoot: true`, and `stateMode: 'none'` is simply removed.
- [ ] Full suite and the benchmarks package typecheck and pass.

## Blocked by

- `trie-derived-from-the-flat-state` (after it every node runs on the flat state, which is what makes the rename honest).

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (both packages and the repo root). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md` and the done tasks of that spec. Start with a bounded grep (`timeout 30 grep -rn stateMode packages/*/src packages/*/test README.md docs | head -200`) to enumerate the sites; do not grep `node_modules` or `dist`.

Goal: a clean, complete rename with no alias, and a changeset that tells a consumer how to migrate.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
