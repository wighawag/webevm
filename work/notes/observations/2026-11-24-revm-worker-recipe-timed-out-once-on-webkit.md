---
title: revm-worker.spec.ts timed out once on WebKit in a full run
date: 2026-11-24
status: open
---

During the full `pnpm test` of `console-log-delivered-from-transactions-and-eth-call`, `packages/webevm/test/revm-worker.spec.ts` › "revm in a Worker: the README recipe, executed" hit the 120 s test timeout on `[webkit]` (in `h.run`, `mode: 'revm-worker'`), then passed on both browsers when rerun alone, and the whole webevm suite passed on the next full run. Looks like a load-dependent flake on WebKit, not something this change touched (it adds no code to the revm or worker-entry paths beyond forwarding `onConsoleLog`).
