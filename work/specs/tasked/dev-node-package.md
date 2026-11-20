---
title: A dev-node package on top of webevm (dev accounts, signing, impersonation, an alloc export)
slug: dev-node-package
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

> Tasked 2026-11-20. The decisions and their reasoning (the package's shape, genesis funding, the worker-host factory, send paths, impersonation, cheat aliases in the core) moved to `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`; what to build moved to the tasks whose `spec:` is `dev-node-package` in `work/tasks/`, plus the core tasks `hardhat-and-anvil-names-for-the-state-cheats` and `snapshots-in-the-core`.

## Problem Statement

`webevm` is execution-only by design. It holds no keys, answers `eth_accounts`, `eth_sendTransaction` and the other account methods with a real `-32601` (ADR 0004), and it implements impersonation only as a primitive, `evm_sendRawTransactionAs` on a `senderMode: 'trusted'` node, leaving the account policy to "a higher layer" (ADR 0002). That is right for the core's consumer, an application with its own signing client.

It is not what a deploy tool or a test runner expects from a local chain. rocketh is moving its in-process chain (for `memory` runs with no provider, and for producing fixtures for `forge test`) onto webevm (rocketh `work/specs/proposed/in-process-chain.md`), and its code calls, verified at rocketh's `origin/main`:

- `eth_accounts`, to resolve index-declared accounts, tolerating failure only when no index-declared account must resolve (`packages/rocketh/src/environment/index.ts`);
- `eth_sendTransaction` with a `from` the node is expected to sign for, for `remote` and impersonated accounts (`packages/rocketh/src/environment/index.ts`);
- `hardhat_impersonateAccount` for every named account it cannot sign for, when `autoImpersonate` is on, errors swallowed (`impersonateAccounts` in the same file);
- `hardhat_setBalance`, only with `fundImpersonatedAccounts`, to lend an impersonated sender the ETH for its gas and take it back after (same file);
- `evm_mine`, only when `autoMine` is set (same file; `packages/rocketh/src/executor/index.ts` resolves the setting). Since pull request #23 the core answers this one itself;
- and, for the forge hand-off, the chain's final state in a form `vm.loadAllocs` accepts, which rocketh produced by hand from a webevm 0.9.1 `dumpState()` and loaded into a passing `forge test` under forge 1.7.1 (rocketh `work/notes/findings/in-process-chain-without-hardhat.md`).

When this spec was written every one of those was `-32601` or did not exist (`evm_mine` has since landed in the core), so rocketh would have to build the layer itself, and so would the next tool that wants the same thing (rocketh's own playground already declares its accounts as `privateKey:` because the node has no `eth_accounts`). The rocketh spec records the decision that this layer is a separate package useful beyond rocketh, not part of rocketh and not part of webevm's core.

## Solution

A new package in this monorepo, `@webevm/devnode` (`packages/devnode`), layered on webevm with `webevm` as a peer dependency. `createDevNode({...nodeOptions, accounts, balance})` creates a webevm node whose dev accounts are FUNDED AT GENESIS, as anvil and Hardhat fund theirs, and returns it wrapped; `wrapDevNode(node, options)` wraps a node that already exists. The wrapped node is a `SlimNode` that answers the account methods dev tooling calls and forwards everything else to the node unchanged:

- **Dev accounts**: the anvil / Hardhat test accounts by default (10, 10,000 ETH each), or a mnemonic or private keys, answering `eth_accounts`.
- **Sending and signing**: `eth_sendTransaction` filled, signed with the account's key and submitted (through `evm_sendRawTransactionAs` on a trusted node, `eth_sendRawTransaction` otherwise); `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` (with an EIP-712 encoder of its own).
- **Impersonation**, opt-in: `hardhat_impersonateAccount` / `anvil_impersonateAccount` and the `stop` pair, executed through the trusted-sender primitive with signature bytes unique per sender; never a signature that is not one.
- **The cheats and snapshots are the core's**, and the dev node forwards them: `evm_mine`, `anvil_mine` / `hardhat_mine`, the time cheats, and (as core tasks) the `hardhat_` / `anvil_` state-cheat aliases and `evm_snapshot` / `evm_revert`.
- **An alloc export**, `toAllocs(dump)`, which forge's `vm.loadAllocs` accepts.
- **Workers**: it wraps a `createWorkerNode()` proxy on the main thread, or runs inside the worker through `@webevm/devnode/worker-host`'s `exposeDevNode`, built on an optional node factory on `webevm/worker-host`.

Everything the core refuses stays refused in the core. A consumer who never imports this package gets exactly today's webevm.

## User Stories

1. As a deploy-tool author, I want `eth_accounts` to return the same test accounts anvil and Hardhat do by default, so that index-declared accounts (`deployer: 0`) resolve on an in-process chain to the same addresses as there.
2. As a deploy-tool author, I want to configure the accounts with private keys or a mnemonic (and a count), so that my own deployer keys work in-process.
3. As a deploy-tool author, I want `eth_sendTransaction` from a dev account to be filled, signed with that account's key and mined, so that scripts written against a node-held account run unchanged.
4. As a deploy-tool author, I want `eth_sendTransaction` to fill exactly the fields the request left out (nonce from the pending nonce, gas from `eth_estimateGas`, fees from the node's fee market), so that what I specified is what is sent.
5. As a user rehearsing a Safe-owned or multisig-owned step, I want `hardhat_impersonateAccount(address)` followed by `eth_sendTransaction({from: address, ...})` to execute as that address with no key, so that I can run privileged steps in-process as I would on a fork.
6. As an anvil user, I want the `anvil_impersonateAccount` and `anvil_stopImpersonatingAccount` names to work too, so that tooling written against either node works.
7. As a user, I want `hardhat_stopImpersonatingAccount` to end it, so that a later send from that address is refused again.
8. As a user of the trusted-sender primitive, I want two impersonated senders sending otherwise identical transactions to get two different transaction hashes, so that neither overwrites the other's receipt (ADR 0002, foundry #4210).
9. As a user, I want enabling impersonation on a node that is not `senderMode: 'trusted'` to fail immediately and say which option to set, so that the failure is where the mistake is.
10. As a user, I want `eth_sendTransaction` from an address that is neither a dev account nor impersonated to fail with a real error naming both remedies, never with a plausible result.
11. As a dapp developer, I want `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` to sign with a dev account's key, so that a wallet-shaped flow (a permit, a login message) works in-process.
12. As a user, I want a message-signing request for an impersonated address to be refused with an error saying no key is held for it, so that I never receive a signature that is not one.
13. As a deploy-tool author, I want `hardhat_setBalance` and `anvil_setBalance` to set a balance through the wrapped node, so that `fundImpersonatedAccounts`-style lending works. (Served by the core's aliases, which this layer forwards; see ADR 0017.)
14. As a test author, I want `hardhat_setCode`, `hardhat_setNonce`, `hardhat_setStorageAt` and their `anvil_` names to set state through the wrapped node, so that fixtures written for Hardhat or anvil work here. (Likewise the core's.)
15. As a deploy-tool author, I want `evm_mine` to mine a block through the wrapped node, so that `autoMine` works on a node in manual or interval mining. (The core's since pull request #23; this layer forwards it.)
16. As a test author, I want `evm_snapshot` / `evm_revert` through the wrapped node, so that tests can share one deployment and roll back between cases. (Served by the core, task `snapshots-in-the-core`; this layer forwards them.)
17. As a test author, I want to know how my dev accounts' transactions are sent on each kind of node, and which dumps are replayable elsewhere, so that I choose `senderMode` knowingly. (The package README documents it.)
18. As a rocketh user handing a deployment to `forge test`, I want the node's state exported as an alloc map forge's `vm.loadAllocs` accepts, so that forge loads the deployment instead of replaying it.
19. As a user of that export, I want every account with code, balance, nonce or storage in it, nonces and balances as hex quantities, code as hex, and storage keyed by 32-byte slots, so that the file needs no post-processing.
20. As a browser developer, I want the package to run in a browser exactly as webevm does, so that the playground and in-browser tests can use dev accounts and impersonation.
21. As a worker user, I want to wrap the node a `createWorkerNode()` call returns, so that execution stays off the main thread while the layer runs on it.
22. As a worker user, I want to host the layer inside the worker too, so that the keys and the signing stay off the main thread with the execution.
23. As a webevm consumer who does not want accounts, I want nothing to change for me, so that the core stays execution-only and its `-32601` edges stay where they are.
24. As a maintainer, I want the layer to reach the node only through `SlimNode`'s public members, so that it cannot depend on node internals and the core can change underneath it.
25. As a maintainer, I want every method this layer does not implement forwarded to the node untouched, so that the node's own errors (its `-32601` included) reach the caller as the node wrote them.
26. As a deploy-tool author, I want the dev accounts funded at genesis (10,000 ETH each by default, configurable, with per-address extra funding like anvil's `--fund-accounts`), so that they can send at once, and a chain restored from a dump keeps its real balances.

## Out of Scope

- **Account policy in webevm's core.** No account, signing or impersonation method moves into `packages/webevm`; its `-32601` edges stay (ADR 0004). The one core change this spec DOES deliver is an optional node factory on `webevm/worker-host`'s `exposeNode`.
- **The `hardhat_` / `anvil_` aliases of the state cheats, and snapshots**: core changes, tasks `hardhat-and-anvil-names-for-the-state-cheats` and `snapshots-in-the-core`; this spec's forwarding task is blocked by them.
- **Forking a live network**: a separate idea, `work/notes/ideas/fork-a-live-network-in-process.md`.
- **The Solidity side of the forge hand-off** (deployment names and addresses for a test contract): rocketh's spec `deployments-in-solidity`.
- **A mempool and transaction replacement** beyond what the node's mining mode already does. (The layer's per-layer send queue is in scope; it orders sends, it does not hold them.)
