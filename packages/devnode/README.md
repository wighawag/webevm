# @webevm/devnode

Dev accounts for [webevm](https://github.com/wighawag/webevm), the slim, execution-only, in-browser EIP-1193 node.

webevm's core holds no keys: it answers `eth_accounts`, `eth_sendTransaction` and every other account method with a real `-32601`, on purpose. That is right for an application with its own signing client, and not what a deploy tool or a test runner expects from a local chain. This package is the layer those tools need, on top of the core rather than inside it: a node that answers `eth_accounts` with the same test accounts anvil and Hardhat use, funded at genesis as theirs are, and forwards everything else to webevm unchanged.

This release covers the dev accounts, their funding, sending and signing with them (`eth_sendTransaction`, `eth_signTransaction`, `personal_sign`, `eth_sign`, `eth_signTypedData_v4`), impersonation (opt-in, on a `senderMode: 'trusted'` node), an alloc export for forge, and running in a Web Worker (keys on the main thread, or inside the worker).

## Install

```sh
npm install webevm @webevm/devnode
```

`webevm` is a peer dependency, so your app has exactly one copy of the node.

## Usage

```ts
import {createDevNode} from '@webevm/devnode';
import {createWalletClient, createPublicClient, custom} from 'viem';

const node = await createDevNode(); // anvil's ten accounts, 10,000 ETH each

const wallet = createWalletClient({transport: custom(node)});
const [deployer] = await wallet.getAddresses(); // 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266

const client = createPublicClient({transport: custom(node)});
await client.getBalance({address: deployer}); // 10000000000000000000000n
```

`createDevNode(options)` takes every [webevm `createNode` option](https://github.com/wighawag/webevm#readme) (`chainId`, `engine`, `persistence`, `senderMode`, ...) plus:

| option | default | meaning |
|---|---|---|
| `accounts` | anvil's ten | the dev accounts: `{mnemonic, count, path, initialIndex}`, a number (shorthand for `{count}`), or a list of 32-byte hex private keys |
| `balance` | 10,000 ETH | each dev account's genesis balance, in wei (a `bigint`) |
| `fund` | `true` | `false` funds no dev account (`fundAccounts` and `initialBalances` still apply) |
| `fundAccounts` | none | extra addresses to fund at genesis, address to wei (anvil's `--fund-accounts`) |
| `impersonation` | `false` | answer `hardhat_impersonateAccount` / `anvil_impersonateAccount` and send from impersonated addresses; creates the node with `senderMode: 'trusted'` (see [Impersonation](#impersonation)) |

The mnemonic defaults to `test test test test test test test test test test test junk`, the path to `m/44'/60'/0'/0` (account `i` is at `m/44'/60'/0'/0/{initialIndex + i}`), `count` to 10 and `initialIndex` to 0, exactly as on anvil and Hardhat, so an index-declared account (`deployer: 0`) resolves to the same address here as there. An invalid mnemonic, private key, count or index throws, naming the option.

```ts
await createDevNode({accounts: {mnemonic: myMnemonic, count: 3}});
await createDevNode({accounts: [deployerKey, userKey], balance: 100n * 10n ** 18n});
await createDevNode({fundAccounts: {'0x...': 10n ** 18n}});
```

## Funded at genesis

The dev accounts' balances go into webevm's `initialBalances` when the node is created, so they are block 0's state, as on anvil and Hardhat: the accounts can send at once, and no balance is rewritten afterwards. The precedence, lowest first, is each dev account's `balance`, then `fundAccounts`, then your own `initialBalances` (compared case-insensitively).

Like every `initialBalances`, this applies to a NEW genesis only. A chain restored with `loadState(dump)`, or by `persistence` at construction, keeps its own balances. A dump of a dev chain contains the funded dev accounts, as anvil's state dumps do: they are genesis state.

## Wrapping a node you already have

```ts
import {createNode} from 'webevm';
import {wrapDevNode, devAccountBalances} from '@webevm/devnode';

const accounts = {mnemonic: myMnemonic};
const node = wrapDevNode(
	await createNode({initialBalances: devAccountBalances({accounts})}),
	{accounts},
);
```

`wrapDevNode(node, {accounts})` FUNDS NOTHING, because genesis is decided when a node is created. To fund a node created elsewhere (a `createWorkerNode()` whose keys stay on the main thread, say), pass `devAccountBalances(options)` as its `initialBalances`: it returns exactly the balances `createDevNode` would fund for the same options.

## In a Web Worker

webevm runs a node in a Worker with `createWorkerNode()` (`webevm/worker-client`) and `exposeNode()` (`webevm/worker-host`); both need `comlink`, an optional peer of webevm and of this package. The dev layer goes on either side of that boundary.

### Keys on the main thread

```ts
import {createWorkerNode} from 'webevm/worker-client';
import {wrapDevNode, devAccountBalances} from '@webevm/devnode';

const accounts = {mnemonic: myMnemonic};
const worker = new Worker(new URL('webevm/worker-entry', import.meta.url), {type: 'module'});
const node = wrapDevNode(
	await createWorkerNode({worker, initialBalances: devAccountBalances({accounts})}),
	{accounts},
);
```

The EVM runs in the worker; the accounts, sends and signatures are answered on the main thread, which holds the keys. `wrapDevNode` funds nothing, so the genesis balances go to `createWorkerNode()` as its `initialBalances`, exactly the ones `createDevNode` would fund. Any worker module works, a plain `webevm/worker-entry` or your own `exposeNode({createEngine})` one. For impersonation, create the worker node with `senderMode: 'trusted'` as well.

### Keys in the worker

```ts
// dev-worker.ts
import {exposeDevNode} from '@webevm/devnode/worker-host';
import {createRevmEngine} from 'webevm/revm'; // optional: omit createEngine for the default engine
import wasm from 'revm-wasm/revm.wasm';

exposeDevNode({
	createEngine: () => createRevmEngine({wasm}),
	accounts: {mnemonic: myMnemonic},
	impersonation: true,
});
```

```ts
// main thread: webevm's own client, unchanged
import {createWorkerNode} from 'webevm/worker-client';

const worker = new Worker(new URL('./dev-worker.ts', import.meta.url), {type: 'module'});
const node = await createWorkerNode({worker, chainId: 31337});
await node.request({method: 'eth_accounts'}); // the dev accounts, answered in the worker
```

`exposeDevNode(options)` takes `createEngine` (as `webevm/worker-host`'s `exposeNode` does) and the dev options `accounts`, `balance`, `fund`, `fundAccounts` and `impersonation`. It hands webevm's worker host a node factory, so each `createWorkerNode()` creates the node in the worker with `createDevNode({...mainThreadOptions, ...devOptions})`: the genesis is funded there, and the keys and the mnemonic are written in the worker module and never cross to the main thread. Every other option (`chainId`, `miningConfig`, `senderMode`, `initialBalances`, ...) is the main thread's, passed to `createWorkerNode()` as usual, and its `initialBalances` still win over the dev funding for the same address (which is why `initialBalances` is not an `exposeDevNode` option: the worker funds extra addresses with `fundAccounts`). The node crosses the boundary through webevm's own proxy, so every `SlimNode` member works, and an error the layer raises (`4100` for an address it holds no key for, say) reaches the main thread as a real `RpcError` with its `code`.

A bad mnemonic, key, count or `balance` does not throw from `exposeDevNode` (a throw while the worker module evaluates would leave `createWorkerNode()` pending forever): it is logged in the worker at once, and `createWorkerNode()` rejects with the same message. A bad `createEngine` is reported the same way, by webevm. Call `exposeDevNode` once per worker and await nothing at the module's top level before it, as with `exposeNode`. `createDevNodeWorkerApi(options)` returns the same api without exposing it, to compose into a larger comlink api of your own.

**Which one serves `serveOn`'s ports.** A layer on the MAIN thread over a worker proxy serves its ports from the main thread (it must, to answer the account methods there), so a consumer holding the other end of a port reaches the worker through the main thread: that shape gives up `serveOn`'s worker-to-worker path. The layer inside the worker keeps it: the port is transferred to the worker, which answers the account methods itself.

This needs a `webevm` with `exposeNode`'s node factory (`>=0.10.0`, the peer minimum). On an older webevm the factory would be ignored silently, and the worker would run a plain node with no dev accounts.

## Sending from a dev account

```ts
const hash = await wallet.sendTransaction({account: deployer, to, value: 1n, chain: null});
// or, raw: node.request({method: 'eth_sendTransaction', params: [{from: deployer, to, value: '0x1'}]})
```

`eth_sendTransaction` with a dev account's `from` fills what the request leaves out, signs with that account's key, submits it to the node, and returns the hash. Under auto mining it is mined before the call returns, like any submitted transaction.

**What is filled, and only that.** The nonce from the pending nonce (`eth_getTransactionCount` at `pending`, so a send queued behind an unmined one gets the next nonce); `gas` from `eth_estimateGas` on the same request (its access list and authorization list are charged); the fees from the node's fee market as `eth_fillTransaction` fills them: `maxPriorityFeePerGas` is the node's priority fee and `maxFeePerGas` its base fee plus that, or `gasPrice` from `eth_gasPrice` for a legacy transaction. A field you name is sent as named, a stale `nonce` included (which the node then refuses as a replay).

**The type follows the fields, and nothing is dropped.** A `gasPrice` sends type 0, or type 1 with an `accessList`; an `authorizationList` sends type 4 (EIP-7702, which the node refuses before Prague, in its own words); anything else is type 2, carrying any `accessList`. An explicit `type` (0, 1, 2 or 4) is honoured. Unlike `eth_fillTransaction`, which drops an access list, a request that cannot be sent as named is refused with `-32602` rather than trimmed: `gasPrice` alongside EIP-1559 fees or an authorization list, an access list on type 0, blob (type 3) fields, `data` and `input` that differ, or a `chainId` that is not the node's.

**One at a time.** Each send is filled, signed and submitted as one operation on a queue, so concurrent sends from one account get consecutive nonces.

**From an account the node holds no key for**, the request is refused with `4100` (EIP-1193's "Unauthorized"), naming the remedies: configure its key in `accounts`, or impersonate it (with the `impersonation` option on, the message names `hardhat_impersonateAccount` for that address). Nothing is sent and nothing moves.

### The two send paths, by `senderMode`

| node | how a dev account's transaction is submitted |
|---|---|
| `senderMode: 'recover'` (the default) | `eth_sendRawTransaction(raw)`: the node recovers the sender from the signature, as for any client |
| `senderMode: 'trusted'` | `evm_sendRawTransactionAs(raw, from)`: the node is told the sender and skips the recovery, which is cheaper |

Either way the transaction carries the account's REAL signature. So a chain built on a `'trusted'` dev node is still ordinary chain history: its transactions (`dumpState().transactions[hash].raw`) replay on a `'recover'` node, or any other node of the same chain ID, under the same hash and sender. [ADR 0002](https://github.com/wighawag/webevm/blob/main/docs/adr/0002-trusted-sender-is-a-primitive-impersonation-is-not-our-job.md)'s portability caveat is about fabricated signatures only, which the dev accounts never use. Signing is deterministic (RFC 6979), so the same request on the same state is the same transaction in either mode.

## Signing with a dev account

```ts
const signature = await wallet.signMessage({account: deployer, message: 'Sign in to example.org'});
const permit = await wallet.signTypedData({account: deployer, domain, types, primaryType: 'Permit', message});
const raw = await wallet.signTransaction({account: deployer, to, value: 1n, chain: null});
```

| method | parameters | signs |
|---|---|---|
| `personal_sign` | `[message, address]` (MetaMask's and geth's order) | the EIP-191 personal message: `0x` hex as the bytes it spells, any other string as UTF-8 text, as MetaMask reads it |
| `eth_sign` | `[address, message]` (geth's order) | the same EIP-191 personal message, `message` as `0x` hex; never a raw hash |
| `eth_signTypedData_v4` | `[address, typedData]`, an object or its JSON text | the EIP-712 digest of `typedData` |
| `eth_signTransaction` | `[request]` | the transaction `eth_sendTransaction` would send for the same request, filled the same way; it returns the raw signed transaction as hex and submits nothing (pass it to `eth_sendRawTransaction`) |

A signature is the 65 bytes `r ‖ s ‖ v` with `v` 27 or 28, as viem, MetaMask and geth return it, deterministic (RFC 6979) and low-`s`: the same message signs to the same bytes as viem's `privateKeyToAccount(key).signMessage` / `signTypedData`. The EIP-712 encoder is this package's own (no dependency): referenced types sorted by name in the type encoding, nested structs, fixed and dynamic arrays (nested too), `bytes` and `string` hashed, every `intN` / `uintN` / `bytesN`, `bool` and `address`. A missing `EIP712Domain` type is derived from the domain's fields, as viem and ethers derive it; a value that does not fit its type (a missing member, an integer out of range, a `bytesN` of the wrong length) is refused with `-32602` naming its path, never coerced.

An address the node holds no key for is refused with `4100`, naming the `accounts` option. Nothing is ever signed for an address without its key, an impersonated one included.

## Impersonation

```ts
const node = await createDevNode({impersonation: true, fundAccounts: {[whale]: 10n ** 21n}});
await node.request({method: 'hardhat_impersonateAccount', params: [whale]});
await node.request({method: 'eth_sendTransaction', params: [{from: whale, to, value: '0x1'}]});
await node.request({method: 'hardhat_stopImpersonatingAccount', params: [whale]});
```

Off by default. With `impersonation: true`, `hardhat_impersonateAccount [address]` and `hardhat_stopImpersonatingAccount [address]`, and the same two under their `anvil_` names, add an address to (or remove it from) the impersonated set; each returns `null`, as anvil answers them, and stopping an address that is not impersonated is no error. `eth_sendTransaction` from an impersonated address is filled exactly as a dev account's is, given a FABRICATED signature (a fixed low `s` and an `r` derived from the address, so two impersonated senders sending otherwise identical transactions still get two different hashes), and sent through webevm's `evm_sendRawTransactionAs(raw, from)`: the transaction executes AS that address, its balance charged and its nonce advanced.

**It needs a `senderMode: 'trusted'` node**, because that is the only kind that takes a sender it is told rather than one it recovers. `createDevNode({impersonation: true})` creates one, and refuses an explicit `senderMode: 'recover'` alongside the option; `wrapDevNode(node, {impersonation: true})` throws at once on a node that is not `'trusted'`, naming the option. While the option is off, the four methods answer a real `-32601` naming it (rocketh swallows that error, so its message is where you learn what to switch on).

**No signature that is not one.** Every signing method (`eth_signTransaction`, `personal_sign`, `eth_sign`, `eth_signTypedData_v4`) refuses an impersonated address with `4100`, saying no key is held for it. A dev account that is also impersonated still signs, and sends, with its own key. `eth_accounts` never lists an impersonated address.

**A dump holding impersonated transactions is NOT replayable on a `'recover'` node.** Their signatures are fabricated: a `'recover'` node recovers some unrelated address from them, or none, so `dumpState().transactions` of such a chain is not portable chain history ([ADR 0002](https://github.com/wighawag/webevm/blob/main/docs/adr/0002-trusted-sender-is-a-primitive-impersonation-is-not-our-job.md), Consequences). This is the one exception to the rule [above](#the-two-send-paths-by-sendermode): a dev account's own transactions carry real signatures and replay anywhere, on a `'trusted'` node too. `toAllocs` is unaffected, since an alloc carries state only.

## What the wrapped node is

A `SlimNode`, the same interface webevm's own nodes have, so it drops in wherever one goes:

- `request` answers `eth_accounts` with the dev accounts, in order, as lowercase hex (as webevm writes every address). It never lists an impersonated address. It answers `eth_sendTransaction` and the signing methods for a dev account, and the impersonation methods (above). Every other method reaches the node unchanged, its result or its error included: the core's own `-32601` for a method nobody implements arrives exactly as the core raised it.
- `serveOn(port)` serves the dev node's `request`, so a consumer on another thread using `providerOverPort(port)` from `@eip-1193/over-port` sees the dev accounts too.
- `dispose()` stops answering on the ports it served, then disposes the node.
- The cheats and snapshots are the core's, and reach it unchanged: `hardhat_setBalance` / `hardhat_setNonce` / `hardhat_setCode` / `hardhat_setStorageAt` and their `anvil_` names, `evm_mine`, `anvil_mine` / `hardhat_mine`, the time cheats, and `evm_snapshot` / `evm_revert` (and `anvil_snapshot` / `anvil_revert`). The layer holds no chain state of its own (a send reads the pending nonce from the node), so a revert also rolls back what the dev node reads: a dev account that sent inside the snapshot's window sends again at the earlier nonce. See webevm's README for each method's wire shape.
- Every other member (`mine`, `dumpState`, `loadState`, `onNewHead`, `getStateRoot`, `computeStateRoot`, `senderMode`, `engine`) is the node's own.

It works with either engine, the default `@ethereumjs/evm` and `webevm/revm`, in any browser webevm runs in (the suite runs on Chromium and WebKit).

## Handing a chain to forge

`toAllocs(dump)` turns a dump into the genesis alloc map forge's `vm.loadAllocs` accepts, so a `forge test` loads a deployment instead of replaying it:

```ts
import {writeFileSync} from 'node:fs';
import {toAllocs} from '@webevm/devnode';

writeFileSync('allocs.json', JSON.stringify(toAllocs(await node.dumpState())));
```

```solidity
function setUp() public {
    vm.loadAllocs("allocs.json");
}
```

The result is `{address: {nonce, balance, code, storage}}`: nonces and balances as hex quantities, code as hex (`0x` for none), storage keyed by 32-byte slots with 32-byte values. Every account the dump holds is in it, the funded dev accounts included (they are genesis state); the storage root and code hash are left out, since forge recomputes both. It is a pure function of the dump, so it works in Node (a CLI) as in a browser, on any dump: a live node's, a persisted one, either engine's, and a chain whose transactions used fabricated signatures (`senderMode: 'trusted'`), since the alloc carries state only. A malformed dump throws, naming the address and field.

`scripts/forge-load-allocs.mjs` is a MANUAL check that forge really loads it (not run in CI, which has no forge): with forge on the PATH, `pnpm build && node scripts/forge-load-allocs.mjs` deploys a contract whose constructor stores a value, exports the chain, and runs a real `forge test` on it that checks the contract's code, nonce and slot and the dev accounts' balances (`--keep` keeps the generated Foundry project). Its recorded run, under forge 1.7.1: [`docs/spikes/devnode-alloc-export-for-forge/forge-run.md`](https://github.com/wighawag/webevm/blob/main/docs/spikes/devnode-alloc-export-for-forge/forge-run.md).

Why this is a separate package and not part of webevm: [ADR 0017](https://github.com/wighawag/webevm/blob/main/docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md).

## License

MIT
