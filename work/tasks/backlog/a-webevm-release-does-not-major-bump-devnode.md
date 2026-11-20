---
title: A webevm release does not force @webevm/devnode to 1.0.0
slug: a-webevm-release-does-not-major-bump-devnode
blockedBy: []
covers: []
---

## What to build

`@webevm/devnode` takes `webevm` as a PEER dependency (`>=0.10.0`, ADR 0017). By default, changesets gives every dependent of a peer dependency a MAJOR bump whenever that peer takes a minor or major bump. Below 1.0 that means the first webevm minor after the next release would publish `@webevm/devnode` 1.0.0. The maintainer does not want a 1.0.0 at this stage.

This was verified on 2026-11-20 with `@changesets/cli` 2.31.0, in a throwaway clone of `main`:

- `changeset version` gives webevm 0.10.0 and devnode 0.1.0.
- Adding a `webevm: minor` changeset after that, `changeset status` plans webevm 0.11.0 and **@webevm/devnode 1.0.0 (major)**, though devnode itself has no changeset.
- With `"___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH": {"onlyUpdatePeerDependentsWhenOutOfRange": true}` in `.changeset/config.json`:
  - the same webevm minor (and a webevm major) leaves devnode unbumped, because `>=0.10.0` is still satisfied;
  - the pending release is unchanged (webevm 0.10.0, devnode 0.1.0).

Add that option to `.changeset/config.json`. Record why, durably: the option's name says it is experimental and may change in a patch release of changesets. A future upgrade of `@changesets/cli` must re-check it, and the record has to say so where a maintainer will find it. Options for where:

- a short ADR, if it meets the ADR gate (`work/protocol/ADR-FORMAT.md`);
- a `README.md` / `CONTRIBUTING`-level release note;
- at minimum, a `## Decisions` block in the done record.

JSON has no comments, so a comment in the config file itself is not available.

## Acceptance criteria

- [ ] `.changeset/config.json` sets `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true`, and nothing else in it changes.
- [ ] A check, scripted or recorded, shows the result in a throwaway copy of the repo (never the working checkout, never committed):
  - `changeset status` still plans webevm 0.10.0 and @webevm/devnode 0.1.0;
  - after `changeset version` plus a `webevm: minor` changeset, devnode is no longer bumped to 1.0.0.
  The commands and their output are recorded in the done record or a `docs/spikes/` note.
- [ ] The why and the "re-check on a changesets upgrade" caveat are recorded durably (see above).
- [ ] No changeset file: this changes release configuration, not a published package. Nothing is published, and no CI file changes.

## Blocked by

- None. Can start immediately.

## Prompt

You are working in webevm, a pnpm monorepo released with changesets (`.changeset/config.json`, `@changesets/cli` in the root devDependencies). `@webevm/devnode` (`packages/devnode`) has `webevm` as a peer dependency (`>=0.10.0`). Make a webevm release stop forcing a major bump of `@webevm/devnode`, by setting changesets' `onlyUpdatePeerDependentsWhenOutOfRange` option as described in "What to build", and record why.

FIRST, check this task against current reality: if the option is already set, or `@webevm/devnode` no longer takes `webevm` as a peer, route the task to needs-attention instead of building.

Verify the behaviour with `changeset status` / `changeset version` in a THROWAWAY copy (a temp clone or a copy of the tree under the system temp directory), never in your working tree, and never commit the results of `changeset version`: versioning is the release workflow's job. Do not publish anything, and do not run `changeset publish`. Never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively. The verify gate is `pnpm format:check && pnpm build && pnpm test`.
