# @webevm/devnode

Dev accounts for [webevm](https://github.com/wighawag/webevm), the slim, execution-only, in-browser EIP-1193 node.

webevm's core holds no keys: it answers `eth_accounts`, `eth_sendTransaction` and every other account method with a real `-32601`, on purpose. That is right for an application with its own signing client, and not what a deploy tool or a test runner expects from a local chain. This package is the layer those tools need, on top of the core rather than inside it: a node that answers `eth_accounts` with the same test accounts anvil and Hardhat use, funded at genesis as theirs are, and forwards everything else to webevm unchanged.

This release covers the dev accounts, their funding, and an alloc export for forge. Sending from them (`eth_sendTransaction`), signing and impersonation are coming in later releases.

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

## What the wrapped node is

A `SlimNode`, the same interface webevm's own nodes have, so it drops in wherever one goes:

- `request` answers `eth_accounts` with the dev accounts, in order, as lowercase hex (as webevm writes every address). It never lists an impersonated address. Every other method reaches the node unchanged, its result or its error included: the core's own `-32601` for a method nobody implements arrives exactly as the core raised it.
- `serveOn(port)` serves the dev node's `request`, so a consumer on another thread using `providerOverPort(port)` from `@eip-1193/over-port` sees the dev accounts too.
- `dispose()` stops answering on the ports it served, then disposes the node.
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
