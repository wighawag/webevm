---
title: A dev-node package on top of webevm (dev accounts, signing, impersonation, an alloc export)
slug: dev-node-package
needsAnswers: true
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)

<!-- open-questions -->

## Open questions

1. **The package's name.** The maintainer now owns the `@webevm` npm scope. Proposed: **`@webevm/devnode`**, in `packages/devnode`: it names the thing (a node you develop against, with accounts, the way "Hardhat Network" or anvil is), reads well as `createDevNode(node, {accounts})`, and does not sound like dev tooling or a devDependency the way a bare `@webevm/dev` does. Alternatives considered: `@webevm/dev` (short, vaguer), `@webevm/local` (says where, not what), `@webevm/testnode` (undersells deploys), `@webevm/accounts` (too narrow). It must NOT be a subpath of `webevm` (`webevm/dev`): a subpath ships inside the core package, and ADR 0004's "not even optionally" is about the package.
2. **Which dependencies to add**, now that mnemonics and typed-data signing are wanted (answers 2 and 4 below). Mnemonics: `@scure/bip39` and `@scure/bip32` (the noble family; `@noble/hashes` is already a webevm dependency). EIP-712 hashing for `eth_signTypedData_v4`: either `viem`'s `hashTypedData` (correct by reputation, large but tree-shakes, and many consumers already have it) or a small encoder in this package, tested against `viem` as a dev dependency. Proposed: the `@scure` pair, and `viem` as a peer dependency for typed data only if the in-package encoder is judged too risky. Adding any of them needs the maintainer's approval.
3. **Hosting the layer inside a worker** (answer 8 below) probably needs a small hook in `webevm/worker-host` (for example `exposeNode({createEngine, wrapNode})`, so the worker's node is wrapped before it is exposed), which is a change to a core public api. Confirm before building it, or choose a design that needs none (this package shipping its own worker host).

<!-- /open-questions -->

## Answers (decided 2026-11-20 by the maintainer)

The original questions and their answers, kept so the reasoning travels with the spec.

- **Where dev accounts come from: private keys AND a mnemonic, both now.** Built in: the well-known anvil / Hardhat test accounts, so `eth_accounts[0]` is the same address as on those nodes (rocketh's `deployer: 0` relies on that). Configurable: a list of private keys, or a mnemonic with a count and the standard path `m/44'/60'/0'/0/i`. Dependencies: open question 2.
- **`eth_accounts` lists only the accounts whose keys the layer holds**, never impersonated addresses (anvil lists them; rocketh copes with both, and appending them could shift what index-declared accounts resolve to).
- **Signing methods for dev accounts: `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4`.** An impersonated address holds no key, so a request to sign a MESSAGE for one is refused with a real error saying so; its `eth_sendTransaction` works through impersonation.
- **How dev accounts send, by the node's sender mode, and DOCUMENTED.** On a `senderMode: 'trusted'` node they send through `evm_sendRawTransactionAs` with their REAL signature: faster (no ecrecover), and the dump stays replayable on any node, because ADR 0002's portability caveat applies only to fabricated signatures. On a `'recover'` node they send through `eth_sendRawTransaction`. Impersonation is available only on a `'trusted'` node, and enabling it on a `'recover'` one fails at once, naming the option. The package's README states all three facts and the portability distinction.
- **Snapshots live in the CORE**, by ADR 0016's principle (below), with Hardhat's and anvil's semantics: `evm_snapshot` / `evm_revert` and `anvil_snapshot` / `anvil_revert`, a revert consuming that snapshot and every later one, `true` / `false` from a revert. Task `snapshots-in-the-core`. This layer forwards them.
- **The alloc export pads storage values to 32 bytes** (geth's genesis convention). No forge in CI: the export's shape is pinned by a unit test, and a short manual script runs a real `forge test` against an export, run once when the package is built.
- **Worker support: both.** Wrapping the proxy `createWorkerNode()` returns (execution in the worker, keys and signing on the main thread), and hosting the layer inside the worker (keys there too), as `webevm/worker-host` hosts a node. Design: open question 3.
- **Fees on a request naming none** are filled as `eth_fillTransaction` fills them: EIP-1559 from the node's fee market, legacy only when the caller passes `gasPrice`.
- **Mining names: answered by the core.** Pull request #23 (ADR 0016) gave webevm `evm_mine`, `anvil_mine` / `hardhat_mine` and the time cheats; this layer forwards them.
- **Where cheat names live: cheat ALIASES belong in the core.** ADR 0016's principle: a cheat that is not account policy (ADR 0004) and fabricates nothing a client could mistake for a real node's answer belongs in the core, under the names the other dev nodes use. So the `hardhat_` / `anvil_` names of the state cheats are a core change (task `hardhat-and-anvil-names-for-the-state-cheats`), and so are snapshots. What stays in this package is what the core rules out: accounts, signing and impersonation (ADRs 0002 and 0004), plus the alloc export.

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

A new package in this monorepo (proposed name `@webevm/devnode`, open question 1), layered on webevm, adding only the dependencies open question 2 settles. It takes a webevm node (a `SlimNode`, so a main-thread node and a worker proxy alike) and returns an EIP-1193 provider that answers the account and cheat methods dev tooling calls, and forwards everything else to the node unchanged:

- **Dev accounts.** The built-in test accounts, a list of private keys, or a mnemonic answer `eth_accounts`. `eth_sendTransaction` from one of them is filled (nonce, gas, fees), signed with its key and submitted; `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4` sign with it.
- **Impersonation.** `hardhat_impersonateAccount` / `anvil_impersonateAccount` (and the `stop` pair) maintain a set of impersonated addresses. `eth_sendTransaction` from one of them is filled, given a FABRICATED signature whose bytes are unique per sender (ADR 0002's caller contract), and submitted through `evm_sendRawTransactionAs(raw, from)`, so it executes as the claimed sender on either engine with no key held anywhere. This needs a node created with `senderMode: 'trusted'`; the layer refuses to enable impersonation on a node that is not, in the node's own honest-edge style, rather than failing at the first send.
- **The cheat names dev tooling uses are the CORE's, and this layer forwards them**: `evm_mine`, `anvil_mine` / `hardhat_mine` and the time cheats are in webevm already; the `hardhat_` / `anvil_` aliases of the state cheats (`setBalance`, `setCode`, `setNonce`, `setStorageAt`) and the snapshots are core tasks this layer depends on (`hardhat-and-anvil-names-for-the-state-cheats`, `snapshots-in-the-core`), since rocketh's `fundImpersonatedAccounts` calls `hardhat_setBalance`.
- **An alloc export**: the node's state as a genesis alloc map, `{address: {nonce, balance, code, storage}}` in hex strings with 32-byte storage keys, which `vm.loadAllocs` in forge accepts.

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
13. As a deploy-tool author, I want `hardhat_setBalance` and `anvil_setBalance` to set a balance through the wrapped provider, so that `fundImpersonatedAccounts`-style lending works. (Served by the core's aliases, which this layer forwards; see Answers.)
14. As a test author, I want `hardhat_setCode`, `hardhat_setNonce`, `hardhat_setStorageAt` and their `anvil_` names to set state through the wrapped provider, so that fixtures written for Hardhat or anvil work here. (Likewise the core's.)
15. As a deploy-tool author, I want `evm_mine` to mine a block through the wrapped provider, so that `autoMine` works on a node in manual or interval mining. (The core's since pull request #23; this layer forwards it.)
16. As a test author, I want `evm_snapshot` / `evm_revert` through the wrapped provider, so that tests can share one deployment and roll back between cases. (Served by the core, task `snapshots-in-the-core`; this layer forwards them.)
17. As a test author, I want to know how my dev accounts' transactions are sent on each kind of node, and which dumps are replayable elsewhere, so that I choose `senderMode` knowingly. (The package README documents it.)
18. As a rocketh user handing a deployment to `forge test`, I want the node's state exported as an alloc map forge's `vm.loadAllocs` accepts, so that forge loads the deployment instead of replaying it.
19. As a user of that export, I want every account with code, balance, nonce or storage in it, nonces and balances as hex quantities, code as hex, and storage keyed by 32-byte slots, so that the file needs no post-processing.
20. As a browser developer, I want the package to run in a browser exactly as webevm does, so that the playground and in-browser tests can use dev accounts and impersonation.
21. As a worker user, I want to wrap the node a `createWorkerNode()` call returns, so that execution stays off the main thread while the layer runs on it.
22. As a worker user, I want to host the layer inside the worker too, so that the keys and the signing stay off the main thread with the execution.
23. As a webevm consumer who does not want accounts, I want nothing to change for me, so that the core stays execution-only and its `-32601` edges stay where they are.
24. As a maintainer, I want the layer to reach the node only through its public surface (`request`, `mine`, `dumpState`, `loadState`), so that it cannot depend on node internals and the core can change underneath it.
25. As a maintainer, I want every method this layer does not implement forwarded to the node untouched, so that the node's own errors (its `-32601` included) reach the caller as the node wrote them.

### Autonomy notes (the two gate axes)

- **`humanOnly`**: not set. Tasking this spec is ordinary work once the questions are answered.
- **`needsAnswers: true`**: three questions remain: the name, the new dependencies, and whether in-worker hosting may add a hook to `webevm/worker-host`. The tasker must not cut tasks until they are answered.

## Implementation Decisions

- **A separate workspace package**, `packages/<name>` beside `packages/webevm`, published on its own and depending on `webevm` as a regular dependency. Not a subpath of `webevm`: ADRs 0002 and 0004 keep accounts, signing and impersonation out of the core package entirely.
- **The layer wraps a `SlimNode`.** Its entry point takes a node (anything implementing `SlimNode`, which is what `createNode()` and `createWorkerNode()` both return) plus options (keys, whether impersonation is enabled) and returns an EIP-1193 provider whose `request` answers the methods above and forwards the rest to `node.request`. It reaches the node only through `request`, `mine`, `dumpState` and `loadState`, so it inherits the node's one-request-at-a-time serialisation (ADR 0012) for free and needs no lock of its own, except that a compound operation (fill, sign, submit) is several node requests and another caller's request may land between them; the build should state whether that matters (it does not for a single-caller deploy run).
- **Worker helpers come for free on the main-thread side.** Because the layer only calls the node's public methods, wrapping the proxy `createWorkerNode()` returns works unchanged: execution in the worker, keys and signing on the main thread. Hosting the layer inside the worker as well is decided; its design is open question 3.
- **Transaction signing uses `@ethereumjs/tx`**, and message signing `@ethereumjs/util`'s secp256k1, both already webevm dependencies. Mnemonics and EIP-712 hashing need the dependencies open question 2 settles.
- **Dev accounts send by the node's sender mode**: `evm_sendRawTransactionAs` with their real signature on a `'trusted'` node, `eth_sendRawTransaction` on a `'recover'` one (see Answers). Documented in the package README.
- **Impersonated sends fabricate a signature unique per sender**, as ADR 0002's consequences require: `from` is not part of a transaction, so two fabricated transactions that share a signature, nonce, `to` and data would share a hash. The proposed shape is a fixed low `s` (so EIP-2 never rejects it) and an `r` derived from the claimed sender's address (for example `keccak(address)` reduced into the curve order), the approach foundry adopted after #4210. The node never sees the difference: it is handed `[raw, from]` through `evm_sendRawTransactionAs` and executes as `from` on either engine (ADR 0006 amendment 3).
- **Impersonation requires a `senderMode: 'trusted'` node, and says so.** The layer cannot read a node's sender mode through EIP-1193; `node.senderMode` is on `SlimNode`, which is one reason the layer takes a `SlimNode` rather than a bare provider.
- **The alloc export decodes the dump.** `dumpState().accounts` maps an address to the hex RLP of `[nonce, balance, storageRoot, codeHash]`; the export decodes nonce and balance from it (with `@ethereumjs/util`'s account decoding, already a webevm dependency), takes code from `dumpState().code`, and storage from `dumpState().storage`, whose keys are already 32-byte `0x` hex. The storage-root and code-hash fields are dropped: forge recomputes both. Storage values are padded to 32 bytes. A dump of a chain that used fabricated signatures exports fine: the alloc carries state only, never the transactions.
- **Everything else forwards untouched**, errors included, so the layer cannot become a second source of node behaviour.

## Testing Decisions

- **Through the public surface only**, like the rest of this repo: build a node, wrap it, drive the wrapped provider with viem's public and wallet clients (`viem` is already a dev dependency), and read the results back through the node's RPC.
- **On both engines**, because impersonation crosses the engine seam as `TransactionRequest.sender`: the trusted-sender suite's pattern (`packages/webevm/test/helpers/trusted-sender.ts`, run by `trusted-sender.spec.ts` and `revm-trusted-sender.spec.ts`) is the prior art, asserting post-state literals to the wei so a re-recovering engine is caught.
- **In Chromium and WebKit**, through `playwright-browser-harness`, as every webevm spec does, plus one Node run for the export.
- **Impersonation**: two impersonated senders, same nonce, same `to` and data, two different hashes and two receipts; a send after `stopImpersonating` refused; impersonation on a `'recover'` node refused at enable time.
- **Accounts**: the built-in accounts match anvil's default addresses; a mnemonic yields the addresses the standard path derives (checked against published vectors); private keys yield theirs.
- **Signing**: each signature recovers to the account that signed it, and `eth_signTypedData_v4` matches a reference implementation (`viem`, a dev dependency) on EIP-712's own example and on a permit.
- **Forwarding**: `evm_mine`, the state-cheat aliases and the snapshots reach the node untouched.
- **The export**: against the shape rocketh proved (a contract whose constructor stores a value, then the alloc's nonce, balance, code and the slot), as a unit test, plus the manual `forge test` script.

## Out of Scope

- **Anything in webevm's core.** No account, signing or impersonation method moves into `packages/webevm`; its `-32601` edges stay (ADR 0004).
- **The `hardhat_` / `anvil_` aliases of the state cheats, and snapshots**: core changes, cut as `work/tasks/backlog/hardhat-and-anvil-names-for-the-state-cheats.md` and `work/tasks/backlog/snapshots-in-the-core.md`. This spec's tasks that rely on them are blocked by them.
- **Forking a live network**: a separate idea, `work/notes/ideas/fork-a-live-network-in-process.md`.
- **The Solidity side of the forge hand-off** (deployment names and addresses for a test contract): rocketh's spec `deployments-in-solidity`.
- **A mempool, transaction replacement, and `eth_sendTransaction` queueing** beyond what the node's mining mode already does.

## Further Notes

- rocketh's playground (`packages/rocketh-playground/src/core/chain.ts` at rocketh's `origin/main`) already runs rocketh on webevm in a browser, declaring accounts as `privateKey:`; it is prior art for the browser side and the first candidate consumer after rocketh's `memory` runs.
- The node's default fork is now Osaka (pull request #26), where EIP-7825 caps a transaction at 16,777,216 gas. A fill step that copies `eth_estimateGas` is unaffected (the node never recommends more), but a layer that defaults a missing `gas` to the block gas limit, as some tools do, would be refused.
