/**
 * engine-seam.ts — the EVM engine seam: the node's read path AND its transactions
 * run on an ENGINE, and with no engine supplied that engine is `@ethereumjs/evm`
 * behaving exactly as it did before the seam existed.
 *
 * What this pins:
 *   1. The DEFAULT engine is `@ethereumjs/evm`, named on the node as `engine`.
 *   2. All THREE read-path callers (`eth_call`, `eth_estimateGas` and
 *      `eth_fillTransaction`'s gas estimation) go through the engine — proven by
 *      an injected stub engine whose answers show up in all three.
 *   3. `eth_estimateGas` keeps its split: the ENGINE reports EXECUTION gas and
 *      the NODE adds intrinsic gas. It now SEARCHES for the smallest workable
 *      gas limit rather than reporting consumption, so what is pinned here is
 *      both the answer (unchanged for a request that succeeds at consumption)
 *      and its COST at the seam: two engine calls, not one.
 *   4. A reverting engine result still surfaces as a real execution-reverted
 *      JSON-RPC error (code 3) carrying the return data.
 *   5. THERE IS NO SECOND EVM. `call` and `transact` are two operations on ONE
 *      engine, so mining a signed tx adds no `call` (they are separate
 *      operations) AND lands on the SAME engine's `transact` — proven by a stub
 *      whose `transact` touches no state: the recipient receives nothing, which
 *      is exactly what the deleted "fall back to the node's own
 *      `@ethereumjs/vm`" path used to hide.
 *   5b. A TRANSACTION TOO LARGE FOR THE BLOCK NEVER REACHES THE ENGINE: the node
 *      refuses it at submit, in words naming its gas limit, the block gas limit
 *      it exceeded and `blockGasLimit` as the knob, and this stub's `transact`
 *      is not called. The block is the node's half of the seam on every engine,
 *      so the answer is the node's rather than each EVM's (`@ethereumjs/vm` used
 *      to be told to skip the check entirely, revm always rejected, and neither
 *      error carries a number or knows the node option exists).
 *   6. The default engine keeps the EIP-2929 warm/access reset AND the
 *      checkpoint/revert that the pure-read path has always done: a repeated
 *      `eth_estimateGas` for a warm SSTORE returns the SAME number (dropping the
 *      reset makes the second one ~2000 gas too low), and an `eth_call` that
 *      would write leaves state untouched.
 *   7. THE MINING PATH GOES THROUGH THE ENGINE: an engine that implements
 *      `transact` executes the transaction, and the node's receipt is assembled
 *      from the neutral {@link TransactionResult} it returned — status, gas used,
 *      effective gas price, logs in emission order, the bloom. A stub returning
 *      values no EVM would produce is what tells "the node asked the engine" apart
 *      from "the node ran `runTx` itself and the numbers happen to match".
 *   8. THE SENDER CROSSES THE SEAM AS A VALUE (`request.sender`), and it is the
 *      node's authoritative one: for an ordinary tx the RECOVERED address, and in
 *      `senderMode:'trusted'` the CLAIMED one even when the signature on the wire
 *      recovers to somebody else. The stub records BOTH what the seam handed it
 *      and what it would have got by re-recovering the transaction itself, so the
 *      divergent case is visible rather than inferred: an engine that recovers its
 *      own sender charges a different account, advances a different nonce, and
 *      returns a receipt that looks perfectly right.
 */
import {createNode} from '../../src/index.js';
import type {
	Engine,
	ReadCallRequest,
	ReadCallResult,
	TransactionRequest,
	TransactionResult,
} from '../../src/index.js';
import {bytesToHex, hexToBytes} from '@ethereumjs/util';
import {
	createWalletClient,
	createPublicClient,
	custom,
	encodeFunctionData,
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

/** The stub's fixed answers — values no real EVM would produce for these calls. */
const STUB_RETURN = ('0x' + '2a'.repeat(32)) as `0x${string}`;
const STUB_EXECUTION_GAS = 12_345n;
/** Intrinsic gas for a call with EMPTY calldata: base only, no per-byte cost. */
const INTRINSIC_EMPTY_CALL = 21_000n;

const TARGET = '0x0000000000000000000000000000000000001234';
/** The address check 8 CLAIMS to be, which is not the one that signed. */
const TRUSTED_CLAIMED = '0x00000000000000000000000000000000000000cc';

/**
 * The transacting stub's fixed answers — again, values no real EVM would produce
 * for a 21000-gas transfer, so a receipt carrying them proves the ENGINE executed
 * the transaction and the node built the receipt from what it reported.
 */
const STUB_TX_GAS_USED = 31_337n;
const STUB_TX_EFFECTIVE_GAS_PRICE = 7n;
const STUB_LOG_ADDRESS = '0x00000000000000000000000000000000000000ff';
const STUB_LOG_TOPIC = ('0x' + 'aa'.repeat(32)) as `0x${string}`;
const STUB_LOG_DATA = '0xc0ffee' as `0x${string}`;
/** A bloom no EVM would compute for that log: recognisable, and 256 bytes long. */
const STUB_LOGS_BLOOM = ('0x' + 'bb' + '00'.repeat(255)) as `0x${string}`;

export async function runEngineSeamChecks() {
	const out: Record<string, unknown> = {};

	// ---------- 1) the DEFAULT engine ----------
	const node = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
	});
	out.defaultEngineId = node.engine.id;

	const transport = custom(
		{request: ({method, params}: any) => node.request({method, params})},
		{retryCount: 0},
	);
	const pub = createPublicClient({chain, transport});
	const wallet = createWalletClient({account, chain, transport});

	const deployHash = await wallet.deployContract({
		abi: counterAbi,
		bytecode: counterBytecode,
		args: [],
	});
	const address = (await pub.getTransactionReceipt({hash: deployHash}))
		.contractAddress!;
	const incrementData = encodeFunctionData({
		abi: counterAbi,
		functionName: 'increment',
	});

	// 6a) EIP-2929 reset: estimating the same warm SSTORE twice must give the SAME
	// number. Without the reset the second estimate is ~2000 gas too low, and viem
	// would use it as a gas LIMIT for the real tx (which then runs out of gas).
	const estimateIncrement = async () =>
		String(
			await node.request({
				method: 'eth_estimateGas',
				params: [{from: account.address, to: address, data: incrementData}],
			}),
		);
	out.estimateIncrement1 = await estimateIncrement();
	out.estimateIncrement2 = await estimateIncrement();
	out.estimateIncrementStable =
		out.estimateIncrement1 === out.estimateIncrement2;

	// 6b) purity: an eth_call that WOULD write leaves state alone.
	const readNumber = async () =>
		(
			await pub.readContract({address, abi: counterAbi, functionName: 'number'})
		).toString();
	const numberBefore = await readNumber();
	await node.request({
		method: 'eth_call',
		params: [{from: account.address, to: address, data: incrementData}],
	});
	const numberAfter = await readNumber();
	out.callDidNotMutateState = numberBefore === numberAfter;
	out.number = numberAfter;

	await node.dispose();

	// ---------- 2) an INJECTED engine ----------
	const seen: {to?: string; data: string; gasLimit: string}[] = [];
	let connectedContextKeys: string | undefined;
	let connectedStateManagerUsable = false;
	let connectCount = 0;

	let stubTransactCount = 0;
	const stub: Engine = {
		id: 'test-stub',
		connect(ctx) {
			connectCount++;
			connectedContextKeys = Object.keys(ctx).sort().join(',');
			connectedStateManagerUsable =
				typeof ctx.stateManager?.getAccount === 'function';
		},
		async call(req: ReadCallRequest): Promise<ReadCallResult> {
			seen.push({
				to: req.to?.toString(),
				data: bytesToHex(req.data),
				gasLimit: req.gasLimit.toString(),
			});
			return {
				returnValue: hexToBytes(STUB_RETURN),
				executionGasUsed: STUB_EXECUTION_GAS,
			};
		},
		// The transaction half of the SAME engine, and it touches no state at all.
		// That is what makes the absence of a fallback measurable below: the transfer
		// gets a receipt (this engine reported one) and the recipient gets nothing
		// (no EVM moved any ether), where the deleted fallback would have executed it
		// on the node's own `@ethereumjs/vm` and credited the recipient for real.
		async transact(): Promise<TransactionResult> {
			stubTransactCount++;
			return {
				status: 1,
				gasUsed: 21_000n,
				effectiveGasPrice: 1n,
				logs: [],
				logsBloom: new Uint8Array(256),
			};
		},
	};

	const stubNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: stub,
	});
	out.stubEngineId = stubNode.engine.id;
	out.stubConnectCount = connectCount;
	out.stubConnectedContextKeys = connectedContextKeys;
	out.stubConnectedStateManagerUsable = connectedStateManagerUsable;

	// eth_call -> the engine's return data, verbatim.
	out.stubCallResult = await stubNode.request({
		method: 'eth_call',
		params: [{from: account.address, to: TARGET}],
	});
	out.stubCallExpected = STUB_RETURN;
	// eth_estimateGas -> engine EXECUTION gas + node intrinsic gas.
	out.stubEstimate = await stubNode.request({
		method: 'eth_estimateGas',
		params: [{from: account.address, to: TARGET}],
	});
	out.stubEstimateExpected =
		'0x' + (STUB_EXECUTION_GAS + INTRINSIC_EMPTY_CALL).toString(16);
	// eth_fillTransaction -> the same estimate on the filled `gas` field.
	const filled = (await stubNode.request({
		method: 'eth_fillTransaction',
		params: [{from: account.address, to: TARGET}],
	})) as {tx: {gas: string}};
	out.stubFilledGas = filled.tx.gas;
	// THE THREE READ-PATH CALLERS, AND WHAT EACH COSTS AT THE SEAM. `eth_call` is
	// one call; the two that answer with a gas LIMIT are a SEARCH (see
	// `estimateGas` in src/node.ts), so each costs the run at the upper bound plus
	// the probe that confirms the measured consumption is a workable limit — two
	// apiece against a stub that always succeeds, which is the short-circuited
	// common case. 1 + 2 + 2.
	out.stubCallsSeen = seen.length;

	// 5) reads and transactions are TWO OPERATIONS ON ONE ENGINE: mining a signed tx
	// adds no `call`, goes to this engine's `transact`, and — because that `transact`
	// touches nothing — leaves the recipient with nothing. The node has no second EVM
	// to quietly mine on.
	const stubTransport = custom(
		{request: ({method, params}: any) => stubNode.request({method, params})},
		{retryCount: 0},
	);
	const stubPub = createPublicClient({chain, transport: stubTransport});
	const stubWallet = createWalletClient({
		account,
		chain,
		transport: stubTransport,
	});
	const txHash = await stubWallet.sendTransaction({
		to: TARGET,
		value: 1n,
		gas: 21_000n,
	});
	const rcpt = await stubPub.getTransactionReceipt({hash: txHash});
	out.stubTxStatus = rcpt.status;
	out.stubTxGasUsed = rcpt.gasUsed.toString();
	out.stubCallsAfterTx = seen.length;
	out.stubTransactCount = stubTransactCount;
	out.stubTargetBalance = (
		await stubPub.getBalance({address: TARGET})
	).toString();

	// 5b) A TRANSACTION TOO LARGE FOR THE BLOCK NEVER REACHES THE ENGINE. Which
	// transactions can fit in a block is the NODE's question on every engine (it
	// builds the block and configures its gas limit), and it is answered before the
	// seam, so the refusal is the same on an engine that enforces the limit
	// (revm), on one that had to be stopped from skipping it (@ethereumjs/vm), and
	// on this stub, which would have returned a receipt for it without noticing.
	// That is what makes the answer identical per engine rather than merely present
	// per engine, and it is the only way the refusal can name `blockGasLimit`,
	// which is the node's option and no engine's concept.
	const overLimitRaw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce: 1,
		to: TARGET,
		value: 1n,
		gas: 40_000_000n,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 1_000_000_000n,
	});
	try {
		await stubNode.request({
			method: 'eth_sendRawTransactionSync',
			params: [overLimitRaw],
		});
		out.overLimitOutcome = 'mined';
		out.overLimitError = '';
		out.overLimitErrorCode = null;
	} catch (e) {
		out.overLimitOutcome = 'refused';
		out.overLimitError = String((e as Error)?.message ?? e);
		out.overLimitErrorCode = (e as {code?: unknown})?.code ?? null;
	}
	// ...and the engine was NOT asked: still the one `transact` from the transfer
	// above.
	out.stubTransactCountAfterOverLimit = stubTransactCount;

	await stubNode.dispose();

	// ---------- 3) a REVERTING engine result stays an honest error ----------
	const revertingNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		engine: {
			id: 'test-reverting',
			async call(): Promise<ReadCallResult> {
				return {
					returnValue: hexToBytes('0xdeadbeef'),
					executionGasUsed: 7n,
					error: 'revert',
				};
			},
			// Never called here; present because an `Engine` implements both halves
			// and a node whose engine does not is refused at construction (asserted in
			// ./slim-node-checks.ts, with the other engine refusals).
			async transact(): Promise<TransactionResult> {
				throw new Error('test-reverting: transact is not exercised here');
			},
		},
	});
	try {
		await revertingNode.request({
			method: 'eth_call',
			params: [{from: account.address, to: TARGET}],
		});
		out.revertingCall = 'DID_NOT_THROW';
	} catch (e: any) {
		out.revertingCall = `threw:${e?.code ?? '?'}:${e?.data ?? '?'}`;
	}
	await revertingNode.dispose();

	// ---------- 7) an engine that TRANSACTS owns the mining path ----------
	// The receipt below can only be built from what this stub returned: it never
	// touches state, so `@ethereumjs/vm` cannot have produced any of these numbers.
	const transacted: {
		hash: string;
		sender: string;
		reRecovered: string;
		to?: string;
		blockNumber: string;
		gasLimit: string;
	}[] = [];
	const transactingStub: Engine = {
		id: 'test-transacting-stub',
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact(req: TransactionRequest): Promise<TransactionResult> {
			transacted.push({
				hash: bytesToHex(req.tx.hash()),
				// THE SEAM'S VALUE, not a property of the transaction this engine was
				// handed: an engine never determines the sender (see check 8 below).
				sender: req.sender.toString(),
				// What this engine WOULD have executed as had it recovered one of its
				// own. Equal to the above for a genuinely-signed tx; the whole point of
				// check 8 is the case where it is not.
				reRecovered: req.tx.getSenderAddress().toString(),
				to: (req.tx as any).to?.toString(),
				blockNumber: req.block.header.number.toString(),
				gasLimit: (req.tx as any).gasLimit.toString(),
			});
			return {
				status: 1,
				gasUsed: STUB_TX_GAS_USED,
				effectiveGasPrice: STUB_TX_EFFECTIVE_GAS_PRICE,
				logs: [
					{
						address: hexToBytes(STUB_LOG_ADDRESS),
						topics: [hexToBytes(STUB_LOG_TOPIC)],
						data: hexToBytes(STUB_LOG_DATA),
					},
				],
				logsBloom: hexToBytes(STUB_LOGS_BLOOM),
			};
		},
	};

	const txNode = await createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: transactingStub,
	});
	const txTransport = custom(
		{request: ({method, params}: any) => txNode.request({method, params})},
		{retryCount: 0},
	);
	const txPub = createPublicClient({chain, transport: txTransport});
	const txWallet = createWalletClient({account, chain, transport: txTransport});
	const engineTxHash = await txWallet.sendTransaction({
		to: TARGET,
		value: 1n,
		gas: 21_000n,
	});
	const engineRcpt = await txPub.getTransactionReceipt({hash: engineTxHash});
	out.engineTxSeen = transacted.length;
	out.engineTxHashSeen = transacted[0]?.hash;
	out.engineTxHashExpected = engineTxHash;
	out.engineTxSenderSeen = transacted[0]?.sender;
	out.engineTxSenderExpected = account.address.toLowerCase();
	// An ordinary tx: the seam's sender IS the recovered one, so the two agree.
	out.engineTxReRecoveredSender = transacted[0]?.reRecovered;
	out.engineTxToSeen = transacted[0]?.to;
	out.engineTxBlockNumberSeen = transacted[0]?.blockNumber;
	out.engineTxGasLimitSeen = transacted[0]?.gasLimit;
	// ...and every receipt field the seam's result owns comes from the engine.
	out.engineRcptStatus = engineRcpt.status;
	out.engineRcptGasUsed = engineRcpt.gasUsed.toString();
	out.engineRcptGasUsedExpected = STUB_TX_GAS_USED.toString();
	out.engineRcptEffectiveGasPrice = engineRcpt.effectiveGasPrice.toString();
	out.engineRcptEffectiveGasPriceExpected =
		STUB_TX_EFFECTIVE_GAS_PRICE.toString();
	out.engineRcptCumulativeGasUsed = engineRcpt.cumulativeGasUsed.toString();
	out.engineRcptContractAddress = engineRcpt.contractAddress ?? null;
	out.engineRcptLogsBloom = engineRcpt.logsBloom;
	out.engineRcptLogsBloomExpected = STUB_LOGS_BLOOM;
	out.engineRcptLogCount = engineRcpt.logs.length;
	out.engineRcptLogAddress = engineRcpt.logs[0]?.address?.toLowerCase();
	out.engineRcptLogAddressExpected = STUB_LOG_ADDRESS;
	out.engineRcptLogTopics = engineRcpt.logs[0]?.topics;
	out.engineRcptLogTopicsExpected = [STUB_LOG_TOPIC];
	out.engineRcptLogData = engineRcpt.logs[0]?.data;
	out.engineRcptLogDataExpected = STUB_LOG_DATA;
	// eth_getLogs reads the same logs out of the block the node built.
	out.engineBlockLogCount = (
		(await txNode.request({
			method: 'eth_getLogs',
			params: [{fromBlock: '0x0', toBlock: 'latest'}],
		})) as unknown[]
	).length;
	// The node's own half is untouched: this engine moved no ether at all, so the
	// balance the node reports is the one its state manager holds.
	out.engineTxTargetBalance = (
		await txPub.getBalance({address: TARGET})
	).toString();

	await txNode.dispose();

	// ---------- 8) the SENDER is a VALUE the seam carries ----------
	// The silent failure this pins: `senderMode:'trusted'` exists so that the
	// CLAIMED sender may differ from the recoverable one, and an engine that
	// recovers its own sender then executes as the WRONG address without erring —
	// same gas, same status, a receipt naming somebody else. So the transaction
	// below is signed by `account` and submitted claiming `TRUSTED_CLAIMED`, and the
	// stub reports BOTH addresses: the one the seam handed it (which must be the
	// claimed one) and the one it would have recovered (which must be the signer).
	// The two DIFFERING is what makes the check meaningful.
	const asTransacted: {sender: string; reRecovered: string}[] = [];
	const asStub: Engine = {
		id: 'test-sender-value-stub',
		async call(): Promise<ReadCallResult> {
			return {returnValue: new Uint8Array(), executionGasUsed: 0n};
		},
		async transact(req: TransactionRequest): Promise<TransactionResult> {
			asTransacted.push({
				sender: req.sender.toString(),
				reRecovered: req.tx.getSenderAddress().toString(),
			});
			return {
				status: 1,
				gasUsed: STUB_TX_GAS_USED,
				effectiveGasPrice: STUB_TX_EFFECTIVE_GAS_PRICE,
				logs: [],
				logsBloom: new Uint8Array(256),
			};
		},
	};
	const asNode = await createNode({
		chainId: CHAIN_ID,
		senderMode: 'trusted',
		miningConfig: {type: 'auto'},
		initialBalances: {
			[account.address]: 10n ** 24n,
			[TRUSTED_CLAIMED]: 10n ** 24n,
		},
		engine: asStub,
	});
	const asRaw = await account.signTransaction({
		chainId: CHAIN_ID,
		nonce: 0,
		to: TARGET,
		value: 1n,
		gas: 21_000n,
		maxFeePerGas: 2_000_000_000n,
		maxPriorityFeePerGas: 1_000_000_000n,
		type: 'eip1559',
	} as any);
	const asRcpt = (await asNode.request({
		method: 'evm_sendRawTransactionSyncAs',
		params: [asRaw, TRUSTED_CLAIMED],
	})) as Record<string, unknown>;
	out.asSenderSeen = asTransacted[0]?.sender;
	out.asSenderExpected = TRUSTED_CLAIMED;
	out.asReRecoveredSender = asTransacted[0]?.reRecovered;
	out.asReRecoveredExpected = account.address.toLowerCase();
	out.asReceiptFrom = String(asRcpt?.from).toLowerCase();
	await asNode.dispose();

	return out;
}
