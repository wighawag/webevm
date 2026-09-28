---
title: decisions made while renaming stateMode to computeStateRoot
date: 2026-09-28
status: open
---

In-scope decisions from `rename-statemode-to-computestateroot`, one entry each, for the reviewer to ratify or reverse.

1. **Only `true` turns it on.** `createNode` reads `options.computeStateRoot === true`; absent, `false` and any non-boolean from untyped code leave it off, with no refusal. Documented on `NodeOptions.computeStateRoot` (`packages/webevm/src/types.ts`) and at the read in `src/node.ts`. Alternative: validate and throw on a non-boolean, as `stateHistory` does. Not chosen because it adds a new construction-time error the task did not ask for; easy to add later. Touches only this option.

2. **A leftover `stateMode` option is NOT refused.** The task says "no alias"; I read that as "not read at all", so `createNode({stateMode: 'trie'})` from untyped code comes up without a root (and `getStateRoot()` then throws `-32004`, naming `computeStateRoot: true`). The changeset states this consequence explicitly. Alternative: throw at construction when `stateMode` is present, naming the replacement. That would be a new error and a kind of compatibility shim; left for a human to choose. Touches `createNode` / `createWorkerNode` options only.

3. **`getStateRoot()`'s refusal text** is now `no state root: this node was created without computeStateRoot. Create it with computeStateRoot: true for a real Merkle-Patricia root` (code `-32004` unchanged). No test pinned the old text.

4. **`connectEngine`'s refusal text** no longer names the node's mode (`EngineContext` no longer has one): it now says `Fix the engine's configuration or pass a different engine.` The engine's own cause is still embedded verbatim.

5. **The engine-seam honesty test's stub engine** (`test/helpers/slim-node-checks.ts`) used to refuse `stateMode:'trie'` to exercise "an engine refuses a configuration it cannot serve". With the field gone from the context it now refuses a chain id other than 31337 (`test-engine-one-chain`), read off `ctx.common`. Same mechanism under test; ADR 0006 is amended to say the context is `{stateManager, common, getBlockHash}`, and `test/engine-seam.spec.ts` now pins exactly those keys.

6. **`'none'` / `'trie'` survive as TEST-LOCAL RESULT LABELS** (`c.none`, `c.trie`, `byMode`, `seededSlot0.none`, ...) meaning "without / with `computeStateRoot`", declared as `RootLabel` where a type is needed (`test/helpers/conformance.ts`, `storage-collision.ts`, `genesis-cheats-perf.ts`). Renaming every result key across ~20 specs would be churn with no consumer-visible effect; the node's option and every report field that mirrors it (`computeStateRoot: boolean`) use the new name. Alternative: rename the keys to `withoutRoot` / `withRoot`.

7. **The old-dump proof** is `test/fixtures/dumpstate-flat-layout.json` (unchanged, still carries the field) loaded by `test/storage-overlay.spec.ts`, which now also asserts the field is the ONE top-level key a fresh dump lacks. The assertion names it by value (`'none'`) so the old option's name stays only in the fixture, per the acceptance grep. `SerializedState`'s JSDoc records the removal.

8. **Historical records left as written**: `docs/spikes/**` (measurement records and probe scripts pinned to the builds they measured) still say `stateMode`, as do passing mentions in ADRs 0002, 0005 (body), 0007 (body), 0008 and 0009 (body). Dated rename notes were added at the top of ADRs 0001, 0006, 0007, 0009 and 0014 and to ADR 0005's existing supersession note, where a reader would otherwise think the option still exists. `packages/benchmarks/test/evm.spec.ts`'s RE-PINNED history entries were reworded (they are under `packages/*/test`, which the acceptance grep covers).

9. **The `state-history-transports` flake fix (forward-pointer 1)** is test-only: `stateOfDump` is now exported from `test/helpers/state-history.ts` and used by `test/helpers/state-history-transports.ts` for `sameState`, instead of comparing whole dumps. The node's genesis behaviour is unchanged. Both observations are marked resolved.

Bundle: the default entry measured 442.3 KB raw / 133.3 KB gzip, equal to `DEFAULT_ENTRY_BASELINE`, so no re-pin.
