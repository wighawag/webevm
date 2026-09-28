---
title: A genesisTimestamp option pins block 0's timestamp
slug: a-genesis-timestamp-option
blockedBy: []
covers: []
---

## What to build

A new optional `createNode` option, `genesisTimestamp?: bigint` (seconds since the epoch, the same unit and type as `BlockEnv.timestamp` and the header field), that sets the timestamp of the genesis block (block 0). Absent means today's behaviour: block 0 is stamped with the wall clock in whole seconds.

Why: genesis is the one block a consumer cannot pin today. `blockEnv` deliberately leaves genesis's `number`, `timestamp` and `gasLimit` alone (documented on `NodeOptions.blockEnv` and at the genesis block in `src/node.ts`), because `blockEnv` is a knob that pins every MINED block's environment to one fixed value, built to replay a GeneralStateTest `env`. Stretching it to genesis would mean every block including genesis carries the same timestamp, which is wrong for a real chain. A separate option keeps `blockEnv`'s meaning intact. The practical consequence of the gap: two nodes running the same chain produce different block hashes whenever they are created in different seconds (it made `test/helpers/state-history.ts` and `test/helpers/state-history-transports.ts` flaky; both now compare state only, via `stateOfDump`).

Scope:

- The option on `NodeOptions` (`src/types.ts`) with JSDoc stating what it does, its unit, that absent means wall clock, and that it is independent of `blockEnv` (which still does not touch genesis).
- Validation at construction, refusing loudly in the style of the other options (see how `stateHistory` is validated in `src/node.ts`): it must be a non-negative bigint; anything else throws naming the option and what it got.
- It passes through `createWorkerNode` / `exposeNode` like every other option (a bigint structured-clones).
- Genesis is already stored in the dump, so `dumpState` / `loadState` need no change; confirm it with a test rather than assuming it.
- Do NOT change how MINED blocks are stamped (wall clock, or `blockEnv.timestamp`). That mined timestamps can equal or precede their parent's is a separate, recorded observation (`work/notes/observations/2026-09-28-mined-block-timestamps-are-not-strictly-increasing.md`), not this task. Note in the JSDoc that a `genesisTimestamp` in the future does not move mined blocks, which keep the wall clock.

## Acceptance criteria

- [ ] With `genesisTimestamp: T`, `eth_getBlockByNumber('0x0')` reports timestamp T, and a contract reading `TIMESTAMP` in an `eth_call` pinned to block 0 (on a node with `stateHistory`, or at the head while block 0 is the head) sees T. Tested on both engines (the harness `cut.ts` / `cut-revm.ts` pattern).
- [ ] Two nodes created with the same options including `genesisTimestamp` (and a pinned `blockEnv.timestamp` so the mined blocks match), in DIFFERENT seconds (force the gap in the test), produce byte-identical `dumpState`s after the same chain, block hashes included.
- [ ] Without the option, block 0 still uses the wall clock (asserted loosely, within a window around the test's own clock).
- [ ] Invalid values (a number instead of a bigint, a negative bigint, a string) throw at construction with a message naming `genesisTimestamp`.
- [ ] The option survives a `dumpState` / `loadState` round trip (the genesis block keeps T) and reaches a worker-hosted node (`createWorkerNode`).
- [ ] README: the option is documented where the other genesis options (`initialBalances`, `initialState`) are, one line per paragraph.
- [ ] A `minor` changeset describing the new option.
- [ ] The full verify (`pnpm format:check && pnpm build && pnpm test`) is green on chromium and webkit.

## Blocked by

None: can start immediately.

## Prompt

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): does it still match the code? If genesis can already be pinned some other way, route the task to needs-attention with the discrepancy as the reason (WORK-CONTRACT.md "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions you make while building, DURABLY and LINKED from the done record: an ADR in `docs/adr/` when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a JSDoc at the choice site, a `## Decisions` block in the done record, or a dated observation under `work/notes/observations/`. An un-recorded in-scope decision is a review finding.

You are working in webevm (`packages/webevm`), an in-browser EIP-1193 Ethereum node with two engines (the default `@ethereumjs/evm` and revm through `webevm/revm`). The genesis block is created in `createNodeWithInternals` in `src/node.ts` (search for `// Genesis block.`); read the comment there and the JSDoc of `NodeOptions.blockEnv` in `src/types.ts` first. Test through the public surface with the harness pattern in `test/helpers/cut.ts` / `cut-revm.ts` (a mode per battery, a spec per cut; `test/state-history.spec.ts` is a recent example).

The gate's `pnpm test` includes `packages/benchmarks`, whose `bundle size per backend` test pins the default entry's size (`DEFAULT_ENTRY_BASELINE` in `packages/benchmarks/test/evm.spec.ts`). If your change grows that bundle, re-pin it in the same change after `pnpm build`, with a history entry at the top of the RE-PINNED list saying what grew and why.

Command cost rules: put `timeout` in front of any shell command whose cost you have not reasoned about and cap output with `head`; never run an unbounded regex over `dist`, `node_modules`, `.git`, wasm or minified files. No em dash characters in anything you write. Markdown prose is one line per paragraph. Done means: the acceptance criteria pass, the full playwright suite is green on chromium and webkit, and prettier is clean.
