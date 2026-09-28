---
title: Replace stateMode with computeStateRoot (breaking, no alias)
slug: rename-statemode-to-computestateroot
spec: trie-mode-derives-its-root-from-the-flat-state
blockedBy: [trie-derived-from-the-flat-state]
covers: [1]
---

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

- `trie-derived-from-the-flat-state` (after it every node runs on the flat state, which is what makes the rename honest). Deliberately NOT blocked by `eip-7610-spec-current-in-every-mode`, which is gated on an open question and possibly an upstream release; that task is ordered AFTER this one instead and is written in the new vocabulary.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (both packages and the repo root). Read `work/specs/tasked/trie-mode-derives-its-root-from-the-flat-state.md` and the done tasks of that spec. Start with a bounded grep (`timeout 30 grep -rn stateMode packages/*/src packages/*/test README.md docs | head -200`) to enumerate the sites; do not grep `node_modules` or `dist`.

Goal: a clean, complete rename with no alias, and a changeset that tells a consumer how to migrate.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
