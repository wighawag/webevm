---
title: Document state history, and prove it through the Worker and serveOn
slug: state-history-docs-and-worker
spec: bounded-state-history
blockedBy: [state-history-persistence]
covers: [19, 20]
---

## What to build

Close out the feature for consumers.

- **Worker and ports:** `stateHistory` passes through `exposeNode` / `createWorkerNode` like every other option, and historical reads work over a port handed to `node.serveOn(port)` exactly as through `node.request`. Both should already hold by construction (options pass through unchanged; `serveOn` relays the serialised `request`); this task PROVES it with a test rather than assuming it.
- **README:** replace the "State reads are served at the head only" section with one that states both behaviours (head only by default; the window with `stateHistory`), the refusal beyond the window, and the COST, measured rather than guessed: memory per changed key per retained block, and a historical `eth_call`'s cost proportional to the number of keys changed since K. Give a sizing example for a game (N blocks at M changed slots per block). Update the RPC table rows that say "at the head only".
- **Changeset:** a `minor` changeset describing the option.

## Acceptance criteria

- [ ] A test issues historical reads through a worker-hosted node and through a `serveOn` port and gets the same answers as `node.request` on the same chain.
- [ ] The README section and table rows match the behaviour; the cost figures come from a measurement recorded under `docs/spikes/bounded-state-history-cost/` (script plus results), referenced from the README.
- [ ] A changeset exists.
- [ ] No em dash characters; prose paragraphs are single lines.

## Blocked by

- `state-history-persistence`

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code in `tasks/done/`, the relevant ADRs, and the tasks it depends on? If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm` and the repo-root README). Read `work/specs/tasked/bounded-state-history.md`, the four done tasks before this one, and the ADR written for the feature. Read `src/worker-host.ts`, `src/worker-client.ts` and `serveOn` in `src/node.ts`, and the existing worker and serve-on-port specs for the harness pattern.

Goal: prove the transports, document the feature with measured costs, add the changeset.

Command cost rules: `timeout` in front of any shell command whose cost you have not reasoned about, cap output with `head`, never an unbounded regex over `dist`, `node_modules`, `.git` or minified files. No em dash characters. Done: acceptance criteria pass, full playwright suite green on chromium and webkit, prettier clean.
