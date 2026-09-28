/**
 * differential.mjs: the TRANSITIONAL root differential of
 * `trie-derived-from-the-flat-state`. The same chain is driven through a
 * `stateMode:'trie'` node of the LEGACY build (trie mode on `MerkleStateManager`)
 * and of the NEW build (the flat state plus a derived trie), and every root either
 * one reports is compared: each mined block's header `stateRoot`, and
 * `getStateRoot()` after cheats with no block mined since.
 *
 * It is transitional by design (the task says so): the legacy path is deleted by
 * the same change, so this runs against a legacy BUILD kept outside the tree. The
 * permanent root oracles are the GeneralStateTests post-state roots
 * (`packages/webevm/test/statetest.spec.ts`) and the conformance battery's
 * trie-backed `@ethereumjs/vm` reference. Its output, captured when the change
 * landed, is `measurements.md` beside this file.
 *
 * To re-run it, build `packages/webevm` at the commit before the change
 * (b83704b) with `pnpm build`, copy that `dist` somewhere it can still import
 * `packages/webevm`'s dependencies (the run below used
 * `packages/webevm/node_modules/.webevm-legacy/dist`, with a `package.json`
 * saying `{"type":"module"}` beside it), build the current package, and:
 *
 *   LEGACY_DIST=$PWD/packages/webevm/node_modules/.webevm-legacy/dist \
 *     node docs/spikes/trie-derived-from-the-flat-state/differential.mjs
 *
 * Exits non-zero on the first run that reports a mismatch.
 *
 * WHAT IS DELIBERATELY NOT IN IT: a creation over a storage-only account. The
 * legacy path refuses it (EIP-7610, from `MerkleStateManager`'s real
 * `storageRoot`) and the new one follows the reference spec (created, storage
 * wiped), so the roots are EXPECTED to differ there; that case has its own test
 * (the storage-collision cases in `test/trie-derived.spec.ts`). Storage is also only ever seeded at an
 * address that already has an account, because the legacy
 * `MerkleStateManager.putStorage` throws on a missing one.
 */
import { createRequire } from "node:module";

const PKG = new URL("../../../packages/webevm/", import.meta.url);
const require = createRequire(new URL("package.json", PKG));
const legacyDist = process.env.LEGACY_DIST;
if (!legacyDist) {
  console.error("set LEGACY_DIST to the legacy build (see the header)");
  process.exit(2);
}
const legacy = await import(new URL("index.js", `file://${legacyDist}/`));
const current = await import(new URL("dist/index.js", PKG));
const { privateKeyToAccount } = await import(require.resolve("viem/accounts"));

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);
const CHAIN_ID = 31337;
const BASE_FEE = 1_000_000_000n;
const COINBASE = "0x00000000000000000000000000000000c0173a5e";
const TIMESTAMP = 1_700_000_000n;
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// The post-state battery's shapes (packages/webevm/test/helpers/post-state.ts),
// restated byte for byte because that file is TypeScript for the browser.
const RUNTIME_RETURNS_SLOT0 = "60005460005260206000f3";
const RUNTIME_RETURNS_SLOT1 = "60015460005260206000f3";
const CREATE_INIT = `602a600055600b6011600039600b6000f3${RUNTIME_RETURNS_SLOT0}`;
const CHILD_INIT = "656001600055006000526006601af3";
const NESTED_CREATE_INIT =
  `6e${CHILD_INIT}600052600f60116000f0600155600b6029600039600b6000f3` +
  RUNTIME_RETURNS_SLOT1;
const INNER_ADDR = "0x0000000000000000000000000000000000001111";
const INNER_CODE = "0x60636007550000";
const OUTER_ADDR = "0x0000000000000000000000000000000000002222";
const OUTER_CODE = `0x60016000556000600060006000600073${INNER_ADDR.slice(2)}5af100`;
const EMPTY_ACCOUNT = "0x0000000000000000000000000000000000003333";
const SD_BENEFICIARY = "0x0000000000000000000000000000000000004444";
const SELFDESTRUCT_INIT = `602a60005573${SD_BENEFICIARY.slice(2)}ff`;
const SD2_BENEFICIARY = "0x0000000000000000000000000000000000005555";
const SURVIVOR_RUNTIME = `73${SD2_BENEFICIARY.slice(2)}ff`;
const SURVIVOR_INIT = `606360095575${SURVIVOR_RUNTIME}6000526016600af3`;
// A contract that ZEROES its own slot 0 (`PUSH1 0, PUSH1 0, SSTORE, STOP`), so a
// storage trie loses a leaf through execution rather than through a cheat.
const ZEROER = "0x0000000000000000000000000000000000006666";
const ZEROER_CODE = "0x600060005500";

const GENESIS_CONTRACT = "0x0000000000000000000000000000000000007777";

async function build(lib, miningType) {
  return lib.createNode({
    chainId: CHAIN_ID,
    stateMode: "trie",
    miningConfig: { type: miningType },
    initialBalances: { [account.address]: 10n ** 24n },
    initialState: {
      [GENESIS_CONTRACT]: {
        balance: 3n,
        nonce: 1n,
        code: "0x6001",
        storage: { "0x1": word(0x11), "0x2": word(0x22) },
      },
    },
    blockEnv: { coinbase: COINBASE, timestamp: TIMESTAMP },
  });
}

/** One run: two nodes, one script, every root compared. */
async function run(label, miningType, script) {
  const nodes = {
    legacy: await build(legacy, miningType),
    current: await build(current, miningType),
  };
  const mismatches = [];
  let compared = 0;
  // Not vacuous: the roots must MOVE (a node stuck on one root would agree with
  // itself), and neither may be the zero placeholder of 'none' mode.
  const distinct = new Set();
  let nonce = 0;
  const both = async (method, params) => {
    const out = {};
    for (const [k, n] of Object.entries(nodes)) {
      try {
        out[k] = await n.request({ method, params });
      } catch (e) {
        out[k] = `threw:${e?.message ?? e}`;
      }
    }
    return out;
  };
  const compare = async (where) => {
    const head = await both("eth_getBlockByNumber", ["latest", false]);
    const roots = {};
    for (const [k, n] of Object.entries(nodes))
      roots[k] = await n.getStateRoot();
    compared += 2;
    distinct.add(roots.current);
    if (/^0x0+$/.test(roots.current)) mismatches.push(`${where}: zero root`);
    if (head.legacy.stateRoot !== head.current.stateRoot)
      mismatches.push(
        `${where}: block ${head.current.number} header stateRoot legacy=${head.legacy.stateRoot} current=${head.current.stateRoot}`,
      );
    if (roots.legacy !== roots.current)
      mismatches.push(
        `${where}: getStateRoot legacy=${roots.legacy} current=${roots.current}`,
      );
  };
  const send = async (tx) => {
    const raw = await account.signTransaction({
      chainId: CHAIN_ID,
      type: "eip1559",
      nonce: nonce++,
      gas: tx.gas,
      maxFeePerGas: BASE_FEE * 2n,
      maxPriorityFeePerGas: tx.tip ?? 0n,
      ...(tx.to ? { to: tx.to } : {}),
      ...(tx.data ? { data: tx.data } : {}),
      ...(tx.value !== undefined ? { value: tx.value } : {}),
    });
    const r = await both("eth_sendRawTransaction", [raw]);
    if (String(r.legacy) !== String(r.current))
      mismatches.push(`send: legacy=${r.legacy} current=${r.current}`);
    return r.current;
  };
  const mine = async (where) => {
    for (const n of Object.values(nodes)) await n.mine();
    await compare(where);
  };
  const receipt = async (hash) =>
    (await both("eth_getTransactionReceipt", [hash])).current;
  await compare("genesis");
  await script({ both, send, mine, compare, receipt });
  for (const n of Object.values(nodes)) await n.dispose();
  return { label, compared, distinct: distinct.size, mismatches };
}

// ---- run 1: the post-state battery's shapes, one per block, cheats between ----
const shapes = await run(
  "post-state shapes, auto mining",
  "auto",
  async (c) => {
    await c.both("evm_setCode", [INNER_ADDR, INNER_CODE]);
    await c.both("evm_setCode", [OUTER_ADDR, OUTER_CODE]);
    await c.both("evm_setBalance", [EMPTY_ACCOUNT, "0x0"]);
    await c.compare("cheats after genesis");
    const created = await c.receipt(
      await c.send({ data: `0x${CREATE_INIT}`, gas: 200_000n }),
    );
    await c.compare("creation");
    await c.send({ data: `0x${NESTED_CREATE_INIT}`, gas: 300_000n });
    await c.compare("nested creation");
    await c.send({ to: OUTER_ADDR, data: "0x", gas: 200_000n });
    await c.compare("storage through nested frames");
    // A cheat BETWEEN blocks, then a block that does not touch it.
    await c.both("evm_setStorageAt", [INNER_ADDR, "0x8", word(0x99)]);
    await c.both("evm_setNonce", [INNER_ADDR, "0x5"]);
    await c.compare("cheats between blocks");
    await c.send({ to: EMPTY_ACCOUNT, value: 0n, gas: 100_000n });
    await c.compare("an account emptied to nothing (EIP-161)");
    await c.send({
      data: `0x${SELFDESTRUCT_INIT}`,
      value: 1000n,
      gas: 200_000n,
    });
    await c.compare("selfdestruct in the creating transaction");
    const survivor = await c.receipt(
      await c.send({ data: `0x${SURVIVOR_INIT}`, value: 777n, gas: 200_000n }),
    );
    await c.compare("survivor deployed");
    await c.send({ to: survivor.contractAddress, data: "0x", gas: 200_000n });
    await c.compare("survivor killed (EIP-6780: nothing removed)");
    // A non-zero tip, so the coinbase is credited and stays in state.
    await c.send({ to: SD2_BENEFICIARY, value: 1n, gas: 50_000n, tip: 7n });
    await c.compare("a tip to the coinbase");
    // Storage zeroed by execution, then by a cheat, then the whole account cheated.
    await c.both("evm_setAccount", [
      ZEROER,
      {
        balance: "0x1",
        code: ZEROER_CODE,
        storage: { "0x0": word(5), "0x1": word(6) },
      },
    ]);
    await c.compare("evm_setAccount with storage");
    await c.send({ to: ZEROER, data: "0x", gas: 100_000n });
    await c.compare("a slot zeroed by SSTORE");
    await c.both("evm_setStorageAt", [ZEROER, "0x1", word(0)]);
    await c.compare("a slot zeroed by a cheat (storage trie emptied)");
    await c.both("evm_setStorageAt", [created.contractAddress, "0x0", word(0)]);
    await c.both("evm_setBalance", [GENESIS_CONTRACT, "0x0"]);
    await c.both("evm_setStorageAt", [GENESIS_CONTRACT, "0x3", word(0x33)]);
    await c.compare("cheats after the head");
    await c.mine("an empty block after cheats");
  },
);

// ---- run 2: several transactions per block, manual mining -------------------
const manual = await run(
  "several transactions per block",
  "manual",
  async (c) => {
    await c.both("evm_setCode", [INNER_ADDR, INNER_CODE]);
    await c.both("evm_setCode", [OUTER_ADDR, OUTER_CODE]);
    await c.mine("cheats mined");
    await c.send({ data: `0x${CREATE_INIT}`, gas: 200_000n });
    await c.send({ data: `0x${NESTED_CREATE_INIT}`, gas: 300_000n });
    await c.send({ to: OUTER_ADDR, data: "0x", gas: 200_000n });
    await c.mine("three transactions in one block");
    await c.send({
      data: `0x${SELFDESTRUCT_INIT}`,
      value: 1000n,
      gas: 200_000n,
    });
    await c.both("evm_setStorageAt", [OUTER_ADDR, "0x0", word(0)]);
    await c.compare("cheat with a transaction pending");
    await c.mine("a selfdestruct and a cheat in one block");
    for (let i = 0; i < 5; i++)
      await c.send({
        to: `0x${(0xa0 + i).toString(16).padStart(40, "0")}`,
        value: BigInt(i + 1),
        gas: 50_000n,
        tip: 1n,
      });
    await c.mine("five transfers creating five accounts");
  },
);

// ---- run 3: a randomised cheat sequence, seeded -----------------------------
let seed = 0x5eed;
const rand = (n) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const pool = Array.from(
  { length: 12 },
  (_, i) => `0x${(0xbeef00 + i).toString(16).padStart(40, "0")}`,
);
const randomised = await run("randomised cheats", "auto", async (c) => {
  for (const a of pool) await c.both("evm_setBalance", [a, "0x1"]);
  await c.mine("pool funded");
  for (let step = 0; step < 300; step++) {
    const a = pool[rand(pool.length)];
    switch (rand(6)) {
      case 0:
        await c.both("evm_setBalance", [a, "0x" + rand(1000).toString(16)]);
        break;
      case 1:
        await c.both("evm_setNonce", [a, "0x" + rand(50).toString(16)]);
        break;
      case 2:
        await c.both("evm_setCode", [
          a,
          rand(3) === 0
            ? "0x"
            : "0x60" + rand(256).toString(16).padStart(2, "0"),
        ]);
        break;
      default:
        // Storage writes dominate, and a third of them write ZERO.
        await c.both("evm_setStorageAt", [
          a,
          "0x" + rand(8).toString(16),
          word(rand(3) === 0 ? 0 : rand(1_000_000) + 1),
        ]);
    }
    if (rand(10) === 0) await c.compare(`step ${step}`);
    if (rand(15) === 0) await c.mine(`mined at step ${step}`);
  }
  await c.mine("end");
});

let failed = false;
for (const r of [shapes, manual, randomised]) {
  console.log(
    `${r.mismatches.length === 0 ? "OK" : "XX"} ${r.label}: ${r.compared} roots compared (${r.distinct} distinct), ${r.mismatches.length} mismatches`,
  );
  for (const m of r.mismatches.slice(0, 20)) console.log("   " + m);
  if (r.mismatches.length) failed = true;
}
process.exit(failed ? 1 : 0);
