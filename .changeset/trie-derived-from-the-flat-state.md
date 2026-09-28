---
'webevm': minor
---

**`stateMode:'trie'` now runs on the same state as every node, with the trie derived from it.** Trie mode used to put a different state manager (`MerkleStateManager`) under the whole node. It now runs on the node's one flat state, like `'none'`, and additionally keeps a Merkle-Patricia trie derived from it: rebuilt from the whole state at construction and after `loadState`, and brought up to date at the end of each block from the keys that block changed. Block headers and `getStateRoot()` report the same roots as before (checked against the old implementation over the post-state battery's shapes, cheats between blocks and after the head, several transactions per block and 300 randomised cheats, and against the GeneralStateTests post-state roots). What changes for a trie-mode node:

- **The revm engine runs in trie mode.** `createNode({stateMode: 'trie', engine: await createRevmEngine(...)})` used to throw at construction; it now gives the fast engine and a real state root together. Execution never reads the trie.
- **`dumpState` carries contract storage** (it carried none in trie mode), and a reload reproduces every root. The trie itself is not serialised; `loadState` rebuilds it. IndexedDB persistence works in trie mode.
- **`stateHistory` works in trie mode** (it was refused at construction).
- **A contract created at an address holding only storage now SUCCEEDS and wipes that storage** (it used to fail with a collision in trie mode, EIP-7610, while `'none'` mode and revm created it). Every node now follows the reference spec (EIP-684 plus the Yellow Paper, as execution-specs specifies it): a nonce or code at the target is a collision, storage alone is not. No behaviour differs between the modes except the root.

`'none'` mode is unchanged and does no trie work at all. Adds `@ethereumjs/mpt` and `@ethereumjs/rlp` as direct dependencies (both were already installed through `@ethereumjs/statemanager`). The default entry point grows by about 1 KB.
