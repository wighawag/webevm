---
title: "@webevm/devnode's webevm peer minimum is ahead of the workspace webevm until the next release"
date: 2026-11-20
status: open
---

Recorded by `devnode-worker-hosting`, which raised `@webevm/devnode`'s peer dependency to `webevm: ">=0.10.0"` (the release that will ship `exposeNode({createNode})`, from `worker-host-takes-a-node-factory`; the workspace `webevm` is still `0.9.1` with that change in a pending minor changeset). Until `changeset version` bumps webevm to 0.10.0, every `changeset` command prints `Package "@webevm/devnode" must depend on the current version of "webevm": "0.9.1" vs ">=0.10.0"`: changesets only warns and drops that edge from its dependency graph (so it will not rewrite the peer range itself), and `changeset status` still plans webevm 0.10.0 and devnode 0.1.0. The warning disappears once webevm is versioned. Alternative considered: keeping `>=0.9.1`, rejected because on 0.9.1 the factory is silently ignored and an in-worker dev node would come up with no dev accounts. If the next webevm release is not 0.10.0 (a major, say), the range still holds; if it is a patch, the range must be revisited.
