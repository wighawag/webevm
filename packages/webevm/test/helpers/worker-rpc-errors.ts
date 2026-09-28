/**
 * worker-rpc-errors.ts: runs in the browser PAGE. Asks one question of every
 * way a node can refuse: does a worker-hosted node (`createWorkerNode`) reject
 * with the SAME error a main-thread node (`createNode`) rejects with, on the same
 * chain? Same `code`, same `message`, same `data`, and a real `RpcError` on this
 * thread (`instanceof RpcError`, `name === 'RpcError'`), as a consumer branching
 * on `code` (viem does, for reverts) needs.
 *
 * It exists because comlink's default `throw` handler carries an `Error` across
 * as `{message, name, stack}` only, so every `RpcError` a worker-hosted node
 * raised used to arrive here with `code === undefined` and no `data`.
 *
 * THE FAILURES: a reverted `eth_call` carrying a custom error as its revert data,
 * a historical read below the head of a node without `stateHistory`, an unknown
 * block hash, an unknown method, malformed params, and `getStateRoot()` on a node
 * without `computeStateRoot`. Then viem's `readContract` against the reverting
 * contract, through both nodes, which must decode the same custom error. And the
 * control: a plain non-RPC `Error` from the worker (a `loadState` of a malformed
 * dump) still arrives as that `Error`, with its message, and is NOT dressed up as
 * an `RpcError`.
 */
import {createNode} from '../../src/node.js';
import {createWorkerNode} from '../../src/worker-client.js';
import {RpcError, type SlimNode} from '../../src/types.js';
import {
	BaseError,
	ContractFunctionRevertedError,
	createPublicClient,
	custom,
	encodeErrorResult,
	toFunctionSelector,
} from 'viem';

const CHAIN_ID = 31337;
const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const ACCOUNT = '0x00000000000000000000000000000000000000aa';

/** The custom error the contract reverts with, and the argument it carries. */
const nopeAbi = [
	{type: 'error', name: 'Nope', inputs: [{name: 'why', type: 'uint256'}]},
	{
		type: 'function',
		name: 'anything',
		inputs: [],
		outputs: [{name: '', type: 'uint256'}],
		stateMutability: 'view',
	},
] as const;
const NOPE_ARG = 42n;

/**
 * Runtime code that reverts EVERY call with `Nope(42)`: the selector left-aligned
 * at memory 0, the uint256 at 4, `revert(0, 36)`.
 */
function nopeRuntime(): string {
	const selector = toFunctionSelector('Nope(uint256)').slice(2);
	return (
		'0x7f' + // PUSH32 selector ++ 28 zero bytes
		selector +
		'00'.repeat(28) +
		'600052' + // PUSH1 0, MSTORE
		'602a600452' + // PUSH1 42, PUSH1 4, MSTORE
		'60246000fd' // PUSH1 36, PUSH1 0, REVERT
	);
}

/** One refusal, as plain values (what is compared across the two nodes). */
export interface Refusal {
	outcome: 'REJECTED' | 'RESOLVED';
	isRpcError: boolean;
	isError: boolean;
	name: string;
	code: unknown;
	message: string;
	data: unknown;
	/** Whether `data` is an OWN property (it is on every `RpcError`). */
	hasData: boolean;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
	try {
		await run();
		return {
			outcome: 'RESOLVED',
			isRpcError: false,
			isError: false,
			name: '',
			code: undefined,
			message: '',
			data: undefined,
			hasData: false,
		};
	} catch (e: any) {
		return {
			outcome: 'REJECTED',
			isRpcError: e instanceof RpcError,
			isError: e instanceof Error,
			name: String(e?.name),
			code: e?.code,
			message: String(e?.message),
			data: e?.data,
			hasData: e !== null && typeof e === 'object' && 'data' in e,
		};
	}
}

/** What viem's `readContract` made of the revert. */
export interface DecodedRevert {
	reverted: boolean;
	errorName: string | undefined;
	args: string[] | undefined;
	/** The raw revert data viem found, whatever it decoded. */
	raw: string | undefined;
}

async function viemReadContract(node: SlimNode): Promise<DecodedRevert> {
	const client = createPublicClient({
		transport: custom({request: (args) => node.request(args)}),
	});
	try {
		await client.readContract({
			address: CONTRACT,
			abi: nopeAbi,
			functionName: 'anything',
		});
		return {
			reverted: false,
			errorName: undefined,
			args: undefined,
			raw: undefined,
		};
	} catch (e) {
		const reverted =
			e instanceof BaseError
				? (e.walk((x) => x instanceof ContractFunctionRevertedError) as
						| ContractFunctionRevertedError
						| undefined)
				: undefined;
		return {
			reverted: reverted !== undefined,
			errorName: reverted?.data?.errorName,
			args: reverted?.data?.args?.map((a) => String(a)),
			raw: reverted?.raw,
		};
	}
}

export interface WorkerRpcErrorsReport {
	/** Per failure: the main-thread node's refusal, then the worker node's. */
	cases: Record<string, {mainThread: Refusal; worker: Refusal}>;
	/** The revert data a `Nope(42)` revert must carry. */
	expectedRevertData: string;
	viem: {mainThread: DecodedRevert; worker: DecodedRevert};
	/** A plain `Error` from the worker, and the same call on the main thread. */
	plainError: {mainThread: Refusal; worker: Refusal};
}

export async function runWorkerRpcErrorChecks(
	workerUrl: string,
): Promise<WorkerRpcErrorsReport> {
	const options = {
		chainId: CHAIN_ID,
		miningConfig: {type: 'manual'} as const,
		initialState: {
			[CONTRACT]: {code: nopeRuntime()},
			[ACCOUNT]: {balance: 10n ** 18n},
		},
	};
	const mainThread = await createNode(options);
	const nodeWorker = new Worker(workerUrl, {type: 'module'});
	const worker = await createWorkerNode({worker: nodeWorker, ...options});
	try {
		// Two blocks, so block 0 is below the head (and refused without
		// `stateHistory`).
		for (const node of [mainThread, worker]) {
			await node.mine();
			await node.mine();
		}

		const failures: Record<string, (node: SlimNode) => Promise<unknown>> = {
			'reverted eth_call (custom error)': (node) =>
				node.request({
					method: 'eth_call',
					params: [{to: CONTRACT, data: '0x12345678'}, 'latest'],
				}),
			'historical read below the head, no stateHistory': (node) =>
				node.request({method: 'eth_getBalance', params: [ACCOUNT, '0x0']}),
			'unknown block hash': (node) =>
				node.request({
					method: 'eth_getBalance',
					params: [ACCOUNT, {blockHash: '0x' + '11'.repeat(32)}],
				}),
			'unknown method': (node) => node.request({method: 'eth_notAMethod'}),
			'malformed params': (node) =>
				node.request({
					method: 'eth_getBlockByNumber',
					params: ['yesterday', false],
				}),
			'getStateRoot without computeStateRoot': (node) => node.getStateRoot(),
		};
		const cases: WorkerRpcErrorsReport['cases'] = {};
		for (const [name, fail] of Object.entries(failures)) {
			cases[name] = {
				mainThread: await refusalOf(() => fail(mainThread)),
				worker: await refusalOf(() => fail(worker)),
			};
		}

		const viem = {
			mainThread: await viemReadContract(mainThread),
			worker: await viemReadContract(worker),
		};

		// A malformed dump: an account whose RLP is not hex. The node throws a
		// plain `Error` for it (no `code`), before it touches any state.
		const badDump = {
			version: 1,
			accounts: {[ACCOUNT]: '0xnothex'},
		} as never;
		const plainError = {
			mainThread: await refusalOf(() => mainThread.loadState(badDump)),
			worker: await refusalOf(() => worker.loadState(badDump)),
		};

		return {
			cases,
			expectedRevertData: encodeErrorResult({
				abi: nopeAbi,
				errorName: 'Nope',
				args: [NOPE_ARG],
			}),
			viem,
			plainError,
		};
	} finally {
		await worker.dispose();
		await mainThread.dispose();
	}
}
