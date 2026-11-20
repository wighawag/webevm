---
title: @webevm/devnode: eth_signTransaction, personal_sign, eth_sign and eth_signTypedData_v4
slug: devnode-signing-methods-and-eip-712
spec: dev-node-package
blockedBy: [devnode-eth-send-transaction-from-dev-accounts]
covers: [11]
---

## What to build

The signing methods for dev accounts: `eth_signTransaction` (the same fill and types as `eth_sendTransaction`, returning the signed raw transaction without sending it), `personal_sign` and `eth_sign` (EIP-191 personal messages; mind the two methods' opposite parameter orders), and `eth_signTypedData_v4`, with an EIP-712 encoder written in this package (type encoding with referenced types sorted, struct hashing, the domain separator, arrays, nested structs, `bytes` / `string` hashing, and the integer and address encodings), with NO runtime dependency. Message signing uses `@noble/curves`' secp256k1 (`@ethereumjs/util` v10 exports no signing function). A request for an address with no key is refused with a real error.

## Acceptance criteria

- [ ] Every signature recovers to the account that made it.
- [ ] `eth_signTypedData_v4` matches `viem`'s `hashTypedData` / `signTypedData` (a DEV dependency) on EIP-712's own published `Mail` example, on an EIP-2612 permit, and on a type with arrays and nested structs; the encoder's hash matches the EIP's published digest.
- [ ] `personal_sign` and `eth_sign` match viem's `signMessage`, with the parameter orders as MetaMask and geth use them.
- [ ] `eth_signTransaction`'s output, submitted with `eth_sendRawTransaction`, mines.
- [ ] Changeset.

## Blocked by

- `devnode-eth-send-transaction-from-dev-accounts`

## Prompt

You are working in `packages/devnode` (`@webevm/devnode`). Implement the four signing methods named above. The EIP-712 encoder is this package's own code by the maintainer's decision; verify it against EIP-712's text and against viem in tests, never against itself. Read `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`.

FIRST, check this task against current reality (it is a launch snapshot and may have DRIFTED): the code in `work/tasks/done/`, the ADRs named here, and the tasks it is blocked by. If a dependency landed differently than this task assumes, or an ADR superseded an assumption here, do NOT build on the stale premise: route the task to needs-attention with the discrepancy (WORK-CONTRACT.md, "Drift is a needs-attention signal").

RECORD non-obvious in-scope decisions durably and link them from the done record: an ADR when it meets the ADR gate (`work/protocol/ADR-FORMAT.md`), otherwise a comment at the choice site or a `## Decisions` block in the done record.

Rules: never write the em dash character. Bound every shell command with `timeout` and cap its output; never grep `node_modules`, `dist` or `.git` recursively, and never run a regex over a minified or bundled file. Stop every process you start. Ask before adding a dependency not named in this task or in ADR 0017. The verify gate is `pnpm format:check && pnpm build && pnpm test`, and a change to a published package needs a changeset written as a file under `.changeset/`.
