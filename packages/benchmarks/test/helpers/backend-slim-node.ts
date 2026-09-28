/**
 * backend-slim-node.ts — the 4th benchmark backend: webevm, driven the
 * way a real dapp drives a node: a viem walletClient with a LOCAL account signs
 * txs, hitting `eth_sendRawTransaction` over the node's EIP-1193 `request()`.
 * Reads via `eth_call`. No account methods on the node.
 *
 * This is the apples-to-apples comparison row vs ethereumjs-tuned and tevm: same
 * Counter, same 20 increments, same read + compute scenario.
 *
 * It also owns the row for the node with the REVM ENGINE installed — the
 * configuration this feature recommends and the one nobody was measuring. Same
 * file because it is the same backend: same package, same send path, same
 * scenario, one option different (`createNode({engine})`). That engine implements
 * BOTH halves of the seam, so the row measures reads AND transactions on revm,
 * against the node's own state. See {@link EngineChoice} below.
 */
import {createNode, type Engine, type SlimNode} from 'webevm';
import {createRevmEngine} from 'webevm/revm';
import {
	createWalletClient,
	createPublicClient,
	custom,
	pad,
	serializeTransaction,
	type WalletClient,
	type PublicClient,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {EvmBackend} from './scenario.js';
import {intrinsicGasForCall} from './scenario.js';
import {counterAbi} from './counter.js';
import {compiledRevmModule} from './revm-wasm-module.js';

// anvil/hardhat acct 0 private key (== DEPLOYER address in scenario.ts)
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CHAIN_ID = 31337;

const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'slim',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/**
 * Which of the three send paths this row measures. They differ ONLY in how the
 * sender is established, so the deltas isolate secp256k1 cost precisely:
 *
 *   'recover'    sign on the client (~0.3ms) + ecrecover on the node (~1.2ms on
 *                the default engine in Chromium; roughly a quarter of that when
 *                the installed engine brings its own secp256k1 — see
 *                {@link EngineChoice}). What a real node does, and the honest
 *                default.
 *   'trusted'    sign on the client, but hand the node the sender so it SKIPS
 *                ecrecover. Removes the node half only.
 *   'fabricated' NO signing at all: synthesise a dummy signature and hand over
 *                the sender. Removes BOTH halves. This is the shape a higher
 *                layer would use to implement anvil-style impersonation on top
 *                of `evm_sendRawTransactionSyncAs` — it holds no private key.
 *
 * Signing stays INSIDE the measured window for every mode (as it does for every
 * other backend, which all sign inside `sendCall`), so the rows are comparable
 * and the gaps between them mean exactly what they look like.
 */
type SendMode = 'recover' | 'trusted' | 'fabricated';

/**
 * Which EVM answers this row — both its reads (`eth_call` / `eth_estimateGas`)
 * and its transactions.
 *
 *   'default'  the node's own `@ethereumjs/evm`, i.e. `createNode()` untouched.
 *   'revm'     `createRevmEngine()` from the optional `webevm/revm`
 *              subpath — the configuration a consumer opts into.
 *
 * BOTH HALVES MOVE, AND SO DOES THE RECOVERY. The engine executes this row's
 * transactions as well as its reads (it did reads only until the revm write half
 * landed), so `deploy` and `callAvg` are engine-sensitive rather than noise — and
 * since `sender-recovery-uses-the-engines-ecrecover` the node also RECOVERS the
 * sender on the installed engine when it has an `ecrecover` (revm does), which
 * took this row's `callAvg` from 1.92 ms to ~1.08 ms in Chromium. What is left in
 * these two rows that no engine can make cheaper is the CLIENT's own signing, and
 * it now dominates a 21000-gas transfer. The read rows (`read`, `compute`,
 * `keccak`, `frame`, `floor`) remain the ones that isolate the interpreter.
 *
 * The DISTINCTION FROM THE `revm` ROW matters when reading the table: that row is
 * RAW revm owning its own state and driving everything, which is the engine's
 * ceiling. This row is the node ON revm — the same interpreter behind the node's
 * own dispatch, state adapter and RPC layer, which is what a consumer actually
 * ships and therefore what the README should cite.
 */
type EngineChoice = 'default' | 'revm';

/**
 * A dummy signature for the 'fabricated' path.
 *
 * `r` CARRIES THE SENDER ON PURPOSE. `from` is not part of a transaction (it is
 * the output of recovery), so the tx hash comes from the bytes alone. With a
 * constant dummy signature, two different senders sending the same nonce/to/data
 * would produce the SAME hash and silently overwrite each other in the node's
 * receipt/tx maps. Varying `r` by sender makes the bytes, and therefore the hash,
 * unique. This is the documented caller contract (see the `parseTx` docblock in
 * the library, and foundry #4210 where anvil hit the same thing).
 */
const dummySignature = (from: `0x${string}`) =>
	({
		r: pad(from, {size: 32}),
		s: pad('0x1', {size: 32}),
		yParity: 0,
	}) as const;

function makeBackend(
	mode: SendMode,
	engineChoice: EngineChoice = 'default',
	computeStateRoot = false,
): EvmBackend {
	let node: SlimNode;
	let wallet: WalletClient;
	let pub: PublicClient;
	const trusted = mode !== 'recover';
	const senderMode = mode === 'recover' ? 'recover' : 'trusted';

	/** Build the raw tx, then send it down whichever path this row measures. */
	async function buildAndSend(
		to: `0x${string}` | undefined,
		data: `0x${string}`,
		gas: bigint,
	): Promise<any> {
		const tx = {
			chainId: CHAIN_ID,
			nonce: await pub.getTransactionCount({address: account.address}),
			...(to ? {to} : {}),
			data,
			gas,
			maxFeePerGas: 2_000_000_000n,
			maxPriorityFeePerGas: 1_000_000_000n,
			type: 'eip1559',
		} as const;
		// 'fabricated' never touches secp256k1: it stamps on a dummy signature.
		const raw =
			mode === 'fabricated'
				? serializeTransaction(tx as any, dummySignature(account.address))
				: await account.signTransaction(tx as any);
		return trusted
			? node.request({
					method: 'evm_sendRawTransactionSyncAs',
					params: [raw, account.address],
				})
			: node.request({method: 'eth_sendRawTransactionSync', params: [raw]});
	}

	/**
	 * A fresh engine per node. An engine instance binds to exactly ONE node (a
	 * second `createNode()` on the same engine is refused, deliberately — it would
	 * re-point the first node's reads at the second node's state), and the
	 * scenario builds a new node per repeat. The compiled `WebAssembly.Module` is
	 * shared across all of them, which is what the `wasm` option accepting a
	 * compiled module is for: the wasm is compiled once per page, not per run.
	 */
	async function makeEngine(): Promise<Engine | undefined> {
		if (engineChoice === 'default') return undefined;
		return createRevmEngine({wasm: await compiledRevmModule()});
	}

	const baseName =
		engineChoice === 'revm'
			? 'webevm + revm engine (signed eth_sendRawTransactionSync, auto-mine)'
			: {
					recover: 'webevm (signed eth_sendRawTransactionSync, auto-mine)',
					trusted: "webevm senderMode:'trusted' (signed, no ecrecover)",
					fabricated:
						"webevm senderMode:'trusted' (fabricated sig — no secp256k1 at all)",
				}[mode];

	return {
		name: computeStateRoot ? `${baseName} + computeStateRoot` : baseName,

		async setup() {
			node = await createNode({
				chainId: CHAIN_ID,
				senderMode,
				miningConfig: {type: 'auto'},
				initialBalances: {[account.address]: 10n ** 24n},
				// `undefined` on the default rows, so they construct exactly as before.
				engine: await makeEngine(),
				// Only the computeStateRoot rows pass it at all, so every other row
				// constructs exactly as it did before those rows existed.
				...(computeStateRoot ? {computeStateRoot: true} : {}),
			});
			const transport = custom(
				{request: ({method, params}) => node.request({method, params})},
				{retryCount: 0},
			);
			wallet = createWalletClient({account, chain, transport});
			pub = createPublicClient({chain, transport});
		},

		async deploy(bytecode) {
			if (trusted) {
				const rcpt = await buildAndSend(undefined, bytecode, 1_000_000n);
				return rcpt.contractAddress as `0x${string}`;
			}
			const hash = await wallet.deployContract({
				account,
				chain,
				abi: counterAbi,
				bytecode,
			});
			const receipt = await pub.getTransactionReceipt({hash});
			return receipt.contractAddress as `0x${string}`;
		},

		async sendCall(to, data) {
			// The fast path: build raw, send + mine + receipt in ONE call.
			await buildAndSend(to, data, 200_000n);
		},

		async staticCall(to, data) {
			return (await node.request({
				method: 'eth_call',
				params: [{to, data}, 'latest'],
			})) as `0x${string}`;
		},

		// Node surface: eth_estimateGas answers with the smallest gas LIMIT the
		// request succeeds at, which for a call that makes no sub-call and no create
		// IS (execution + intrinsic) — the search proves consumption workable and
		// stops there. Every gas probe in this scenario is exactly that shape (see
		// `intrinsicGasForCall` in ./scenario.ts, which is create-free for the same
		// reason), so subtracting the intrinsic back out recovers the same EXECUTION
		// gas the raw-EVM backends report and the gate compares like with like. A
		// scenario that called out would need the receipt's `gasUsed` instead, since
		// the estimate would then carry the 63/64 headroom on top.
		// Stays on the RPC surface (no reaching into internals), so this is exactly
		// the number a consumer could compute.
		async staticCallGas(to, data) {
			const est = (await node.request({
				method: 'eth_estimateGas',
				params: [{to, data}, 'latest'],
			})) as string;
			return BigInt(est) - intrinsicGasForCall(data);
		},

		async dumpState() {
			return await node.dumpState();
		},
	};
}

export const makeSlimNodeBackend = () => makeBackend('recover');
export const makeSlimNodeTrustedBackend = () => makeBackend('trusted');
export const makeSlimNodeFabricatedBackend = () => makeBackend('fabricated');
/**
 * The node a consumer opts into: the DEFAULT send path (signed, ecrecover — no
 * cheats) with reads on revm. It differs from `makeSlimNodeBackend` by exactly
 * one `createNode` option, so the delta between the two rows IS the engine swap.
 */
export const makeSlimNodeRevmEngineBackend = () =>
	makeBackend('recover', 'revm');
/**
 * THE `computeStateRoot: true` ROWS, one per engine. Each differs from its plain
 * sibling (`makeSlimNodeBackend`, `makeSlimNodeRevmEngineBackend`) by exactly
 * that one `createNode` option, so the delta between the two IS what computing a
 * state root costs on this scenario: `coldStart` gains the trie's build from the
 * genesis state, and each auto-mined block (one transaction, so `deploy` and
 * `callAvg` are per-transaction AND per-block) gains the root update for the
 * keys it changed. The read rows execute no block and should not move at all.
 * How the root update SCALES with keys changed per block is not this scenario's
 * question (it changes one slot per block); see ./root-update.ts.
 */
export const makeSlimNodeComputeStateRootBackend = () =>
	makeBackend('recover', 'default', true);
export const makeSlimNodeRevmEngineComputeStateRootBackend = () =>
	makeBackend('recover', 'revm', true);
