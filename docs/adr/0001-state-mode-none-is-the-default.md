# `stateMode: 'none'` is the default, so the node normally has NO state root

> **Renamed 2026-09-28** (`rename-statemode-to-computestateroot`): the `stateMode: 'none' | 'trie'` option is now `computeStateRoot: boolean` (default `false`), with no alias; `'trie'` below is `computeStateRoot: true` and `'none'` is a node without it. The decision recorded here (no state root by default, a real one as an explicit opt-in) is unchanged.

A node needs a Merkle-Patricia trie only to produce a canonical `stateRoot`, and a local chain does not need one: nothing is being consensus-verified. So the default is `SimpleStateManager` (plain Maps, no trie), and block `stateRoot`/`receiptsRoot`/`transactionsRoot` are zero placeholders while `getStateRoot()` throws rather than inventing a value. `'trie'` stays available as an explicit opt-in.

## Considered Options

- **Always trie (the obvious choice).** Rejected: it makes every consumer pay for a root almost none of them read.
- **Never trie.** Rejected because the root is what makes the node testable against `ethereum/tests` GeneralStateTests, which verify exactly the post-state root. Dropping it would cost the strongest external conformance signal available.

## Consequences

- The speed difference is smaller than the split suggests: roughly 1.4x per signed call and 1.35x on deploy. The mode exists at least as much to keep the honest-edge story clean (no faked roots) as for throughput.
- **Full-storage `dumpState` is a `'none'`-mode feature.** In `'trie'` mode the dump carries accounts and code but not contract storage, because the EVM journals storage on an internal `shallowCopy` of the state manager and the trie's own `dumpStorage` exposes only keccak-HASHED slot keys, not the raw slots `loadState` needs. So IndexedDB persistence implies `'none'`; the state root implies `'trie'`.
- `getStateRoot()` throwing in `'none'` mode is deliberate: there is no root, and returning a zero hash would be a plausible-looking lie.
