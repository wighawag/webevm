---
title: @webevm/devnode: hardhat_ and anvil_ impersonation over the trusted-sender primitive
slug: devnode-impersonation
spec: dev-node-package
blockedBy: [devnode-signing-methods-and-eip-712]
covers: [5, 6, 7, 8, 9, 12]
---

## What to build

Impersonation, opt-in: an `impersonation` option, default off.

- **Off**: `hardhat_impersonateAccount`, `hardhat_stopImpersonatingAccount` and their `anvil_` names answer a real `-32601` naming the option (rocketh swallows this error, so it must be honest).
- **On**: `createDevNode` creates the node with `senderMode: 'trusted'` (refusing an explicit `senderMode: 'recover'` in its options), and `wrapDevNode` refuses a node that is not `'trusted'`, at once, naming the option. The methods maintain a set of impersonated addresses. `eth_sendTransaction` from one is filled as a dev account's is, given a FABRICATED signature whose bytes are unique per sender (a fixed low `s`, an `r` derived from the address, e.g. `keccak(address)` reduced into the curve order, the approach foundry adopted after its #4210), and sent through `evm_sendRawTransactionAs(raw, from)`. A dev account that is also impersonated sends with its key.
- **No signature that is not one**: every signing method (`eth_signTransaction`, `personal_sign`, `eth_sign`, `eth_signTypedData_v4`) refuses an impersonated address with an error saying no key is held for it.

## Acceptance criteria

- [ ] With impersonation on, `hardhat_impersonateAccount(x)` then `eth_sendTransaction({from: x})` executes AS `x` on both engines (balance charged, nonce advanced, receipt `from`), asserted to the wei as the trusted-sender suite does.
- [ ] Two impersonated senders sending otherwise identical transactions get two different hashes and two receipts.
- [ ] After `stopImpersonatingAccount`, a send from `x` is refused again; both name sets work.
- [ ] Off: the methods answer `-32601` naming the option; on a `'recover'` node, enabling is refused at once.
- [ ] Signing methods refuse an impersonated address; a dev account that is also impersonated still signs and sends with its key.
- [ ] The refusal of an unknown `from` (from the send task) names the right remedy once impersonation is on: `hardhat_impersonateAccount` (or `anvil_impersonateAccount`) for that address.
- [ ] The package README documents the option, that it needs a `'trusted'` node, and that a dump containing impersonated (fabricated-signature) transactions is NOT replayable on a `'recover'` node (ADR 0002, Consequences), next to the send task's note that dev accounts' own dumps are.
- [ ] Changeset.

## Blocked by

- `devnode-signing-methods-and-eip-712`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`). Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`, ADR 0002 (the primitive and its caller contract: unique bytes per sender), ADR 0006's amendment 3 (the sender crosses the engine seam as a value), and `packages/webevm/test/helpers/trusted-sender.ts` and its two specs, whose to-the-wei, both-engines pattern this task's tests follow.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
