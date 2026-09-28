---
title: State history survives dumpState / loadState and a page reload
slug: state-history-persistence
spec: bounded-state-history
blockedBy: [historical-eth-call]
covers: [15, 16, 17]
---

## What to build

`dumpState` carries the retained history and `loadState` restores it, so a reloaded node (including through IndexedDB persistence) serves the same window.

- `SerializedState` gains an OPTIONAL `history` field: the sealed per-block records, hex-encoded like the rest of the dump (an account as RLP or `null` for absent, code as hex, slot values as hex, cleared markers). The format stays `version: 1`. A node without `stateHistory` writes no field.
- On load: an old dump (no field) loads with history starting at the loaded head; a dump with MORE history than the loading node's N is truncated to N; one with less serves what it has; a node without `stateHistory` ignores the field.
- The open record is cleared at the end of `loadState` (already done by `state-change-set-capture`; keep it true with history restored).
- Persistence saves it alongside state on every save that already happens; nothing new triggers a save.

## Acceptance criteria

- [ ] Dump a node with history, load it into a fresh node with the same N: every historical read (point reads and `eth_call`) at every K in the window answers identically. On both engines.
- [ ] The existing IndexedDB reload spec (`test/persistence-reload.spec.ts` and its revm twin) is extended so a historical read after the real page reload matches the one before it.
- [ ] An old dump (for example the existing flat-layout fixture) still loads, with history starting at its head.
- [ ] A larger window truncates on load; a smaller one serves what the dump has; a node without the option ignores the field.
- [ ] `test/storage-overlay.spec.ts`'s byte-identical dump assertion still passes for a node without history (the format is additive).

## Blocked by

- `historical-eth-call` (both edit the dump/load and history paths in `src/node.ts`; serialised to avoid conflicts)

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`). Read `work/specs/tasked/bounded-state-history.md` and the three done tasks before this one. Read `dumpState` / `loadState` in `src/node.ts`, `SerializedState` in `src/types.ts`, `src/persistence.ts`, and the reload specs (`test/persistence-reload.spec.ts`, `test/revm-persistence-reload.spec.ts`).

Goal: an additive, backward-compatible `history` field in the dump. Decided with the user: history survives a reload, and changing the dump is acceptable (it stays `version: 1` because the field is optional).

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
