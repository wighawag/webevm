/**
 * measure-bottom-level-copy.mjs: what `OverlayStorageStateManager.getAccount`
 * handing out a COPY at the bottom level (no checkpoint open) costs on the
 * default `@ethereumjs/evm` engine.
 *
 *   pnpm install   # also builds packages/webevm/dist, which this reads
 *   node docs/spikes/state-change-set-capture/measure-bottom-level-copy.mjs
 *
 * The copy closes the in-place mutation hazard the per-block change set would
 * otherwise record wrongly (see `getAccount` in packages/webevm/src/state-manager.ts
 * and ./measurements.md). It is paid on every bottom-level read, whether change
 * sets are on or not, so three things are measured:
 *
 *  1. PER READ: `getAccount` at the bottom level, with the copy, against the same
 *     read with no copy (upstream's behaviour, restored by patching the method).
 *  2. HOW MANY bottom-level reads a TRANSACTION makes on the default engine:
 *     counted, because a per-read cost only matters times its count.
 *  3. END TO END: the same signed transfers through the node's public surface,
 *     with and without the copy, recording off and on.
 *
 * Exits non-zero if the counted reads per transaction are not what
 * ./measurements.md states, so a stale figure is a red run.
 */
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Everything is imported from the package's OWN resolution, so the `Account`
// built here is the class `dist/` uses (the ESM build, not a second CJS copy).
const NODE_PKG = new URL("../../../packages/webevm/", import.meta.url);
const require = createRequire(new URL("package.json", NODE_PKG));
const esm = (id) =>
  import(
    pathToFileURL(require.resolve(id).replace("/dist/cjs/", "/dist/esm/")).href
  );
const { Account, createAddressFromString } = await esm("@ethereumjs/util");
const { privateKeyToAccount } = await esm("viem/accounts");
const { createNode, createNodeWithInternals } = await import(
  new URL("dist/node.js", NODE_PKG).href
);
const { OverlayStorageStateManager } = await import(
  new URL("dist/state-manager.js", NODE_PKG).href
);

const proto = OverlayStorageStateManager.prototype;
const copyingGetAccount = proto.getAccount;
/** Upstream's read: the stored object itself, never a copy. */
async function aliasingGetAccount(address) {
  return this.topAccountStack().get(address.toString());
}

// ---- 1. per read --------------------------------------------------------------
async function perRead(label, getAccount) {
  proto.getAccount = getAccount;
  const sm = new OverlayStorageStateManager();
  const a = createAddressFromString("0x" + "11".repeat(20));
  await sm.putAccount(a, new Account(7n, 10n ** 18n));
  const N = 1_000_000;
  for (let i = 0; i < 50_000; i++) await sm.getAccount(a); // warm up
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await sm.getAccount(a);
  const ns = ((performance.now() - t0) * 1e6) / N;
  console.log(`per read, ${label}: ${ns.toFixed(1)} ns`);
  return ns;
}
const readRuns = [];
for (let r = 0; r < 3; r++) {
  readRuns.push({
    copy: await perRead("copy (shipped)", copyingGetAccount),
    alias: await perRead("no copy (upstream)", aliasingGetAccount),
  });
}

// ---- 2 & 3. per transaction ---------------------------------------------------
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);
const TXS = 300;
const raws = [];
for (let n = 0; n < TXS; n++)
  raws.push(
    await account.signTransaction({
      chainId: 31337,
      type: "eip1559",
      nonce: n,
      gas: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      to: "0x" + "22".repeat(20),
      value: 1n,
    }),
  );

let bottomReads = 0;
async function transfers(label, getAccount, record) {
  proto.getAccount = async function (address) {
    if (this.accountStack.length === 1) bottomReads++;
    return getAccount.call(this, address);
  };
  const options = {
    chainId: 31337,
    miningConfig: { type: "auto" },
    initialBalances: { [account.address]: 10n ** 24n },
  };
  const node = record
    ? await createNodeWithInternals(options, { recordChangeSets: true })
    : await createNode(options);
  bottomReads = 0;
  const t0 = performance.now();
  for (const raw of raws)
    await node.request({ method: "eth_sendRawTransactionSync", params: [raw] });
  const ms = (performance.now() - t0) / TXS;
  const perTx = bottomReads / TXS;
  console.log(
    `transfer, ${label}: ${ms.toFixed(3)} ms/tx, ${perTx} bottom-level getAccount per tx`,
  );
  await node.dispose();
  return { ms, perTx };
}
const txRuns = [];
for (let r = 0; r < 3; r++) {
  txRuns.push({
    copyOff: await transfers("copy, recording off", copyingGetAccount, false),
    aliasOff: await transfers(
      "no copy, recording off",
      aliasingGetAccount,
      false,
    ),
    copyOn: await transfers("copy, recording on", copyingGetAccount, true),
  });
}
proto.getAccount = copyingGetAccount;

const EXPECTED_BOTTOM_READS_PER_TX = 1;
const perTx = txRuns[0].copyOff.perTx;
if (perTx !== EXPECTED_BOTTOM_READS_PER_TX) {
  console.error(
    `FAIL: ${perTx} bottom-level reads per transfer, ./measurements.md says ${EXPECTED_BOTTOM_READS_PER_TX}`,
  );
  process.exit(1);
}
console.log("OK");
