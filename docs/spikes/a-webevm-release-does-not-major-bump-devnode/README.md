# A webevm release does not force @webevm/devnode to 1.0.0

`@webevm/devnode` takes `webevm` as a peer dependency (`>=0.10.0`, ADR 0017). By default changesets gives every peer dependent a MAJOR bump whenever the peer takes a minor or major bump, even when the new version still satisfies the range. Below 1.0 that would publish `@webevm/devnode` 1.0.0 on the first webevm minor after the next release, which the maintainer does not want at this stage.

`.changeset/config.json` therefore sets:

```json
"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {
  "onlyUpdatePeerDependentsWhenOutOfRange": true
}
```

With it, a peer dependent is bumped only when the peer's new version leaves the declared range. `>=0.10.0` is satisfied by every later webevm, so devnode is released only when it has its own changeset.

## Caveats

- **Re-check on every `@changesets/cli` upgrade.** The option lives under `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`: changesets may rename or drop it in a PATCH release, and an unknown key is not guaranteed to warn. After any bump of `@changesets/cli` (or `@changesets/*`), rerun [`check-peer-bump.sh`](./check-peer-bump.sh) and confirm the WITH section still shows no `@webevm/devnode 1.0.0` after a `webevm: minor`.
- **devnode is no longer re-released automatically by a webevm release.** If devnode starts to need a newer webevm, raise its peer range by hand and give devnode its own changeset.
- Recorded as a note rather than an ADR: the setting is a one-line, easily reversed config choice, so it does not meet the ADR gate's "hard to reverse" bar.

## Check

[`check-peer-bump.sh`](./check-peer-bump.sh) clones the checkout twice under the system temp directory (never touching the working tree, committing nothing back, publishing nothing), runs `changeset status`, then `changeset version`, then `changeset status` with a `webevm: minor` and then a `webevm: major` changeset, once without the option and once with it.

Run on 2026-11-20 with `@changesets/cli` 2.31.0. The pending release is unchanged by the option (webevm 0.10.0, @webevm/devnode 0.1.0); after it, a `webevm: minor` plans devnode 1.0.0 without the option and leaves devnode unbumped with it.

```text
2.31.0
########## WITHOUT onlyUpdatePeerDependentsWhenOutOfRange
== changeset status (pending release)
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Packages to be bumped at minor
🦋  - webevm 0.10.0
🦋    - .changeset/block-clock-cheats.md
🦋    - .changeset/hardhat-and-anvil-state-cheats.md
🦋    - .changeset/prague-and-osaka.md
🦋    - .changeset/snapshots-in-the-core.md
🦋    - .changeset/worker-host-node-factory.md
🦋  - @webevm/devnode 0.1.0
🦋    - .changeset/devnode-alloc-export.md
🦋    - .changeset/devnode-dev-accounts.md
🦋    - .changeset/devnode-forwards-cheats-and-snapshots.md
🦋    - .changeset/devnode-impersonation.md
🦋    - .changeset/devnode-send-transaction.md
🦋    - .changeset/devnode-signing.md
🦋    - .changeset/devnode-worker-hosting.md
🦋  ---
🦋  info Running release would release NO packages as a major
== versions after changeset version (webevm, @webevm/devnode)
	"version": "0.10.0",
	"version": "0.1.0",
== changeset status after adding a webevm: minor changeset
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Packages to be bumped at minor
🦋  - webevm 0.11.0
🦋    - .changeset/next.md
🦋  ---
🦋  info Packages to be bumped at major
🦋  - @webevm/devnode 1.0.0
== changeset status after adding a webevm: major changeset
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Running release would release NO packages as a minor
🦋  ---
🦋  info Packages to be bumped at major
🦋  - webevm 1.0.0
🦋    - .changeset/next.md
🦋  - @webevm/devnode 1.0.0
########## WITH onlyUpdatePeerDependentsWhenOutOfRange
== changeset status (pending release)
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Packages to be bumped at minor
🦋  - webevm 0.10.0
🦋    - .changeset/block-clock-cheats.md
🦋    - .changeset/hardhat-and-anvil-state-cheats.md
🦋    - .changeset/prague-and-osaka.md
🦋    - .changeset/snapshots-in-the-core.md
🦋    - .changeset/worker-host-node-factory.md
🦋  - @webevm/devnode 0.1.0
🦋    - .changeset/devnode-alloc-export.md
🦋    - .changeset/devnode-dev-accounts.md
🦋    - .changeset/devnode-forwards-cheats-and-snapshots.md
🦋    - .changeset/devnode-impersonation.md
🦋    - .changeset/devnode-send-transaction.md
🦋    - .changeset/devnode-signing.md
🦋    - .changeset/devnode-worker-hosting.md
🦋  ---
🦋  info Running release would release NO packages as a major
== versions after changeset version (webevm, @webevm/devnode)
	"version": "0.10.0",
	"version": "0.1.0",
== changeset status after adding a webevm: minor changeset
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Packages to be bumped at minor
🦋  - webevm 0.11.0
🦋    - .changeset/next.md
🦋  ---
🦋  info Running release would release NO packages as a major
== changeset status after adding a webevm: major changeset
🦋  info Running release would release NO packages as a patch
🦋  ---
🦋  info Running release would release NO packages as a minor
🦋  ---
🦋  info Packages to be bumped at major
🦋  - webevm 1.0.0
🦋    - .changeset/next.md
```
