---
'webevm': minor
---

**BREAKING (no alias):** `stateMode: 'none' | 'trie'` is replaced by `computeStateRoot: boolean` (default `false`). Every node now runs on the same flat state (see the entry on the derived trie), so the option no longer selects a mode; it only decides whether the node also derives a Merkle-Patricia trie and reports a real state root. There is no compatibility alias: an old `stateMode` option is not read at all, so a node passed `stateMode: 'trie'` from untyped code comes up WITHOUT a root and `getStateRoot()` throws.

Migrating:

```diff
-createNode({stateMode: 'trie'});
+createNode({computeStateRoot: true});

-createNode({stateMode: 'none'});
+createNode();
```

- `stateMode: 'trie'` becomes `computeStateRoot: true`; `stateMode: 'none'` is simply removed (it was the default and still is).
- `node.stateMode` (on `createNode()` and `createWorkerNode()` nodes alike) becomes `node.computeStateRoot`, a boolean.
- The `StateMode` type is no longer exported.
- `EngineContext.stateMode` is removed from the engine seam: no engine needs to know whether the node computes a root, since revm now serves both. A custom `Engine` that read `context.stateMode` in `connect` should stop reading it.
- `getStateRoot()` on a node without the option still throws `-32004`; the message now names `computeStateRoot: true` as the fix.
- `dumpState` no longer writes the informational `stateMode` field. A dump that still carries it (every dump written by an earlier version) loads unchanged, with the field ignored, and the format stays `version: 1`.
