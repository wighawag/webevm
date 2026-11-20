---
title: @webevm/devnode: eth_sendTransaction from dev accounts
slug: devnode-eth-send-transaction-from-dev-accounts
spec: dev-node-package
blockedBy: [devnode-package-dev-accounts-funded-at-genesis]
covers: [3, 4, 10, 17]
---

## What to build

`eth_sendTransaction` from a dev account: fill exactly what the request leaves out, sign with the account's key, submit, and return the hash.

- **Filling**: nonce from the PENDING nonce (`eth_getTransactionCount` at `pending`, as `eth_fillTransaction` uses), gas from `eth_estimateGas` with the same request, fees from the node's fee market as `eth_fillTransaction` fills them (EIP-1559 by default, legacy when the request passes `gasPrice`). Unlike `eth_fillTransaction`, nothing the request names is dropped: type 0 for `gasPrice`, type 1 for `gasPrice` plus an `accessList`, an `accessList` carried on type 2, type 4 for an `authorizationList` (the node refuses it before Prague in its own words).
- **The send path, by the node's sender mode**: on a `senderMode: 'trusted'` node through `evm_sendRawTransactionAs(raw, from)` with the REAL signature; on a `'recover'` node through `eth_sendRawTransaction`. The package README documents both paths and that such dumps stay replayable anywhere (ADR 0002's caveat is about fabricated signatures only).
- **Concurrency**: fill, sign and submit run as ONE operation on a per-layer queue, so concurrent sends from one account get consecutive nonces.
- **Refusal**: a `from` that is not a dev account (and, until the impersonation task lands, not impersonated) is refused with a real error naming the remedies (configure the key; or enable impersonation), never a plausible result.

## Acceptance criteria

- [ ] A dev account's `eth_sendTransaction` mines (auto mining) with the receipt's `from` being that account, on both engines and in both sender modes; the path taken per mode is asserted (e.g. the trusted node's dump replays on a `'recover'` node).
- [ ] Each field the request names is what is sent (asserted per field and per type 0, 1, 2 and 4); missing ones are filled as specified.
- [ ] Two concurrent sends from one account both mine, with consecutive nonces.
- [ ] An unknown `from` is refused with the specified error and moves nothing.
- [ ] Package README section on the send paths; changeset.

## Blocked by

- `devnode-package-dev-accounts-funded-at-genesis`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`), the dev-account layer over webevm. Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md` (send paths, why real signatures keep dumps portable), ADR 0002 (the trusted-sender primitive), ADR 0012 (requests are concurrent; the node serialises its own), and `eth_fillTransaction` in `packages/webevm/src/node.ts` (the fee and nonce filling to match, and the fields it drops, which this must not). Sign with `@ethereumjs/tx`.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
