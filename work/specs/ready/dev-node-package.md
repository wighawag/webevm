---
title: A dev-node package on top of webevm (dev accounts, signing, impersonation, an alloc export)
slug: dev-node-package
needsAnswers: true
---

> Launch snapshot: records intent at creation, NOT maintained. Current truth: `docs/adr/` (decisions) + the code; remaining work: `work/tasks/ready/` tasks. (The technical-detail sections below are trimmed by `to-task` once the work is tasked: they move into tasks/ADRs and this spec settles to its durable framing: Problem / Solution / User Stories / Out of Scope.)


<!-- open-questions -->

## Open questions

1. **How dev accounts get their ETH** (raised by the spec review, 2026-11-20). anvil and Hardhat give each test account 10,000 ETH; a node wrapped by `createDevNode` gives them nothing, so `eth_sendTransaction` from `eth_accounts[0]` is refused as unaffordable. `createDevNode` wraps a node that already exists, so it cannot use the genesis `initialBalances`. Options: (a) top each dev account up with `evm_setBalance` when wrapping; (b) export a helper whose output feeds `createNode({initialBalances})`, which does not work for a mnemonic hosted in a worker, whose accounts the main thread is meant not to know; (c) leave funding to the caller. **Proposed: (a), restricted to accounts that do not EXIST yet**: on wrap, each dev account with no account in state gets `balance` (default 10,000 ETH, an option; `fund: false` turns it off), and an existing account is never touched, so a chain restored by `loadState` or persistence keeps its real balances. It works on the main thread and inside a worker alike, and the funding is ordinary state (it appears in dumps and in the alloc export, as anvil's funded accounts appear in `anvil --dump-state`). Also proposed: **10 default accounts** (anvil's count; Hardhat has 20), configurable.
2. **The package's direct dependencies** (raised by the review). The approved list was `@scure/bip39` and `@scure/bip32`, but the package must also DECLARE what it imports directly, or pnpm will not resolve it and `scripts/check-type-deps.mjs` fails: `@noble/curves` (message signing: `@ethereumjs/util` v10 exports no signing function), `@noble/hashes` (keccak), `@ethereumjs/tx`, `@ethereumjs/util`, `@eip-1193/over-port` (its `serveOn`), and `comlink` as an optional peer (for `/worker-host`). None is new to the install: all are already in webevm's tree. `webevm` itself is proposed as a PEER dependency (with a minimum version that has `wrapNode`), so a consumer never gets two copies of the core. Confirm.

<!-- /open-questions -->

## Answers (decided 2026-11-20 by the maintainer)

What the maintainer decided, with the reasoning, so it travels with the spec.

- **The name: `@webevm/devnode`**, in `packages/devnode` (the maintainer owns the `@webevm` npm scope). It names the thing (a node you develop against, with accounts, as "Hardhat Network" or anvil is) and reads as `createDevNode(node, {accounts})`. Not a subpath of `webevm`: a subpath ships inside the core package, and ADR 0004 rules accounts out of that package.
- **Dependencies: `@scure/bip39` and `@scure/bip32` for mnemonics** (approved; the full direct list is open question 2). **EIP-712 is implemented in this package**, with no runtime dependency: an encoder for `eth_signTypedData_v4` (type encoding, struct hashing, the domain separator, arrays and nested structs), held to `viem`'s `hashTypedData` as a DEV dependency in tests and to EIP-712's own published example.
- **Where dev accounts come from: private keys AND a mnemonic, both now.** Built in: the well-known anvil / Hardhat test accounts, so `eth_accounts[0]` is the same address as on those nodes (rocketh's `deployer: 0` relies on that). Configurable: a list of private keys, or a mnemonic with a count and the standard path `m/44'/60'/0'/0/i`. Dependencies: `@scure/bip39` and `@scure/bip32` (below).
- **`eth_accounts` lists only the accounts whose keys the layer holds**, never impersonated addresses (anvil lists them; rocketh copes with both, and appending them could shift what index-declared accounts resolve to).
- **Signing methods for dev accounts: `eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign` and `eth_signTypedData_v4`.** An impersonated address holds no key, so a request to sign a MESSAGE for one is refused with a real error saying so; its `eth_sendTransaction` works through impersonation.
- **How dev accounts send, by the node's sender mode, and DOCUMENTED.** On a `senderMode: 'trusted'` node they send through `evm_sendRawTransactionAs` with their REAL signature: faster (no ecrecover), and the dump stays replayable on any node, because ADR 0002's portability caveat applies only to fabricated signatures. On a `'recover'` node they send through `eth_sendRawTransaction`. Impersonation is available only on a `'trusted'` node, and enabling it on a `'recover'` one fails at once, naming the option. The package's README states all three facts and the portability distinction.
- **Snapshots live in the CORE**, by ADR 0016's principle (see *Where cheat names live*), with Hardhat's and anvil's semantics: `evm_snapshot` / `evm_revert` and `anvil_snapshot` / `anvil_revert`, a revert consuming that snapshot and every later one, `true` / `false` from a revert. Task `snapshots-in-the-core`. This layer forwards them.
- **The alloc export pads storage values to 32 bytes** (geth's genesis convention). No forge in CI: the export's shape is pinned by a unit test, and a short manual script runs a real `forge test` against an export, run once when the package is built.
- **Fees on a request naming none** are filled as `eth_fillTransaction` fills them: EIP-1559 from the node's fee market, legacy only when the caller passes `gasPrice`.
- **Mining names: answered by the core.** Pull request #23 (ADR 0016) gave webevm `evm_mine`, `anvil_mine` / `hardhat_mine` and the time cheats; this layer forwards them.
- **Worker support: both, and hosting uses an additive `wrapNode` hook in `webevm/worker-host`.** The layer can wrap the proxy `createWorkerNode()` returns (execution in the worker, keys and signing on the main thread), or run inside the worker (keys there too). `exposeNode({createEngine, wrapNode})` calls `wrapNode(node)` once per node, in the worker, on the node `createNode()` built, and exposes what it returns. This package ships `@webevm/devnode/worker-host` with `exposeDevNode({createEngine, accounts, impersonation})`, a one-line use of that hook, and the main thread keeps using webevm's own `createWorkerNode()`. The account configuration is written in the worker module beside `createEngine`, so keys never cross the thread boundary. Rejected: this package shipping its own worker host and client, which would duplicate the one place the thread-crossing node proxy exists (CONTEXT.md, *worker host*: a single literal `Required<SlimNode>`, so a field added to `SlimNode` is a build error there rather than an `undefined` on a consumer's main thread). Not breaking: a worker without `wrapNode` behaves as before.
- **Where cheat names live: cheat ALIASES belong in the core.** ADR 0016's principle: a cheat that is not account policy (ADR 0004) and fabricates nothing a client could mistake for a real node's answer belongs in the core, under the names the other dev nodes use. So the `hardhat_` / `anvil_` names of the state cheats are a core change (task `hardhat-and-anvil-names-for-the-state-cheats`), and so are snapshots. What stays in this package is what the core rules out: accounts, signing and impersonation (ADRs 0002 and 0004), plus the alloc export.

## Decisions taken in review (2026-11-20)

Made by the spec author from the spec review's findings, where the answer follows from the decisions above or from the code; for the maintainer to overturn if wanted.

- **The layer is a `SlimNode` decorator, typed `Required<SlimNode>`**, reaching the node only through `SlimNode`'s public members. It OVERRIDES `request`, `serveOn` (serving its own `request`, so a port it serves answers the account methods) and `dispose` (closing the ports it served before delegating: the inner node's `dispose` closes only the ports the inner node served). Everything else (`mine`, `dumpState`, `loadState`, `getStateRoot`, `onNewHead`, `computeStateRoot`, `senderMode`, `engine`) delegates. A layer on the MAIN thread over a worker proxy serves its ports from the main thread, which gives up the worker-to-worker path of `serveOn` (README, worker section); the package README says so, and hosting the layer inside the worker keeps it.
- **Impersonation is an option, `impersonation`, default OFF.** With it off, `hardhat_impersonateAccount` and its siblings answer a real `-32601` naming the option (rocketh swallows the error, so it must be an honest one, not a silent success). With it on, `createDevNode` refuses a node that is not `senderMode: 'trusted'`. An address that is both a dev account and impersonated sends with its KEY.
- **No signature that is not one.** For an impersonated address, `eth_signTransaction` is refused as well as every message-signing method; only `eth_sendTransaction` works, through impersonation.
- **Transaction types `eth_sendTransaction` builds**: what the request implies, never fewer fields than it names. Type 2 by default, type 0 when it passes `gasPrice`, type 1 when it passes `gasPrice` and an `accessList`, an `accessList` carried on type 2, and type 4 when it carries an `authorizationList` (on a fork that has EIP-7702, else the node's own refusal). Unlike `eth_fillTransaction`, nothing the request names is dropped.
- **Sends are serialised per layer**: fill, sign and submit run as ONE queued operation, so two concurrent `eth_sendTransaction` calls from one account get consecutive nonces instead of the second being refused (ADR 0012 treats concurrent requests as the normal case). The rest of the node's requests still interleave between queued sends, which is harmless: the node serialises them itself.
- **`exposeDevNode` never throws at module scope**, like `exposeNode` (CONTEXT.md, *worker host*): a bad `wrapNode`, key or mnemonic is reported as a VALUE and validated inside `wrapNode`, which runs in `createNode()` and rejects across the boundary, so the main thread rejects instead of hanging. The hook is typed `wrapNode?: (node: SlimNode) => SlimNode | Promise<SlimNode>`.
- **The alloc export is a pure function of a dump**: `toAllocs(state: SerializedState)`, exported by the package, so it works on any dump (a persisted one included), not only a live layer's.

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

A new package in this monorepo, `@webevm/devnode`, layered on webevm, whose only new runtime dependencies are `@scure/bip39` and `@scure/bip32`. It DECORATES a webevm node: `createDevNode(node, options)` takes a `SlimNode` (a main-thread node and a worker proxy alike) and returns a `SlimNode` whose `request` (and `serveOn`, which serves that `request`) answers the account methods dev tooling calls and forwards everything else to the node unchanged, while `mine`, `dumpState`, `loadState` and the rest delegate. Returning a `SlimNode` rather than a bare provider is what lets the same object run on the main thread, over a worker proxy, and inside a worker (see Answers):

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
13. As a deploy-tool author, I want `hardhat_setBalance` and `anvil_setBalance` to set a balance through the wrapped node, so that `fundImpersonatedAccounts`-style lending works. (Served by the core's aliases, which this layer forwards; see Answers.)
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

### Autonomy notes (the two gate axes)

- **`humanOnly`**: not set. Tasking this spec is ordinary work once the questions are answered.
- **`needsAnswers: true`**: two questions raised by the spec review remain (funding the dev accounts, and the package's declared dependencies). The tasker must not cut tasks until they are answered. Task ordering is in its own section below.

## Implementation Decisions

- **A separate workspace package**, `packages/devnode` beside `packages/webevm`, published on its own, with `webevm` as a peer dependency (open question 2). Not a subpath of `webevm`: ADRs 0002 and 0004 keep accounts, signing and impersonation out of the core package entirely.
- **The layer wraps a `SlimNode` and returns one** (see *Decisions taken in review*). Its entry point takes a node (what `createNode()` and `createWorkerNode()` both return) plus options (accounts, funding, impersonation) and returns a `Required<SlimNode>` whose `request` answers the methods above and forwards the rest to `node.request`. It inherits the node's one-request-at-a-time serialisation (ADR 0012) for every forwarded request, and queues its own compound sends (fill, sign, submit) so that they cannot race each other.
- **Worker helpers come for free on the main-thread side.** Because the layer only calls the node's public methods, wrapping the proxy `createWorkerNode()` returns works unchanged: execution in the worker, keys and signing on the main thread. Hosting the layer inside the worker as well is decided; through a `wrapNode` hook in `webevm/worker-host` (see Answers).
- **Transaction signing uses `@ethereumjs/tx`, message signing `@noble/curves`' secp256k1** (`@ethereumjs/util` v10 exports no signing function), keccak `@noble/hashes`. Mnemonics use `@scure/bip39` and `@scure/bip32`; EIP-712 hashing is this package's own code (see Answers). The full declared list is open question 2.
- **Dev accounts send by the node's sender mode**: `evm_sendRawTransactionAs` with their real signature on a `'trusted'` node, `eth_sendRawTransaction` on a `'recover'` one (see Answers). Documented in the package README.
- **Impersonated sends fabricate a signature unique per sender**, as ADR 0002's consequences require: `from` is not part of a transaction, so two fabricated transactions that share a signature, nonce, `to` and data would share a hash. The proposed shape is a fixed low `s` (so EIP-2 never rejects it) and an `r` derived from the claimed sender's address (for example `keccak(address)` reduced into the curve order), the approach foundry adopted after #4210. The node never sees the difference: it is handed `[raw, from]` through `evm_sendRawTransactionAs` and executes as `from` on either engine (ADR 0006 amendment 3).
- **Impersonation requires a `senderMode: 'trusted'` node, and says so.** The layer cannot read a node's sender mode through EIP-1193; `node.senderMode` is on `SlimNode`, which is one reason the layer takes a `SlimNode` rather than a bare provider.
- **The alloc export decodes the dump.** `dumpState().accounts` maps an address to the hex RLP of `[nonce, balance, storageRoot, codeHash]`; the export decodes nonce and balance from it (with `@ethereumjs/util`'s account decoding, already a webevm dependency), takes code from `dumpState().code`, and storage from `dumpState().storage`, whose keys are already 32-byte `0x` hex. The storage-root and code-hash fields are dropped: forge recomputes both. Storage values are padded to 32 bytes. A dump of a chain that used fabricated signatures exports fine: the alloc carries state only, never the transactions.
- **Everything else forwards untouched**, errors included, so the layer cannot become a second source of node behaviour.

## Testing Decisions

- **Through the public surface only**, like the rest of this repo: build a node, wrap it, drive the wrapped node with viem's public and wallet clients (`viem` is already a dev dependency), and read the results back through the node's RPC.
- **On both engines**, because impersonation crosses the engine seam as `TransactionRequest.sender`: the trusted-sender suite's pattern (`packages/webevm/test/helpers/trusted-sender.ts`, run by `trusted-sender.spec.ts` and `revm-trusted-sender.spec.ts`) is the prior art, asserting post-state literals to the wei so a re-recovering engine is caught.
- **In Chromium and WebKit**, through `playwright-browser-harness`, as every webevm spec does, plus one Node run for the export.
- **Impersonation**: two impersonated senders, same nonce, same `to` and data, two different hashes and two receipts; a send after `stopImpersonating` refused; impersonation on a `'recover'` node refused at enable time.
- **Accounts**: the built-in accounts match anvil's default addresses; a mnemonic yields the addresses the standard path derives (checked against published vectors); private keys yield theirs.
- **Signing**: each signature recovers to the account that signed it, and `eth_signTypedData_v4` matches a reference implementation (`viem`, a dev dependency) on EIP-712's own example and on a permit.
- **Forwarding**: `evm_mine`, the state-cheat aliases and the snapshots reach the node untouched (in its own small task, so it alone waits on the core tasks).
- **Workers**, following `packages/webevm/test/helpers/worker-roundtrip.ts`: a worker without `wrapNode` behaves exactly as before; with `exposeDevNode`, every `SlimNode` member of the wrapped node crosses the boundary, an `RpcError` the layer raises arrives whole, and no key or mnemonic ever reaches the main thread; a bad key or `wrapNode` rejects the main thread's `createWorkerNode()` instead of hanging it.
- **Funding**: a fresh node's dev accounts hold the default balance; a loaded node's existing accounts keep theirs; `fund: false` funds nothing.
- **Concurrency and lifecycle**: two concurrent sends from one account both mine, with consecutive nonces; after `dispose()`, a port the layer served no longer answers.
- **The export**: against the shape rocketh proved (a contract whose constructor stores a value, then the alloc's nonce, balance, code and the slot), as a unit test, plus the manual `forge test` script.

## Out of Scope

- **Account policy in webevm's core.** No account, signing or impersonation method moves into `packages/webevm`; its `-32601` edges stay (ADR 0004). The one core change this spec DOES deliver is the `wrapNode` hook in `webevm/worker-host`.
- **The `hardhat_` / `anvil_` aliases of the state cheats, and snapshots**: core changes, cut as `work/tasks/backlog/hardhat-and-anvil-names-for-the-state-cheats.md` and `work/tasks/backlog/snapshots-in-the-core.md`. This spec's tasks that rely on them are blocked by them.
- **Forking a live network**: a separate idea, `work/notes/ideas/fork-a-live-network-in-process.md`.
- **The Solidity side of the forge hand-off** (deployment names and addresses for a test contract): rocketh's spec `deployments-in-solidity`.
- **A mempool and transaction replacement** beyond what the node's mining mode already does. (The layer's per-layer send queue is in scope; it orders sends, it does not hold them.)

## Task ordering (for the tasker)

- **Core tasks**: `hardhat-and-anvil-names-for-the-state-cheats` and `snapshots-in-the-core` (already in `work/tasks/backlog/`), and a `wrapNode` hook in `webevm/worker-host`, cut from this spec. The two backlog tasks both edit `request()` in `src/node.ts` and the README's RPC table, so serialise one behind the other (`blockedBy`) rather than building them in parallel.
- **What waits on what**: the stories that forward `hardhat_setBalance` and the other state-cheat aliases wait on `hardhat-and-anvil-names-for-the-state-cheats`; the snapshot story waits on `snapshots-in-the-core`; the in-worker hosting story waits on the `wrapNode` task. Nothing else in this package waits on the core: accounts, signing, impersonation, funding and the alloc export can be built first.

## Further Notes

- rocketh's playground (`packages/rocketh-playground/src/core/chain.ts` at rocketh's `origin/main`) already runs rocketh on webevm in a browser, declaring accounts as `privateKey:`; it is prior art for the browser side and the first candidate consumer after rocketh's `memory` runs.
- The node's default fork is now Osaka (pull request #26), where EIP-7825 caps a transaction at 16,777,216 gas. A fill step that copies `eth_estimateGas` is unaffected (the node never recommends more), but a layer that defaults a missing `gas` to the block gas limit, as some tools do, would be refused.
