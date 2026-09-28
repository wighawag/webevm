/**
 * probe-storage-collision.mjs: does each engine refuse a contract creation at an
 * address that already holds STORAGE (EIP-7610), and what does the default
 * engine do per state mode?
 *
 * EIP-7610: a creation must fail with a collision when the target has a non-zero
 * nonce, non-empty code, OR non-empty storage. webevm decided (spec
 * `trie-mode-derives-its-root-from-the-flat-state`) to be spec-current on every
 * node, which only works if BOTH engines refuse the storage case. This measures,
 * through the node's public surface (the SHIPPED build, `packages/webevm/dist`):
 *
 *   engines x modes: default@none, default@trie, revm@none (revm refuses trie)
 *   cases:
 *     storageTop    top-level CREATE (a deployment tx) at an address holding
 *                   storage only (nonce 0, no code; balance 1 wei so the
 *                   account exists, as it would on a real chain)
 *     storageInner  CREATE2 from a factory, same target shape
 *     nonceTop      control: target has nonce 1 (every engine must refuse)
 *     nonceInner    control, inner
 *     emptyTop      control: empty target (every engine must create)
 *     emptyInner    control, inner
 *
 *   per case: receipt status, gasUsed, target code / nonce / slot 0x7 after, and
 *   for the inner cases what CREATE2 returned (the factory stores it in slot 0).
 *
 * Exits non-zero if any row differs from EXPECTED below, so a revm-wasm or
 * @ethereumjs upgrade that changes the answer is noticed.
 *
 *   (cd packages/webevm && pnpm build)
 *   node docs/spikes/revm-eip-7610-storage-collision/probe-storage-collision.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const PKG = new URL("../../../packages/webevm/", import.meta.url);
const require = createRequire(new URL("package.json", PKG));
const { createNode } = await import(new URL("dist/index.js", PKG));
const { createRevmEngine } = await import(new URL("dist/revm.js", PKG));
const viem = await import(require.resolve("viem"));
const { privateKeyToAccount } = await import(require.resolve("viem/accounts"));
const { getContractAddress, createWalletClient, custom, keccak256 } = viem;

const wasmPath = require.resolve("revm-wasm/revm.wasm");
const wasm = await WebAssembly.compile(readFileSync(wasmPath));
const revmVersion = JSON.parse(
  readFileSync(require.resolve("revm-wasm/package.json"), "utf8"),
).version;

const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PK);
const CHAIN_ID = 31337;
const chain = {
  id: CHAIN_ID,
  name: "probe",
  nativeCurrency: { name: "E", symbol: "E", decimals: 18 },
  rpcUrls: { default: { http: [] } },
};

// Init code: MSTORE8(0, 0x42); RETURN(0, 1) -> deployed code is the single byte 0x42.
const INIT = "0x604260005360016000f3";
// Factory runtime: CALLDATACOPY(0,0,size); r = CREATE2(0, 0, size, salt 0);
// SSTORE(0, r); STOP. So slot 0 is the created address, or 0 on failure.
const FACTORY_CODE = "0x365f5f375f365f5ff55f5500";
const FACTORY = "0x00000000000000000000000000000000000fac70";
const SLOT = "0x7";
const WORD7 = "0x" + "00".repeat(31) + "07";

const configs = {
  "default@none": () => ({ stateMode: "none" }),
  "default@trie": () => ({ stateMode: "trie" }),
  "revm@none": async () => ({
    stateMode: "none",
    engine: await createRevmEngine({ wasm }),
  }),
};

async function runCase(configName, caseName) {
  const node = await createNode({
    chainId: CHAIN_ID,
    miningConfig: { type: "auto" },
    initialBalances: { [account.address]: 10n ** 24n },
    ...(await configs[configName]()),
  });
  const rq = (method, params) => node.request({ method, params });
  const wallet = createWalletClient({
    account,
    chain,
    transport: custom(
      { request: ({ method, params }) => rq(method, params) },
      {
        retryCount: 0,
      },
    ),
  });
  const inner = caseName.endsWith("Inner");
  await rq("evm_setCode", [FACTORY, FACTORY_CODE]);
  const target = inner
    ? getContractAddress({
        opcode: "CREATE2",
        from: FACTORY,
        salt: "0x" + "00".repeat(32),
        bytecode: INIT,
      })
    : getContractAddress({
        opcode: "CREATE",
        from: account.address,
        nonce: BigInt(
          await rq("eth_getTransactionCount", [account.address, "latest"]),
        ),
      });
  // The account exists (1 wei) in every case, so "empty" means no nonce, no
  // code, no storage, and the three cases differ in exactly one field.
  await rq("evm_setBalance", [target, "0x1"]);
  if (caseName.startsWith("storage"))
    await rq("evm_setStorageAt", [target, SLOT, WORD7]);
  if (caseName.startsWith("nonce")) await rq("evm_setNonce", [target, "0x1"]);

  let receipt;
  try {
    const hash = await wallet.sendTransaction(
      inner
        ? { to: FACTORY, data: INIT, gas: 300_000n }
        : { data: INIT, gas: 300_000n },
    );
    receipt = await rq("eth_getTransactionReceipt", [hash]);
  } catch (e) {
    receipt = {
      error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160),
    };
  }
  const slot0 = inner
    ? await rq("eth_getStorageAt", [FACTORY, "0x0", "latest"])
    : null;
  return {
    status: receipt?.status ?? receipt?.error,
    gasUsed: receipt?.gasUsed ? Number(BigInt(receipt.gasUsed)) : null,
    contractAddress: receipt?.contractAddress ?? null,
    create2Returned:
      slot0 === null ? null : BigInt(slot0) === 0n ? "0 (failed)" : "target",
    targetCode: await rq("eth_getCode", [target, "latest"]),
    targetNonce: await rq("eth_getTransactionCount", [target, "latest"]),
    targetSlot7: BigInt(
      await rq("eth_getStorageAt", [target, SLOT, "latest"]),
    ).toString(),
  };
}

/**
 * What a collision looks like vs a creation, per case, so the table reads
 * directly. "created": code 0x42 at the target. "collision": no code at the
 * target (a top-level collision is status 0x0 with all gas consumed; an inner
 * one is status 0x1 with CREATE2 returning 0).
 */
function verdict(r) {
  if (typeof r.status === "string" && !r.status.startsWith("0x"))
    return "error";
  return r.targetCode === "0x42" ? "created" : "collision";
}

const EXPECTED = {
  "default@none": {
    storageTop: "created",
    storageInner: "created",
    nonceTop: "collision",
    nonceInner: "collision",
    emptyTop: "created",
    emptyInner: "created",
  },
  "default@trie": {
    storageTop: "collision",
    storageInner: "collision",
    nonceTop: "collision",
    nonceInner: "collision",
    emptyTop: "created",
    emptyInner: "created",
  },
  "revm@none": {
    storageTop: "created",
    storageInner: "created",
    nonceTop: "collision",
    nonceInner: "collision",
    emptyTop: "created",
    emptyInner: "created",
  },
};

console.log("\n=== probe-storage-collision ===");
console.log(`  node ${process.version}, revm-wasm ${revmVersion}`);
const failures = [];
const cases = [
  "storageTop",
  "storageInner",
  "nonceTop",
  "nonceInner",
  "emptyTop",
  "emptyInner",
];
for (const cfg of Object.keys(configs)) {
  console.log(`\n  ${cfg}`);
  for (const c of cases) {
    const r = await runCase(cfg, c);
    const v = verdict(r);
    const ok = v === EXPECTED[cfg][c];
    if (!ok)
      failures.push(`${cfg} ${c}: expected ${EXPECTED[cfg][c]}, got ${v}`);
    console.log(
      `    ${ok ? " " : "!"} ${c.padEnd(13)} ${v.padEnd(10)} status=${r.status} gasUsed=${r.gasUsed} create2=${r.create2Returned} code=${r.targetCode} nonce=${r.targetNonce} slot7=${r.targetSlot7}`,
    );
  }
}
if (failures.length) {
  console.log("\nMISMATCHES against EXPECTED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("\nall rows match EXPECTED");
