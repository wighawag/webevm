---
title: A throwing onNewHead subscriber fails the request that mined the block
date: 2026-11-24
status: open
---

Noticed while building `console-log-delivered-from-transactions-and-eth-call`: `executeAndMine` in `packages/webevm/src/node.ts` calls every `onNewHead` subscriber bare (`for (const cb of headSubs) cb(...)`), after the block is stored, so a subscriber that throws makes the `eth_sendRawTransaction` / `mine()` that mined it reject (and skips the subscribers after it, and the persistence save), although the block is already in the chain. `onConsoleLog` subscribers are guarded (caught and reported through `console.error`, ADR 0018); `onNewHead`'s may deserve the same treatment, which is a behaviour change for its own task. Not verified by a test.
