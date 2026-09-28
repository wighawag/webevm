/**
 * slim-node-checks.ts — in-browser correctness + honesty assertions for the node,
 * covering the common in-browser-node pitfalls and proving it does NOT have them:
 *   1. LEGACY (type-0) tx receipt does NOT crash (the effectiveGasPrice pitfall).
 *   2. EIP-1559 receipt has effectiveGasPrice too, and the RPC TRANSACTION object
 *      carries the 1559 fee fields only where they mean something: present on a
 *      type-2 transaction, ABSENT (not `null`) on a legacy one, as geth reports
 *      them.
 *   3. Account/signing methods fail LOUDLY (method-not-found), never fake success.
 *   4. dump/load persistence round-trips (state survives into a fresh node).
 *   6. The ENGINE seam's honest edges: an engine that cannot start, or cannot
 *      serve the node's configuration, takes construction DOWN — the node never
 *      quietly substitutes the default engine — and an engine handed to the
 *      Worker client is refused by name rather than by an opaque DataCloneError.
 *   8. A DESTROYED account takes its storage with it, in BOTH state modes.
 */
import {
	createNode,
	createMemoryPersistence,
	RpcError,
} from '../../src/index.js';
import type {
	Engine,
	ReadCallResult,
	TransactionResult,
} from '../../src/index.js';
import {createWorkerNode} from '../../src/worker-client.js';
import {
	createWalletClient,
	createPublicClient,
	custom,
	parseGwei,
	getContractAddress,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
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

export async function slimNodeHonestyChecks() {
	const persistence = createMemoryPersistence();
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		persistence,
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	const out: Record<string, unknown> = {};

	// deploy + increments
	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const deployRcpt = await pub.getTransactionReceipt({hash: deployHash});
	const address = deployRcpt.contractAddress!;
	for (let i = 0; i < 3; i++) {
		const h = await wallet.writeContract({
			address,
			abi: counterAbi,
			functionName: 'increment',
		});
		await pub.getTransactionReceipt({hash: h});
	}
	out.number = (
		await pub.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	out.eip1559ReceiptHasEffGasPrice = deployRcpt.effectiveGasPrice != null;

	// 1) LEGACY tx receipt must not crash.
	try {
		const legacyHash = await wallet.sendTransaction({
			to: '0x0000000000000000000000000000000000000001',
			value: 1n,
			gas: 21_000n,
			gasPrice: parseGwei('1'),
			type: 'legacy',
		});
		const r = await pub.getTransactionReceipt({hash: legacyHash});
		out.legacyReceipt = {
			ok: true,
			type: r.type,
			effectiveGasPrice: r.effectiveGasPrice.toString(),
		};

		// 2) ...AND THE RPC TRANSACTION'S FEE FIELDS, READ BY PRESENCE, which is how
		// a consumer reads them. `'maxFeePerGas' in tx` is the standard way to tell a
		// 1559 transaction from a legacy one, so a field that EXISTS and is `null` on
		// a legacy transaction sends the caller down the 1559 branch, where it dies on
		// `BigInt(null)` ("Cannot mix BigInt and other types") nowhere near the cause.
		// geth omits the key entirely; so does this node. The check is deliberately
		// `in` and not a value comparison: a `null` VALUE passes any equality test a
		// caller is likely to write, and is exactly the bug.
		//
		// Asserted on BOTH transaction types from the SAME node, because "omit them
		// always" would satisfy the legacy half alone while breaking every 1559
		// consumer, and read off the raw JSON-RPC object rather than through viem,
		// which normalises the shape away.
		const feeFieldsOf = async (hash: string) => {
			const tx = (await node.request({
				method: 'eth_getTransactionByHash',
				params: [hash],
			})) as Record<string, unknown>;
			return {
				type: String(tx.type),
				hasMaxFeePerGas: 'maxFeePerGas' in tx,
				hasMaxPriorityFeePerGas: 'maxPriorityFeePerGas' in tx,
				hasGasPrice: 'gasPrice' in tx,
			};
		};
		out.legacyTxFeeFields = await feeFieldsOf(legacyHash);
		out.eip1559TxFeeFields = await feeFieldsOf(deployHash);
	} catch (e) {
		out.legacyReceipt = {ok: false, error: String((e as Error)?.message ?? e)};
	}

	// 3) honest gaps
	const probeGap = async (method: string, params: unknown[]) => {
		try {
			await node.request({method, params});
			return 'DID_NOT_THROW';
		} catch (e: any) {
			return `threw:${e?.code ?? '?'}`;
		}
	};
	out.gap_eth_sendTransaction = await probeGap('eth_sendTransaction', [
		{from: account.address, to: account.address},
	]);
	out.gap_eth_accounts = await probeGap('eth_accounts', []);
	out.gap_personal_sign = await probeGap('personal_sign', [
		'0x',
		account.address,
	]);
	out.gap_unknown_method = await probeGap('eth_totallyMadeUp', []);

	// 4) dump/load persistence round-trip into a FRESH node.
	const dumped = await node.dumpState();
	const node2 = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
	});
	await node2.loadState(dumped);
	const pub2 = createPublicClient({
		chain,
		transport: custom(
			{request: ({method, params}: any) => node2.request({method, params})},
			{retryCount: 0},
		),
	});
	out.restoredNumber = (
		await pub2.readContract({address, abi: counterAbi, functionName: 'number'})
	).toString();
	out.restoredBlockNumber = Number(await pub2.getBlockNumber());

	// 5) optional state root: without `computeStateRoot` there is no root
	// (throws); with it the node produces a REAL Merkle-Patricia root, and both
	// agree on the computed result.
	out.noneModeComputesNoRoot = node.computeStateRoot === false;
	let noneThrows = false;
	try {
		await node.getStateRoot();
	} catch (e) {
		noneThrows = e instanceof RpcError && e.code === -32004;
	}
	out.noneModeGetStateRootThrows = noneThrows;

	const trieNode = await createNode({
		chainId: CHAIN_ID,
		computeStateRoot: true,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	const trieTransport = custom(
		{request: ({method, params}: any) => trieNode.request({method, params})},
		{retryCount: 0},
	);
	const triePub = createPublicClient({chain, transport: trieTransport});
	const trieWallet = createWalletClient({
		account,
		chain,
		transport: trieTransport,
	});
	const trieDeploy = await trieWallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const trieAddr = (await triePub.getTransactionReceipt({hash: trieDeploy}))
		.contractAddress!;
	for (let i = 0; i < 3; i++) {
		const h = await trieWallet.writeContract({
			address: trieAddr,
			abi: counterAbi,
			functionName: 'increment',
		});
		await triePub.getTransactionReceipt({hash: h});
	}
	out.trieModeNumber = (
		await triePub.readContract({
			address: trieAddr,
			abi: counterAbi,
			functionName: 'number',
		})
	).toString();
	const trieRoot = await trieNode.getStateRoot();
	out.trieModeStateRoot = trieRoot;
	out.trieModeRootIsReal =
		/^0x[0-9a-f]{64}$/.test(trieRoot) && trieRoot !== '0x' + '00'.repeat(32);
	// block header carries the real root in trie mode, zero in none mode
	const trieBlock = await triePub.getBlock();
	out.trieBlockStateRootMatches = trieBlock.stateRoot === trieRoot;
	const noneBlock = await pub.getBlock();
	out.noneBlockStateRootIsZero = noneBlock.stateRoot === '0x' + '00'.repeat(32);
	await trieNode.dispose();

	// 6) THE ENGINE SEAM'S HONEST EDGES.
	//
	// The read path runs on an injected engine, and the failure that matters here
	// is a SILENT FALLBACK: a consumer who asked for revm and was quietly given
	// `@ethereumjs/evm` would get a node that works, returns correct results, and
	// is an order of magnitude slower than they believe — with no signal at all.
	// So every way an engine can fail to come up has to be loud, at construction.
	Object.assign(out, await engineSeamHonestyChecks());

	await node.dispose();
	await node2.dispose();
	return out;
}

/** The exact cause a failing engine reports, so we can find it in the error. */
const ENGINE_INIT_CAUSE = 'test-engine: the wasm module never arrived';

/** An engine that dies during `connect` — the "failed to initialise" case. */
const engineThatCannotStart: Engine = {
	id: 'test-engine-that-cannot-start',
	connect() {
		throw new Error(ENGINE_INIT_CAUSE);
	},
	async call(): Promise<ReadCallResult> {
		throw new Error('unreachable: this engine never connected');
	},
	async transact(): Promise<TransactionResult> {
		throw new Error('unreachable: this engine never connected');
	},
};

/**
 * An engine that serves ONE chain id and REFUSES any other: the generic "this
 * engine cannot serve your configuration" shape, read off the `EngineContext`
 * at `connect`. It is a stub on purpose: `webevm/revm` is a real INSTANCE of
 * this (it refuses a hardfork it cannot cost, ADR 0008; it used to refuse trie
 * mode, until ADR 0014); what is pinned here is the node-side mechanism, which
 * any third-party engine relies on. (It refused a state mode until the
 * context stopped carrying one, 2026-09-28: no engine needs to know whether the
 * node computes a state root.)
 */
function makeOneChainEngine(): Engine {
	return {
		id: 'test-engine-one-chain',
		connect(ctx) {
			const chainId = ctx.common.chainId();
			if (chainId !== BigInt(CHAIN_ID)) {
				throw new Error(
					`test-engine-one-chain cannot serve chain id ${chainId}`,
				);
			}
		},
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact(): Promise<TransactionResult> {
			throw new Error('test-engine-one-chain: no transaction is mined here');
		},
	};
}

async function engineSeamHonestyChecks(): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = {};
	out.engineInitCause = ENGINE_INIT_CAUSE;

	// Report which engine a node CAME UP on, so a silent fallback would show up as
	// `DID_NOT_THROW:@ethereumjs/evm` rather than as a passing test.
	const probeCreate = async (options: any): Promise<string> => {
		try {
			const n = await createNode(options);
			const id = n.engine.id;
			await n.dispose();
			return `DID_NOT_THROW:${id}`;
		} catch (e) {
			return `threw:${String((e as Error)?.message ?? e)}`;
		}
	};

	// 6a) an engine that FAILS TO INITIALISE takes construction with it, naming
	// the cause it reported.
	out.engineInitFailure = await probeCreate({
		chainId: CHAIN_ID,
		engine: engineThatCannotStart,
	});

	// 6b) a configuration THIS engine cannot serve is refused at construction...
	out.engineRefusedConfiguration = await probeCreate({
		chainId: 1,
		engine: makeOneChainEngine(),
	});
	// ...and the SAME engine comes up for the configuration it does serve, so the
	// refusal is about the configuration rather than about the engine.
	out.engineServedConfiguration = await probeCreate({
		chainId: CHAIN_ID,
		engine: makeOneChainEngine(),
	});

	// 6c) an object that is not an Engine is refused at construction too —
	// otherwise the node comes up and dies at the first `eth_call` with a
	// `not a function` TypeError, which reads like a node bug.
	out.engineNotAnEngine = await probeCreate({
		chainId: CHAIN_ID,
		engine: {id: 'looks-legit-but-has-no-call'} as any,
	});

	// 6c-bis) HALF AN ENGINE IS REFUSED, both ways it can be half.
	//
	// `transact` is REQUIRED: the node executes its transactions on the engine it
	// was given and has no second EVM to fall back to, so an engine that brings only
	// `call` is a missing capability rather than a choice. It was briefly optional,
	// while the shipped revm engine had no write half, and a node with such an engine
	// ran TWO EVMs — which is precisely the misattribution this refusal removes: a
	// receipt from a node can now be attributed to `node.engine`.
	//
	// A PRESENT-BUT-NOT-CALLABLE `transact` is the second half, and it shipped with
	// nothing measuring it. It is the same class of mistake (a half-built engine, a
	// typo, a property that holds a value instead of a method), and a refusal nothing
	// measures is one refactor away from disappearing.
	const readOnlyEngine = makeOneChainEngine() as Partial<Engine>;
	delete readOnlyEngine.transact;
	out.engineWithoutTransact = await probeCreate({
		chainId: CHAIN_ID,
		engine: readOnlyEngine as Engine,
	});
	out.engineWithBrokenTransact = await probeCreate({
		chainId: CHAIN_ID,
		engine: {...makeOneChainEngine(), transact: 'nope'} as any,
	});

	// 6d) the WORKER path. `WorkerNodeOptions extends NodeOptions`, so `engine` is
	// structurally in scope there, but comlink structured-clones the options and an
	// engine is a function-bearing object: without a guard this is an opaque
	// `DataCloneError` from inside comlink — the plausible-looking failure the
	// honest-edge convention exists to prevent. A real Worker is supplied so the
	// refusal is demonstrably about the engine and not about a missing worker.
	const blobUrl = URL.createObjectURL(
		new Blob([''], {type: 'text/javascript'}),
	);
	const worker = new Worker(blobUrl);
	try {
		const wnode = await createWorkerNode({
			worker,
			chainId: CHAIN_ID,
			// `engine` is typed `never` on this path, so TypeScript stops it at compile
			// time; the cast is how a JS consumer (who has no compile step) arrives.
			engine: makeOneChainEngine() as never,
		});
		out.workerEngine = `DID_NOT_THROW:${wnode.engine.id}`;
	} catch (e) {
		out.workerEngine = `threw:${(e as Error)?.name}:${String(
			(e as Error)?.message ?? e,
		)}`;
	} finally {
		worker.terminate();
		URL.revokeObjectURL(blobUrl);
	}

	// 7) a CREATE must not inherit storage that was already sitting at its address.
	// `@ethereumjs/statemanager@10.1.2` ships `SimpleStateManager.clearStorage()` as
	// an empty no-op that drops its address argument, so the EVM's own
	// clear-on-create (evm.js:555) did nothing and a fresh contract silently read a
	// previous tenant's slots. We override it (src/state-manager.ts). Reproduced
	// here through the node's PUBLIC surface: seed slot 0, then deploy onto that
	// exact address.
	//
	// BOTH ('none' and 'trie' below: without and with `computeStateRoot`) follow
	// the reference spec (EIP-684 plus the Yellow Paper,
	// execution-specs PR #3508): a zero-nonce, code-less target that holds storage
	// is NOT a collision, so the creation proceeds and the storage is WIPED. 'trie'
	// used to REJECT it (EIP-7610, from `MerkleStateManager`'s real storageRoot);
	// it now runs on the same flat state as 'none' (ADR 0014). Neither inherits.
	// See work/notes/findings/storage-only-creation-collisions-are-not-refused-by-the-reference-spec.md.
	for (const mode of ['none', 'trie'] as const) {
		const n = await createNode({
			chainId: CHAIN_ID,
			computeStateRoot: mode === 'trie',
			miningConfig: {type: 'auto'},
			initialBalances: {[account.address]: 10n ** 24n},
		});
		const t = custom(
			{request: ({method, params}: any) => n.request({method, params})},
			{retryCount: 0},
		);
		const wallet = createWalletClient({account, chain, transport: t});
		const pub = createPublicClient({chain, transport: t});
		// Where the next deployment from this account will land.
		const nonce = await pub.getTransactionCount({address: account.address});
		const target = getContractAddress({
			from: account.address,
			nonce: BigInt(nonce),
		});
		// Give the target a balance FIRST, so it is an existing account (as it would
		// be on a real chain) and the storage is the only thing it holds besides.
		// A balance is never a collision (the rule reads nonce and code).
		await n.request({method: 'evm_setBalance', params: [target, '0x1']});
		// Seed slot 0 = 99 at that address. No nonce and no code, so the account is
		// not a collision for any reason OTHER than its storage.
		await n.request({
			method: 'evm_setStorageAt',
			params: [
				target,
				`0x${'0'.repeat(64)}`,
				`0x${(99).toString(16).padStart(64, '0')}`,
			],
		});
		out[`seededSlot0.${mode}`] = String(
			await pub.getStorageAt({address: target, slot: `0x${'0'.repeat(64)}`}),
		);
		try {
			const hash = await wallet.deployContract({
				abi: counterAbi,
				bytecode: counterBytecode,
				args: [],
			});
			const rcpt = await pub.waitForTransactionReceipt({hash});
			out[`deployStatus.${mode}`] = rcpt.status;
			out[`deployLandedOnTarget.${mode}`] =
				(rcpt.contractAddress ?? '').toLowerCase() === target.toLowerCase();
			// THE ASSERTION THAT MATTERS: a fresh Counter reads 0, never the seeded 99.
			out[`numberAfterRedeploy.${mode}`] =
				rcpt.status === 'success' && rcpt.contractAddress
					? (
							await pub.readContract({
								address: rcpt.contractAddress,
								abi: counterAbi,
								functionName: 'number',
							})
						).toString()
					: 'n/a';
		} catch (e) {
			out[`deployStatus.${mode}`] =
				`threw:${String((e as Error)?.message ?? e)}`;
			out[`numberAfterRedeploy.${mode}`] = 'n/a';
		}
		await n.dispose();
	}

	// 8) a SELFDESTRUCTED account's storage is GONE, with and without
	// `computeStateRoot`. `SimpleStateManager.deleteAccount` tombstones the account
	// and never touches storage (it has no per-account index to clear with), so a
	// node computing no root used to answer a destroyed contract's slot with its
	// LAST VALUE while a root-computing node (then on `MerkleStateManager`, where
	// deleting the account takes its storage trie with it) answered zero. Measured through this exact surface before the fix: `0x2a`
	// versus `0x0`
	// (docs/spikes/revm-write-callbacks-reproduce-the-post-state/measurements.md).
	// `src/state-manager.ts` now clears on delete, so both modes say zero and the
	// revm engine — whose host is handed `clearStorage` then `removeAccount` for
	// exactly this case — agrees with the default one. Both modes are asserted so
	// the AGREEMENT is pinned, the way the mode ASYMMETRY above is.
	//
	// EIP-6780 (Cancun) is why the contract destroys itself in the transaction that
	// CREATED it: a `SELFDESTRUCT` on any older contract only moves its balance.
	// The init code is `PUSH1 2a, PUSH1 00, SSTORE` (slot 0 = 42) then `PUSH20
	// <beneficiary>, SELFDESTRUCT` — it writes storage and dies without deploying
	// any code, so what is left to observe is the storage and nothing else.
	const SD_BENEFICIARY = '0x0000000000000000000000000000000000004444';
	const SD_INIT = `0x602a60005573${SD_BENEFICIARY.slice(2)}ff` as const;
	for (const mode of ['none', 'trie'] as const) {
		const n = await createNode({
			chainId: CHAIN_ID,
			computeStateRoot: mode === 'trie',
			miningConfig: {type: 'auto'},
			initialBalances: {[account.address]: 10n ** 24n},
		});
		const t = custom(
			{request: ({method, params}: any) => n.request({method, params})},
			{retryCount: 0},
		);
		const wallet = createWalletClient({account, chain, transport: t});
		const pub = createPublicClient({chain, transport: t});
		// An explicit gas limit rather than viem's estimate: the estimate is exact for
		// the top frame, and this transaction has none to spare.
		const hash = await wallet.deployContract({
			abi: [],
			bytecode: SD_INIT,
			value: 1000n,
			gas: 200_000n,
		});
		const rcpt = await pub.waitForTransactionReceipt({hash});
		const destroyed = rcpt.contractAddress!;
		out[`selfdestructStatus.${mode}`] = rcpt.status;
		// It really was destroyed rather than merely emptied: no code, no balance, and
		// the beneficiary holds what it carried.
		out[`selfdestructCode.${mode}`] = String(
			await n.request({method: 'eth_getCode', params: [destroyed, 'latest']}),
		);
		out[`selfdestructBalance.${mode}`] = String(
			await n.request({
				method: 'eth_getBalance',
				params: [destroyed, 'latest'],
			}),
		);
		out[`selfdestructBeneficiary.${mode}`] = String(
			await n.request({
				method: 'eth_getBalance',
				params: [SD_BENEFICIARY, 'latest'],
			}),
		);
		// THE ASSERTION THAT MATTERS: the slot the dead contract wrote reads ZERO.
		out[`selfdestructSlot0.${mode}`] = String(
			await n.request({
				method: 'eth_getStorageAt',
				params: [destroyed, '0x0', 'latest'],
			}),
		);
		await n.dispose();
	}

	return out;
}
