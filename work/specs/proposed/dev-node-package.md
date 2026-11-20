---
title: A dev-node package on top of webevm (dev accounts, impersonation, snapshots, an alloc export)
slug: dev-node-package
needsAnswers: true
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

<!-- open-questions -->

## Open questions

1. **The package's name.** Proposed: `webevm-dev`, in `packages/webevm-dev`. Alternatives: `@webevm/dev` (a scope this repo does not own yet), `webevm-devnode`. It must NOT be a subpath of `webevm` (`webevm/dev`): a subpath ships inside the core package, and ADR 0004's "not even optionally" is about the package, not about which entry point a consumer imports.
2. **Where dev accounts come from.** Private keys only (no new dependency: `@ethereumjs/tx` already signs, and `webevm` already depends on it), or also a mnemonic with hardhat's and anvil's derivation path (`m/44'/60'/0'/0/i`), which needs BIP-39 and BIP-32 code (`@scure/bip39` and `@scure/bip32`, or equivalent). A mnemonic is what makes `eth_accounts[0]` the same address as on anvil and Hardhat, which index-declared accounts in rocketh configs (`deployer: 0`) rely on to mean the same account everywhere. Adding a dependency needs the maintainer's approval.
3. **Does `eth_accounts` list impersonated addresses?** anvil lists an address it has impersonated as one of its own (rocketh's `packages/rocketh/src/environment/index.ts` handles that case explicitly). Listing them keeps anvil's behaviour; not listing them keeps `eth_accounts` meaning "accounts whose keys this layer holds".
4. **Which signing methods dev accounts answer** beyond `eth_sendTransaction`: `eth_signTransaction`, `eth_sign`, `personal_sign`, `eth_signTypedData_v4`. rocketh needs none of them today; a wallet-shaped consumer (a dapp in the playground) may.
5. **Dev accounts' sends: `eth_sendRawTransaction` on a `'recover'` node, or `evm_sendRawTransactionAs` on the `'trusted'` node impersonation already requires?** Impersonation needs `senderMode: 'trusted'` (below), so the layer could create one trusted node and route its own signed transactions through the `As` cheat too, skipping ecrecover (ADR 0002's first consequence: ~3.6x end to end on the default engine). That makes every dump this layer produces carry the trusted-sender caveat. Or impersonation could be opt-in and require the caller to ask for a trusted node.
6. **Snapshot semantics**: hardhat's (`evm_revert` consumes the snapshot and every later one, and returns `true`/`false`) or anvil's (the same, plus `anvil_snapshot`/`anvil_revert` aliases). Both agree on consumption; the question is only which names and what a revert to an unknown id returns. Also whether a snapshot holds a whole `dumpState()` (simple, O(state) per snapshot) or something cheaper. And WHERE they live: `evm_snapshot` / `evm_revert` are cheats that are not account policy, so the reasoning that answered open question 11 points them at the core too (ADR 0016 left them out only as "not about time"); if they move there, this layer forwards them.
7. **The alloc export's storage VALUES**: padded to 32 bytes or left as the dump's shortest form. rocketh verified forge 1.7.1 accepts hex-string nonces and balances and 32-byte padded storage KEYS (`work/notes/findings/in-process-chain-without-hardhat.md` in rocketh); the value form was not isolated. And whether the export test runs a real `forge test`, which needs a forge binary CI does not have today (changing CI needs the maintainer's approval).
8. **Worker support**: the layer wraps a `SlimNode`, so it works on the main thread over the proxy `createWorkerNode()` returns, with keys and signing on the main thread (see Implementation Decisions). Is that enough, or should the layer also be hostable INSIDE the worker (keys in the worker, a `webevm/worker-host`-style `exposeDevNode`)?
9. **Mining names. ANSWERED by the core:** pull request #23 (merged, ADR 0016) gave webevm itself `evm_mine` (with anvil's and ganache's `[timestamp]` and `[{timestamp, blocks}]` forms), `anvil_mine` / `hardhat_mine` `[blocks, interval]`, and the time cheats (`evm_setNextBlockTimestamp`, `evm_increaseTime`, `anvil_setBlockTimestampInterval`, `anvil_removeBlockTimestampInterval`). This layer implements none of them and forwards them untouched.
10. **Fees on impersonated and dev sends**: when the request names no fee fields, fill them the way `eth_fillTransaction` does (the node's constant fee market), or always send legacy.
11. **Where the line between the core's cheat names and this layer's falls. ANSWERED: cheat ALIASES belong in the core.** ADR 0016 settled the principle when it put anvil's and hardhat's names for mining and time into webevm: a cheat that is not account policy (ADR 0004) and fabricates nothing a client could mistake for a real node's answer belongs in the core, under the names the other dev nodes already use, so a consumer of the core alone gets one dialect rather than half of one. The state cheats are the same kind (the README already calls `evm_set*` "anvil/hardhat-style"), so `hardhat_setBalance` / `anvil_setBalance`, `hardhat_setCode` / `anvil_setCode`, `hardhat_setNonce` / `anvil_setNonce` and `hardhat_setStorageAt` / `anvil_setStorageAt` are a CORE change mapping onto the existing `evm_set*`, not this layer's. What stays here is what the core rules out: accounts, signing and impersonation (ADRs 0002 and 0004), plus the alloc export. Whether snapshots move to the core on the same reasoning is part of open question 6.

<!-- /open-questions -->

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

A new package in this monorepo, layered on webevm and depending on nothing else that webevm does not already bring in (subject to open question 2). It takes a webevm node (a `SlimNode`, so a main-thread node and a worker proxy alike) and returns an EIP-1193 provider that answers the account and cheat methods dev tooling calls, and forwards everything else to the node unchanged:

- **Dev accounts.** Configured keys answer `eth_accounts`, and `eth_sendTransaction` from one of them is filled (nonce, gas, fees), signed with its key and submitted as a raw transaction.
- **Impersonation.** `hardhat_impersonateAccount` / `anvil_impersonateAccount` (and the `stop` pair) maintain a set of impersonated addresses. `eth_sendTransaction` from one of them is filled, given a FABRICATED signature whose bytes are unique per sender (ADR 0002's caller contract), and submitted through `evm_sendRawTransactionAs(raw, from)`, so it executes as the claimed sender on either engine with no key held anywhere. This needs a node created with `senderMode: 'trusted'`; the layer refuses to enable impersonation on a node that is not, in the node's own honest-edge style, rather than failing at the first send.
- **The cheat names dev tooling uses are the CORE's, and this layer forwards them** (open questions 9 and 11): `evm_mine`, `anvil_mine` / `hardhat_mine` and the time cheats are in webevm already, and the `hardhat_` / `anvil_` aliases of the state cheats (`setBalance`, `setCode`, `setNonce`, `setStorageAt`) are a separate core change this layer depends on, since rocketh's `fundImpersonatedAccounts` calls `hardhat_setBalance`.
- **Snapshots.** `evm_snapshot` / `evm_revert` built on `node.dumpState()` / `node.loadState()`.
- **An alloc export**: the node's state as a genesis alloc map, `{address: {nonce, balance, code, storage}}` in hex strings with 32-byte storage keys, which `vm.loadAllocs` in forge accepts.

Everything the core refuses stays refused in the core. A consumer who never imports this package gets exactly today's webevm.

## User Stories

1. As a deploy-tool author, I want `eth_accounts` to return a configured list of dev accounts, so that index-declared accounts (`deployer: 0`) resolve on an in-process chain as they do on anvil and Hardhat.
2. As a deploy-tool author, I want `eth_sendTransaction` from a dev account to be filled, signed with that account's key and mined, so that scripts written against a node-held account run unchanged.
3. As a deploy-tool author, I want `eth_sendTransaction` to fill exactly the fields the request left out (nonce from the pending nonce, gas from `eth_estimateGas`, fees from the node's fee market), so that what I specified is what is sent.
4. As a user rehearsing a Safe-owned or multisig-owned step, I want `hardhat_impersonateAccount(address)` followed by `eth_sendTransaction({from: address, ...})` to execute as that address with no key, so that I can run privileged steps in-process as I would on a fork.
5. As an anvil user, I want the `anvil_impersonateAccount` and `anvil_stopImpersonatingAccount` names to work too, so that tooling written against either node works.
6. As a user, I want `hardhat_stopImpersonatingAccount` to end it, so that a later send from that address is refused again.
7. As a user of the trusted-sender primitive, I want two impersonated senders sending otherwise identical transactions to get two different transaction hashes, so that neither overwrites the other's receipt (ADR 0002, foundry #4210).
8. As a user, I want enabling impersonation on a node that is not `senderMode: 'trusted'` to fail immediately and say which option to set, so that the failure is where the mistake is.
9. As a user, I want `eth_sendTransaction` from an address that is neither a dev account nor impersonated to fail with a real error naming both remedies, never with a plausible result.
10. As a deploy-tool author, I want `hardhat_setBalance` and `anvil_setBalance` to set a balance through the wrapped provider, so that `fundImpersonatedAccounts`-style lending works. (Served by the core's aliases, which this layer forwards; see open question 11.)
11. As a test author, I want `hardhat_setCode`, `hardhat_setNonce`, `hardhat_setStorageAt` and their `anvil_` names to set state through the wrapped provider, so that fixtures written for Hardhat or anvil work here. (Likewise the core's.)
12. As a deploy-tool author, I want `evm_mine` to mine a block through the wrapped provider, so that `autoMine` works on a node in manual or interval mining. (The core's since pull request #23; this layer forwards it.)
13. As a test author, I want `evm_snapshot` to return an id and `evm_revert(id)` to restore the chain to that point (state, blocks, receipts and logs alike), so that tests can share one deployment and roll back between cases.
14. As a test author, I want reverting to a snapshot to discard it and every snapshot taken after it, as Hardhat and anvil do, so that snapshot ids mean the same thing here.
15. As a rocketh user handing a deployment to `forge test`, I want the node's state exported as an alloc map forge's `vm.loadAllocs` accepts, so that forge loads the deployment instead of replaying it.
16. As a user of that export, I want every account with code, balance, nonce or storage in it, nonces and balances as hex quantities, code as hex, and storage keyed by 32-byte slots, so that the file needs no post-processing.
17. As a browser developer, I want the package to run in a browser exactly as webevm does, so that the playground and in-browser tests can use dev accounts and impersonation.
18. As a worker user, I want to wrap the node a `createWorkerNode()` call returns, so that execution stays off the main thread while the layer runs on it.
19. As a webevm consumer who does not want accounts, I want nothing to change for me, so that the core stays execution-only and its `-32601` edges stay where they are.
20. As a maintainer, I want the layer to reach the node only through its public surface (`request`, `mine`, `dumpState`, `loadState`), so that it cannot depend on node internals and the core can change underneath it.
21. As a maintainer, I want every method this layer does not implement forwarded to the node untouched, so that the node's own errors (its `-32601` included) reach the caller as the node wrote them.

### Autonomy notes (the two gate axes)

- **`humanOnly`**: not set. Tasking this spec is ordinary work once the questions are answered.
- **`needsAnswers: true`**: the open questions above decide the package's name, a possible new dependency (open question 2), the impersonation and signing scope, and whether the export is tested against a real forge (which touches CI). The tasker must not cut tasks until they are answered.

## Implementation Decisions

- **A separate workspace package**, `packages/<name>` beside `packages/webevm`, published on its own and depending on `webevm` as a regular dependency. Not a subpath of `webevm`: ADRs 0002 and 0004 keep accounts, signing and impersonation out of the core package entirely.
- **The layer wraps a `SlimNode`.** Its entry point takes a node (anything implementing `SlimNode`, which is what `createNode()` and `createWorkerNode()` both return) plus options (keys, whether impersonation is enabled) and returns an EIP-1193 provider whose `request` answers the methods above and forwards the rest to `node.request`. It reaches the node only through `request`, `mine`, `dumpState` and `loadState`, so it inherits the node's one-request-at-a-time serialisation (ADR 0012) for free and needs no lock of its own, except that a compound operation (fill, sign, submit) is several node requests and another caller's request may land between them; the build should state whether that matters (it does not for a single-caller deploy run).
- **Worker helpers come for free on the main-thread side.** Because the layer only calls the node's public methods, wrapping the proxy `createWorkerNode()` returns works unchanged: execution in the worker, keys and signing on the main thread. Hosting the layer inside the worker is open question 8.
- **Signing uses `@ethereumjs/tx`**, which `webevm` already depends on (it is how the node parses), so dev-account support adds no dependency unless mnemonics are wanted (open question 2).
- **Impersonated sends fabricate a signature unique per sender**, as ADR 0002's consequences require: `from` is not part of a transaction, so two fabricated transactions that share a signature, nonce, `to` and data would share a hash. The proposed shape is a fixed low `s` (so EIP-2 never rejects it) and an `r` derived from the claimed sender's address (for example `keccak(address)` reduced into the curve order), the approach foundry adopted after #4210. The node never sees the difference: it is handed `[raw, from]` through `evm_sendRawTransactionAs` and executes as `from` on either engine (ADR 0006 amendment 3).
- **Impersonation requires a `senderMode: 'trusted'` node, and says so.** The layer cannot read a node's sender mode through EIP-1193; `node.senderMode` is on `SlimNode`, which is one reason the layer takes a `SlimNode` rather than a bare provider.
- **Snapshots hold a `dumpState()`** and revert with `loadState()`. `loadState` replaces state, blocks, receipts, transactions and logs, and carries the `stateHistory` undo log, so a revert restores everything a consumer can read. If dumps come to record their hardfork and a node refuses another fork's dump (the Prague and Osaka work proposes both), that cannot bite here: a snapshot is reloaded into the node it came from.
- **The alloc export decodes the dump.** `dumpState().accounts` maps an address to the hex RLP of `[nonce, balance, storageRoot, codeHash]`; the export decodes nonce and balance from it (with `@ethereumjs/util`'s account decoding, already a webevm dependency), takes code from `dumpState().code`, and storage from `dumpState().storage`, whose keys are already 32-byte `0x` hex. The storage-root and code-hash fields are dropped: forge recomputes both. Whether values are padded is open question 7. A dump of a chain that used fabricated signatures exports fine: the alloc carries state only, never the transactions.
- **Everything else forwards untouched**, errors included, so the layer cannot become a second source of node behaviour.

## Testing Decisions

- **Through the public surface only**, like the rest of this repo: build a node, wrap it, drive the wrapped provider with viem's public and wallet clients (`viem` is already a dev dependency), and read the results back through the node's RPC.
- **On both engines**, because impersonation crosses the engine seam as `TransactionRequest.sender`: the trusted-sender suite's pattern (`packages/webevm/test/helpers/trusted-sender.ts`, run by `trusted-sender.spec.ts` and `revm-trusted-sender.spec.ts`) is the prior art, asserting post-state literals to the wei so a re-recovering engine is caught.
- **In Chromium and WebKit**, through `playwright-browser-harness`, as every webevm spec does, plus one Node run for the export.
- **Impersonation**: two impersonated senders, same nonce, same `to` and data, two different hashes and two receipts; a send after `stopImpersonating` refused; impersonation on a `'recover'` node refused at enable time.
- **Snapshots**: deploy, snapshot, mutate (a transaction and an `evm_set*` cheat), revert, and the state, the block number and the receipts are back; a second revert to the same id fails; a snapshot taken after the first is gone after reverting to the first.
- **The export**: against the shape rocketh proved (a contract whose constructor stores a value, then the alloc's nonce, balance, code and the slot), as a unit test. A real `forge test` run is open question 7.

## Out of Scope

- **Anything in webevm's core.** No account, signing or impersonation method moves into `packages/webevm`; its `-32601` edges stay (ADR 0004).
- **The `hardhat_` / `anvil_` aliases of the state cheats**: a core change (open question 11), to be cut as its own task before this spec's tasks that rely on it.
- **Forking a live network**: a separate idea, `work/notes/ideas/fork-a-live-network-in-process.md`.
- **The Solidity side of the forge hand-off** (deployment names and addresses for a test contract): rocketh's spec `deployments-in-solidity`.
- **A mempool, transaction replacement, and `eth_sendTransaction` queueing** beyond what the node's mining mode already does.

## Further Notes

- rocketh's playground (`packages/rocketh-playground/src/core/chain.ts` at rocketh's `origin/main`) already runs rocketh on webevm in a browser, declaring accounts as `privateKey:`; it is prior art for the browser side and the first candidate consumer after rocketh's `memory` runs.
- The node's default fork is now Osaka (pull request #26), where EIP-7825 caps a transaction at 16,777,216 gas. A fill step that copies `eth_estimateGas` is unaffected (the node never recommends more), but a layer that defaults a missing `gas` to the block gas limit, as some tools do, would be refused.
