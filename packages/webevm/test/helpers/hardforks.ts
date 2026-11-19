/**
 * hardforks.ts: what each fork `createNode({hardfork})` offers changes, read
 * through the node's PUBLIC surface, so the same battery holds both engines to
 * one set of literals.
 *
 * Per fork (`cancun` is the control: it has none of the rules below):
 *
 *   - `floor`: EIP-7623 (Prague on). A calldata-heavy, execution-free call is
 *     estimated at the floor (`21000 + 10 * tokens`), a transaction whose gas
 *     limit covers its intrinsic gas but not the floor is REFUSED in geth's
 *     words, one at the estimate is mined and its receipt charges the floor, and
 *     an `eth_call` whose gas cannot reach the floor is refused too.
 *   - `cap`: EIP-7825 (Osaka on). A transaction one gas above 2^24 is REFUSED,
 *     one at exactly 2^24 is mined, and `eth_estimateGas` never searches above
 *     the cap. A READ is not held to it, as on geth: an `eth_call` asking for more
 *     runs, and the DEFAULT read budget (read through `GAS`, which is what a
 *     contract sees) is 30,000,000 on every fork.
 *   - `setCode`: EIP-7702 (Prague on). A type-4 transaction delegating an EOA to
 *     a contract, sponsored by another account: `eth_estimateGas` with the
 *     `authorizationList` executes the DELEGATED code (without it the same
 *     request is a bare transfer), the transaction mined at that estimate
 *     succeeds, the authority holds `0xef0100 || target`, its nonce moved, and the
 *     delegated code ran in the authority's storage. An authorization for another
 *     chain is skipped, as EIP-7702 requires, on both the read and the write path.
 *     On Cancun a type-4 transaction is refused before it reaches an engine.
 *   - `osakaOpcodes`: `CLZ` (EIP-7939) runs on Osaka and is an invalid opcode
 *     before it; the estimate of a `MODEXP` call (EIP-7883 re-priced it) and of a
 *     secp256r1 `P256VERIFY` call (EIP-7951 added it) are pinned per fork.
 *   - `blockHash`: EIP-2935 changes no opcode. `BLOCKHASH` reads the node's own
 *     blocks at every fork, and the history contract is absent (the node runs no
 *     block-start system call, and no genesis here carries the contract).
 *   - `dump`: a dump records its fork, reloads into a node on the same fork with
 *     the block hashes intact (a block mined after the reload names the dumped
 *     head as its parent, which covers Prague's extra header field), and is
 *     REFUSED by a node on another fork.
 *
 * ENGINE-PARAMETERISED: test/hardforks.spec.ts runs it on the default engine
 * through ./cut.ts, test/revm-hardforks.spec.ts on revm through ./cut-revm.ts,
 * and both assert test/hardforks-expected.ts. The construction refusals involve
 * no engine and run on the default one only ({@link runHardforkConstructionChecks}).
 */
import {createNode} from '../../src/node.js';
import type {NodeHardfork, SlimNode} from '../../src/types.js';
import type {EngineFactory} from './conformance.js';
import {privateKeyToAccount} from 'viem/accounts';
import {toHex} from 'viem';

const CHAIN_ID = 31337;
const SPONSOR = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const AUTHORITY = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const FUNDING = 10n ** 21n;
const MAX_FEE = 2_000_000_000n;
const PRIORITY_FEE = 1_000_000_000n;

/** `STOP`: a callee that executes nothing, so a call's cost is its calldata. */
const SINK = '0x00000000000000000000000000000000000051c0';
/** `GAS PUSH0 MSTORE PUSH1 32 PUSH0 RETURN`: returns the gas left after `GAS`. */
const GAS_PROBE = '0x0000000000000000000000000000000000006a50';
/** `INVALID`: burns every gas it is given, at every fork. */
const BURNER = '0x000000000000000000000000000000000000b0e5';
/** `PUSH1 1 CLZ PUSH0 MSTORE PUSH1 32 PUSH0 RETURN`: `clz(1)`, 255 on Osaka. */
const CLZ_PROBE = '0x0000000000000000000000000000000000000c12';
/** `PUSH1 42 PUSH1 1 SSTORE STOP`: what the authority is delegated to. */
const DELEGATE = '0x00000000000000000000000000000000de1e6a7e';
/** `PUSH1 1 NUMBER SUB BLOCKHASH PUSH0 MSTORE PUSH1 32 PUSH0 RETURN`. */
const BLOCKHASH_PROBE = '0x00000000000000000000000000000000000b1a5e';
/** EIP-2935's block-hash history contract. */
const HISTORY_CONTRACT = '0x0000f90827f1c53a10cb7a02335b175320002935';
const MODEXP = '0x0000000000000000000000000000000000000005';
const P256VERIFY = '0x0000000000000000000000000000000000000100';

const GENESIS = {
	[SINK]: {code: '0x00'},
	[GAS_PROBE]: {code: '0x5a5f5260205ff3'},
	[BURNER]: {code: '0xfe'},
	[CLZ_PROBE]: {code: '0x60011e5f5260205ff3'},
	[DELEGATE]: {code: '0x602a60015500'},
	[BLOCKHASH_PROBE]: {code: '0x60014303405f5260205ff3'},
};

/** 1000 non-zero calldata bytes: 37000 intrinsic, a 61000 floor from Prague on. */
const HEAVY = ('0x' + 'ff'.repeat(1000)) as `0x${string}`;
/** EIP-7825's per-transaction gas cap. */
const CAP = 16_777_216n;

/** A MODEXP input: base 0x03, exponent 0xffff..ff (32 bytes), modulus 0x05..05. */
const MODEXP_INPUT = ('0x' +
	1n.toString(16).padStart(64, '0') +
	32n.toString(16).padStart(64, '0') +
	32n.toString(16).padStart(64, '0') +
	'03' +
	'ff'.repeat(32) +
	'05'.repeat(32)) as `0x${string}`;
/** 160 bytes of a well-formed-length but invalid secp256r1 verification input. */
const P256_INPUT = ('0x' + '01'.repeat(160)) as `0x${string}`;

type Outcome = string;

/** A request's result, or its refusal as `code: message`. */
async function attempt(
	node: SlimNode,
	method: string,
	params: unknown[],
): Promise<Outcome> {
	try {
		const r = await node.request({method, params});
		return typeof r === 'string' ? r : JSON.stringify(r);
	} catch (e) {
		return `threw ${String((e as {code?: unknown})?.code)}: ${String(
			(e as Error)?.message ?? e,
		)}`;
	}
}

/** The leading clause of a refusal (up to the first full stop), or the result. */
const clause = (o: Outcome) => o.split('. ')[0];

async function nodeOn(
	hardfork: NodeHardfork,
	makeEngine?: EngineFactory,
	extra: Record<string, unknown> = {},
): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		hardfork,
		miningConfig: {type: 'auto'},
		initialBalances: {
			[SPONSOR.address]: FUNDING,
			[AUTHORITY.address]: FUNDING,
		},
		initialState: GENESIS,
		engine: makeEngine ? await makeEngine() : undefined,
		...extra,
	});
}

async function sign1559(
	tx: {to: `0x${string}`; gas: bigint; nonce: number; data?: `0x${string}`},
	signer = SPONSOR,
): Promise<`0x${string}`> {
	return signer.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		maxFeePerGas: MAX_FEE,
		maxPriorityFeePerGas: PRIORITY_FEE,
		value: 0n,
		...tx,
	});
}

/** A receipt reduced to what is compared, or the refusal. */
async function send(node: SlimNode, raw: `0x${string}`) {
	try {
		const r = (await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		})) as {status: string; gasUsed: string; type: string};
		return {
			status: r.status,
			gasUsed: BigInt(r.gasUsed).toString(),
			type: r.type,
		};
	} catch (e) {
		return {
			refused: `${String((e as {code?: unknown})?.code)}: ${clause(
				String((e as Error)?.message ?? e),
			)}`,
		};
	}
}

async function balanceOf(node: SlimNode, address: string): Promise<bigint> {
	return BigInt(
		(await node.request({
			method: 'eth_getBalance',
			params: [address, 'latest'],
		})) as string,
	);
}

async function runFloor(hardfork: NodeHardfork, makeEngine?: EngineFactory) {
	const node = await nodeOn(hardfork, makeEngine);
	const call = {from: SPONSOR.address, to: SINK, data: HEAVY};
	const estimate = await attempt(node, 'eth_estimateGas', [call]);
	// 37000 covers the intrinsic gas exactly, and is below the floor from Prague.
	const belowFloor = await send(
		node,
		await sign1559({to: SINK, data: HEAVY, gas: 37_000n, nonce: 0}),
	);
	const nonce = 'status' in belowFloor ? 1 : 0;
	const before = await balanceOf(node, SPONSOR.address);
	const atEstimate = await send(
		node,
		await sign1559({to: SINK, data: HEAVY, gas: BigInt(estimate), nonce}),
	);
	const charged = before - (await balanceOf(node, SPONSOR.address));
	// The node's `eth_call` `gas` is the EXECUTION budget, so 100 of it carries a
	// 37100 total: enough before Prague, short of the floor from Prague on.
	const callBelowFloor = clause(
		await attempt(node, 'eth_call', [{...call, gas: '0x64'}]),
	);
	const callDefault = await attempt(node, 'eth_call', [call]);
	await node.dispose();
	return {
		estimate: BigInt(estimate).toString(),
		belowFloor,
		atEstimate,
		// effective price is base fee (1 gwei) + priority (1 gwei), within MAX_FEE.
		chargedGas: (charged / 2_000_000_000n).toString(),
		callBelowFloor,
		callDefault,
	};
}

async function runCap(hardfork: NodeHardfork, makeEngine?: EngineFactory) {
	const node = await nodeOn(hardfork, makeEngine);
	const overCap = await send(
		node,
		await sign1559({to: SINK, gas: CAP + 1n, nonce: 0}),
	);
	const nonce = 'status' in overCap ? 1 : 0;
	const atCap = await send(node, await sign1559({to: SINK, gas: CAP, nonce}));
	const callOverCap = clause(
		await attempt(node, 'eth_call', [{to: SINK, gas: toHex(20_000_000n)}]),
	);
	// THE DEFAULT READ BUDGET, as a contract sees it: `GAS` returns what is left
	// after its own 2 gas, so the budget is that plus 2.
	const gasSeen = await attempt(node, 'eth_call', [{to: GAS_PROBE}]);
	const defaultBudget = (BigInt(gasSeen) + 2n).toString();
	// A request that burns everything it is given fails at every limit, so the
	// refusal names the allowance the search ran up to.
	const estimateCeiling = clause(
		await attempt(node, 'eth_estimateGas', [
			{from: SPONSOR.address, to: BURNER},
		]),
	);
	// ...and a caller-supplied `gas` above the cap is refused by
	// `eth_fillTransaction` in the node's words, not by the tx library's.
	const filled = await attempt(node, 'eth_fillTransaction', [
		{from: SPONSOR.address, to: SINK, gas: toHex(CAP + 1n)},
	]);
	const fillOverCap = filled.startsWith('threw') ? clause(filled) : 'filled';
	await node.dispose();
	return {
		overCap,
		atCap,
		callOverCap,
		defaultBudget,
		estimateCeiling,
		fillOverCap,
	};
}

async function runSetCode(hardfork: NodeHardfork, makeEngine?: EngineFactory) {
	const node = await nodeOn(hardfork, makeEngine);
	const authorization = await AUTHORITY.signAuthorization({
		chainId: CHAIN_ID,
		address: DELEGATE,
		nonce: 0,
	});
	const wrongChain = await AUTHORITY.signAuthorization({
		chainId: CHAIN_ID + 1,
		address: DELEGATE,
		nonce: 0,
	});
	const rpcAuth = (a: typeof authorization) => ({
		chainId: toHex(a.chainId),
		address: a.address,
		nonce: toHex(a.nonce),
		yParity: toHex(a.yParity ?? 0),
		r: a.r,
		s: a.s,
	});
	const request = {from: SPONSOR.address, to: AUTHORITY.address};
	const estimateWithout = await attempt(node, 'eth_estimateGas', [request]);
	const estimateWrongChain = await attempt(node, 'eth_estimateGas', [
		{...request, authorizationList: [rpcAuth(wrongChain)]},
	]);
	const estimateWith = await attempt(node, 'eth_estimateGas', [
		{...request, authorizationList: [rpcAuth(authorization)]},
	]);
	const gas = estimateWith.startsWith('0x') ? BigInt(estimateWith) : 100_000n;
	const signType4 = (auth: typeof authorization, nonce: number) =>
		SPONSOR.signTransaction({
			chainId: CHAIN_ID,
			type: 'eip7702',
			nonce,
			to: AUTHORITY.address,
			gas,
			maxFeePerGas: MAX_FEE,
			maxPriorityFeePerGas: PRIORITY_FEE,
			authorizationList: [auth],
		});
	// The skipped authorization FIRST: it must leave the authority untouched.
	const skipped = await send(node, await signType4(wrongChain, 0));
	const codeAfterSkipped = await attempt(node, 'eth_getCode', [
		AUTHORITY.address,
		'latest',
	]);
	const nonce = 'status' in skipped ? 1 : 0;
	const delegated = await send(node, await signType4(authorization, nonce));
	const read = async (method: string, params: unknown[]) =>
		attempt(node, method, params);
	const result = {
		estimateWithout: estimateWithout.startsWith('0x')
			? BigInt(estimateWithout).toString()
			: estimateWithout,
		estimateWrongChain: estimateWrongChain.startsWith('0x')
			? BigInt(estimateWrongChain).toString()
			: clause(estimateWrongChain),
		estimateWith: estimateWith.startsWith('0x')
			? BigInt(estimateWith).toString()
			: clause(estimateWith),
		skipped,
		codeAfterSkipped,
		delegated,
		authorityCode: await read('eth_getCode', [AUTHORITY.address, 'latest']),
		authorityNonce: await read('eth_getTransactionCount', [
			AUTHORITY.address,
			'latest',
		]),
		authoritySlot1: await read('eth_getStorageAt', [
			AUTHORITY.address,
			'0x1',
			'latest',
		]),
		// ...and the delegation is LIVE for a later plain call too.
		callAfter: await read('eth_call', [{to: AUTHORITY.address}]),
	};
	await node.dispose();
	return result;
}

async function runOsakaOpcodes(
	hardfork: NodeHardfork,
	makeEngine?: EngineFactory,
) {
	const node = await nodeOn(hardfork, makeEngine);
	const estimate = async (to: string, data: `0x${string}`) => {
		const o = await attempt(node, 'eth_estimateGas', [
			{from: SPONSOR.address, to, data},
		]);
		return o.startsWith('0x') ? BigInt(o).toString() : clause(o);
	};
	const clz = await attempt(node, 'eth_call', [{to: CLZ_PROBE}]);
	const result = {
		clz: clz.startsWith('0x') ? BigInt(clz).toString() : clause(clz),
		modexpEstimate: await estimate(MODEXP, MODEXP_INPUT),
		modexpResult: await attempt(node, 'eth_call', [
			{to: MODEXP, data: MODEXP_INPUT},
		]),
		p256Estimate: await estimate(P256VERIFY, P256_INPUT),
		p256Result: await attempt(node, 'eth_call', [
			{to: P256VERIFY, data: P256_INPUT},
		]),
	};
	await node.dispose();
	return result;
}

async function runBlockHash(
	hardfork: NodeHardfork,
	makeEngine?: EngineFactory,
) {
	const node = await nodeOn(hardfork, makeEngine);
	for (let i = 0; i < 3; i++) await node.mine();
	const head = (await node.request({
		method: 'eth_getBlockByNumber',
		params: ['latest', false],
	})) as {number: string; parentHash: string};
	const result = {
		head: BigInt(head.number).toString(),
		blockhashOfParentIsTheParent:
			(await attempt(node, 'eth_call', [{to: BLOCKHASH_PROBE}])) ===
			head.parentHash,
		historyContractCode: await attempt(node, 'eth_getCode', [
			HISTORY_CONTRACT,
			'latest',
		]),
	};
	await node.dispose();
	return result;
}

async function runDump(hardfork: NodeHardfork, makeEngine?: EngineFactory) {
	const node = await nodeOn(hardfork, makeEngine);
	await send(node, await sign1559({to: SINK, gas: 21_000n, nonce: 0}));
	await node.mine();
	const dump = JSON.parse(JSON.stringify(await node.dumpState()));
	await node.dispose();
	const reloaded = await nodeOn(hardfork, makeEngine);
	await reloaded.loadState(dump);
	await reloaded.mine();
	const latest = (await reloaded.request({
		method: 'eth_getBlockByNumber',
		params: ['latest', false],
	})) as {parentHash: string; number: string};
	const dumpedHead = dump.blocks[dump.blocks.length - 1];
	await reloaded.dispose();
	const other: NodeHardfork = hardfork === 'osaka' ? 'prague' : 'osaka';
	const elsewhere = await nodeOn(other, makeEngine);
	let refusedElsewhere = 'LOADED';
	try {
		await elsewhere.loadState(dump);
	} catch (e) {
		refusedElsewhere = String((e as Error)?.message ?? e);
	}
	await elsewhere.dispose();
	return {
		dumpHardfork: dump.hardfork,
		minedAfterReload: BigInt(latest.number).toString(),
		parentIsTheDumpedHead: latest.parentHash === dumpedHead.hash,
		refusedElsewhere: clause(refusedElsewhere),
		refusedElsewhereNamesTheOption: refusedElsewhere.includes(
			`hardfork: '${hardfork}'`,
		),
	};
}

export const BATTERY_HARDFORKS = ['cancun', 'prague', 'osaka'] as const;

/** The whole battery, per fork, on the engine `makeEngine` builds (default if none). */
export async function runHardforkChecks(
	opts: {makeEngine?: EngineFactory} = {},
) {
	const {makeEngine} = opts;
	const probe = await (async () => {
		const n = await nodeOn('osaka', makeEngine);
		const id = n.engine.id;
		await n.dispose();
		return id;
	})();
	const perFork: Record<string, Record<string, unknown>> = {};
	for (const hardfork of BATTERY_HARDFORKS) {
		perFork[hardfork] = {
			floor: await runFloor(hardfork, makeEngine),
			cap: await runCap(hardfork, makeEngine),
			setCode: await runSetCode(hardfork, makeEngine),
			osakaOpcodes: await runOsakaOpcodes(hardfork, makeEngine),
			blockHash: await runBlockHash(hardfork, makeEngine),
			dump: await runDump(hardfork, makeEngine),
		};
	}
	return {engineId: probe, perFork};
}

/**
 * The option itself, on the default engine (no engine is involved): the default
 * is Osaka, every offered fork comes up, and anything else is refused at
 * construction naming the option, rather than becoming the default.
 */
export async function runHardforkConstructionChecks() {
	const forkOf = async (options: Record<string, unknown>) => {
		try {
			const node = await createNode({chainId: CHAIN_ID, ...options});
			// A dump is the one place the fork is reported back.
			const fork = (await node.dumpState()).hardfork;
			await node.dispose();
			return String(fork);
		} catch (e) {
			return `threw: ${String((e as Error)?.message ?? e)}`;
		}
	};
	const refused: Record<string, string> = {};
	for (const bad of ['Osaka', 'shanghai', 'amsterdam', 'pectra', 7, null])
		refused[String(bad)] = await forkOf({hardfork: bad});
	// An unlabelled dump (one taken before the field existed) is a Cancun dump.
	const unlabelled = await (async () => {
		const cancun = await createNode({chainId: CHAIN_ID, hardfork: 'cancun'});
		const dump: Record<string, unknown> = JSON.parse(
			JSON.stringify(await cancun.dumpState()),
		);
		await cancun.dispose();
		delete dump.hardfork;
		const readings: Record<string, string> = {};
		for (const hardfork of BATTERY_HARDFORKS) {
			const node = await createNode({chainId: CHAIN_ID, hardfork});
			try {
				await node.loadState(dump as any);
				readings[hardfork] = 'loaded';
			} catch (e) {
				readings[hardfork] = clause(String((e as Error)?.message ?? e));
			}
			await node.dispose();
		}
		return readings;
	})();
	return {
		defaultFork: await forkOf({}),
		offered: await (async () => {
			const offered: Record<string, string> = {};
			for (const h of BATTERY_HARDFORKS)
				offered[h] = await forkOf({hardfork: h});
			return offered;
		})(),
		refused,
		unlabelled,
	};
}
