/**
 * genesis-cheats-perf.ts — three in-browser checks for the slim node:
 *
 *  1. CUSTOM GENESIS: boot the node with an arbitrary `initialState` (funded
 *     EOAs with nonces + a PRE-DEPLOYED contract carrying code AND storage) and
 *     prove a viem client sees exactly that state and can call the pre-deployed
 *     contract straight away (no deploy tx).
 *
 *  2. RUNTIME CHEATS: the anvil/hardhat-style `evm_set*` methods mutate live
 *     state without a tx — assert balance/nonce/code/storage round-trip via the
 *     standard eth_get* reads, without AND with `computeStateRoot` (result labels
 *     `'none'` and `'trie'`).
 *
 *  3. TRIE vs NONE PERF: run the SAME deploy + N increments without and with
 *     `computeStateRoot` and report the per-call / deploy timing delta (trie
 *     pays for a real Merkle-Patricia root each block; none does not).
 *
 * ENGINE-PARAMETERISED for (1) and (2), like the conformance battery: state stays
 * the node's on every engine (ADR 0010), so a custom genesis and the `evm_set*`
 * cheats must behave identically whichever EVM is installed, and
 * {@link runGenesisCheatsOnEngine} runs those two halves on an injected engine
 * rather than duplicating them for it.
 *
 * (3) IS NOT ENGINE-PARAMETERISED: it is a comparison between a node without
 * and one with `computeStateRoot`, on the default engine (`webevm/revm` used to
 * refuse a root-computing node, then trie mode, ADR 0005, and serves it since
 * ADR 0014). Engine performance is measured in
 * `packages/benchmarks`, which is where this repo keeps numbers it looks at.
 */
import {
	createWalletClient,
	createPublicClient,
	custom,
	encodeFunctionData,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createNode, type SlimNode} from '../../src/index.js';

/**
 * Result labels: `'none'` is a node without `computeStateRoot`, `'trie'` one
 * with it. Test-local; the node's option is the boolean.
 */
type RootLabel = 'none' | 'trie';
import type {EngineFactory} from './conformance.js';
import {counterAbi, counterBytecode} from './counter.js';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;
const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

// The deployed runtime bytecode of Counter (constructor stripped). We get this by
// reading getCode after a normal deploy; hardcoding here would be brittle, so the
// custom-genesis check deploys ONCE in a throwaway node to capture runtime code.
async function counterRuntimeCode(makeEngine?: EngineFactory): Promise<string> {
	const n = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: await makeEngine?.(),
	});
	const transport = custom(
		{request: ({method, params}: any) => n.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});
	const h = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const addr = (await pub.getTransactionReceipt({hash: h})).contractAddress!;
	const code = (await n.request({
		method: 'eth_getCode',
		params: [addr, 'latest'],
	})) as string;
	await n.dispose();
	return code;
}

/** What (1) reports: a node booted from an arbitrary `initialState`. */
export interface CustomGenesisReadings {
	eoaBalance: string;
	eoaNonce: string;
	preDeployedCodePresent: boolean;
	preDeployedNumber: string; // storage slot 0 we seeded == 41, then +1 = 42
	numberAfterIncrement: string;
	/** Which EVM the node came up on, so a run on the wrong engine is visible. */
	engineId: string;
}

/** What (2) reports, per state mode: the four `evm_set*` cheats, read back. */
export interface CheatReadings {
	balance: string;
	nonce: string;
	code: string;
	storageSlot7: string;
	engineId: string;
}

export interface GenesisCheatsPerfReport {
	// (1) custom genesis
	customGenesis: CustomGenesisReadings;
	// (2) runtime cheats (per mode)
	cheats: Record<RootLabel, CheatReadings>;
	// (3) perf
	perf: {
		none: {deployMs: number; avgCallMs: number; getRootThrows: boolean};
		trie: {deployMs: number; avgCallMs: number; rootIsReal: boolean};
		callSlowdownX: number; // trie avgCall / none avgCall
		deploySlowdownX: number;
	};
}

const PRE_ADDR = '0x00000000000000000000000000000000c0ffee01';
const RICH_EOA = '0x00000000000000000000000000000000dec0de02';

/**
 * (1) CUSTOM GENESIS, on whichever engine is installed. A node booted from an
 * arbitrary `initialState` — funded EOAs with nonces and a PRE-DEPLOYED contract
 * carrying code AND storage — is read through a viem client, and the pre-deployed
 * contract is CALLED, so the genesis code and storage have to reach EXECUTION and
 * not merely `eth_getCode`.
 */
async function customGenesisChecks(
	makeEngine?: EngineFactory,
): Promise<CustomGenesisReadings> {
	const runtimeCode = await counterRuntimeCode(makeEngine);

	const genesisNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: await makeEngine?.(),
		initialState: {
			// the signing account, funded, so it can send the increment tx
			[account.address]: {balance: 10n ** 24n, nonce: 0n},
			// a rich EOA with a specific nonce (no code)
			[RICH_EOA]: {balance: 1234n * 10n ** 18n, nonce: 7n},
			// a PRE-DEPLOYED Counter with storage slot 0 (its `number`) seeded to 41
			[PRE_ADDR]: {
				balance: 0n,
				code: runtimeCode,
				storage: {'0x00': '0x29'}, // 0x29 = 41
			},
		},
	});
	const gTransport = custom(
		{request: ({method, params}: any) => genesisNode.request({method, params})},
		{retryCount: 0},
	);
	const gPub = createPublicClient({chain, transport: gTransport});
	const gWallet = createWalletClient({account, chain, transport: gTransport});

	const eoaBalance = (await genesisNode.request({
		method: 'eth_getBalance',
		params: [RICH_EOA, 'latest'],
	})) as string;
	const eoaNonce = (await genesisNode.request({
		method: 'eth_getTransactionCount',
		params: [RICH_EOA, 'latest'],
	})) as string;
	const preCode = (await genesisNode.request({
		method: 'eth_getCode',
		params: [PRE_ADDR, 'latest'],
	})) as string;
	// read the pre-deployed contract's `number()` straight away (no deploy needed)
	const preNumber = (
		await gPub.readContract({
			address: PRE_ADDR,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	// call increment() on it -> 41 -> 42
	const incH = await gWallet.writeContract({
		address: PRE_ADDR,
		abi: counterAbi,
		functionName: 'increment',
	});
	await gPub.getTransactionReceipt({hash: incH});
	const afterInc = (
		await gPub.readContract({
			address: PRE_ADDR,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	const engineId = genesisNode.engine.id;
	await genesisNode.dispose();

	return {
		eoaBalance: BigInt(eoaBalance).toString(),
		eoaNonce: BigInt(eoaNonce).toString(),
		preDeployedCodePresent: preCode.length > 2,
		preDeployedNumber: preNumber,
		numberAfterIncrement: afterInc,
		engineId,
	};
}

/**
 * (2) THE RUNTIME CHEATS, on ONE configuration (with or without
 * `computeStateRoot`), on whichever engine is installed. The
 * `evm_set*` methods mutate the node's live state with no transaction, and the
 * readings come back through the standard `eth_get*` calls.
 */
async function cheatChecks(
	computeStateRoot: boolean,
	makeEngine?: EngineFactory,
): Promise<CheatReadings> {
	const n = await createNode({
		chainId: CHAIN_ID,
		computeStateRoot,
		miningConfig: {type: 'auto'},
		engine: await makeEngine?.(),
	});
	const target = '0x00000000000000000000000000000000ca11ab1e';
	await n.request({
		method: 'evm_setBalance',
		params: [target, '0x' + (5n * 10n ** 18n).toString(16)],
	});
	await n.request({method: 'evm_setNonce', params: [target, '0x2a']}); // 42
	await n.request({method: 'evm_setCode', params: [target, '0x60016002']});
	await n.request({
		method: 'evm_setStorageAt',
		params: [target, '0x07', '0x' + 99n.toString(16)],
	});
	const readings: CheatReadings = {
		balance: BigInt(
			(await n.request({
				method: 'eth_getBalance',
				params: [target, 'latest'],
			})) as string,
		).toString(),
		nonce: BigInt(
			(await n.request({
				method: 'eth_getTransactionCount',
				params: [target, 'latest'],
			})) as string,
		).toString(),
		code: (await n.request({
			method: 'eth_getCode',
			params: [target, 'latest'],
		})) as string,
		storageSlot7: BigInt(
			(await n.request({
				method: 'eth_getStorageAt',
				params: [target, '0x07', 'latest'],
			})) as string,
		).toString(),
		engineId: n.engine.id,
	};
	await n.dispose();
	return readings;
}

export async function runGenesisCheatsPerf(): Promise<GenesisCheatsPerfReport> {
	// ---------- (1) CUSTOM GENESIS ----------
	const customGenesis = await customGenesisChecks();

	// ---------- (2) RUNTIME CHEATS (both modes) ----------
	const cheats = {} as GenesisCheatsPerfReport['cheats'];
	for (const mode of ['none', 'trie'] as RootLabel[]) {
		cheats[mode] = await cheatChecks(mode === 'trie');
	}

	// ---------- (3) TRIE vs NONE PERF ----------
	async function measure(mode: RootLabel) {
		const n = await createNode({
			chainId: CHAIN_ID,
			computeStateRoot: mode === 'trie',
			miningConfig: {type: 'auto'},
			initialBalances: {[account.address]: 10n ** 24n},
		});
		const transport = custom(
			{request: ({method, params}: any) => n.request({method, params})},
			{retryCount: 0},
		);
		const pub = createPublicClient({chain, transport});
		const wallet = createWalletClient({account, chain, transport});
		const tDeploy = performance.now();
		const h = await wallet.deployContract({
			abi: counterAbi,
			bytecode: counterBytecode,
			args: [],
		});
		const addr = (await pub.getTransactionReceipt({hash: h})).contractAddress!;
		const deployMs = performance.now() - tDeploy;
		const N = 30;
		const incData = encodeFunctionData({
			abi: counterAbi,
			functionName: 'increment',
		});
		const tCalls = performance.now();
		for (let i = 0; i < N; i++) {
			const raw = await account.signTransaction({
				chainId: CHAIN_ID,
				type: 'eip1559',
				nonce: i + 1,
				to: addr,
				data: incData,
				gas: 200_000n,
				maxFeePerGas: 2_000_000_000n,
				maxPriorityFeePerGas: 1_000_000_000n,
			});
			await n.request({method: 'eth_sendRawTransactionSync', params: [raw]});
		}
		const avgCallMs = (performance.now() - tCalls) / N;
		let getRootThrows = false;
		let rootIsReal = false;
		try {
			const root = await n.getStateRoot();
			rootIsReal =
				/^0x[0-9a-f]{64}$/.test(root) && root !== '0x' + '00'.repeat(32);
		} catch {
			getRootThrows = true;
		}
		await n.dispose();
		return {deployMs, avgCallMs, getRootThrows, rootIsReal};
	}
	// warm up the JIT once, then measure each mode.
	await measure('none');
	const none = await measure('none');
	await measure('trie');
	const trie = await measure('trie');

	const perf = {
		none: {
			deployMs: round(none.deployMs),
			avgCallMs: round(none.avgCallMs),
			getRootThrows: none.getRootThrows,
		},
		trie: {
			deployMs: round(trie.deployMs),
			avgCallMs: round(trie.avgCallMs),
			rootIsReal: trie.rootIsReal,
		},
		callSlowdownX: round(trie.avgCallMs / none.avgCallMs),
		deploySlowdownX: round(trie.deployMs / none.deployMs),
	};

	return {customGenesis, cheats, perf};
}

export interface GenesisCheatsOnEngineReport {
	/** Whether both halves ran on a `computeStateRoot` node. */
	computeStateRoot: boolean;
	customGenesis: CustomGenesisReadings;
	cheats: CheatReadings;
}

/**
 * (1) and (2) with an injected engine, with or without `computeStateRoot` as
 * asked.
 *
 * The unparameterised {@link runGenesisCheatsPerf} keeps covering BOTH on the
 * default engine. (It was written when `webevm/revm` refused trie mode, as a
 * root-computing node was then called; it serves both since ADR 0014, and a
 * root-computing node on revm is covered by
 * `revm-trie-derived.spec.ts`.)
 *
 * (3), the trie-vs-none perf comparison, is not repeated per engine: engine
 * performance belongs to `packages/benchmarks`.
 */
export async function runGenesisCheatsOnEngine(opts: {
	makeEngine: EngineFactory;
	computeStateRoot: boolean;
}): Promise<GenesisCheatsOnEngineReport> {
	return {
		computeStateRoot: opts.computeStateRoot,
		customGenesis: await customGenesisChecks(opts.makeEngine),
		cheats: await cheatChecks(opts.computeStateRoot, opts.makeEngine),
	};
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}
