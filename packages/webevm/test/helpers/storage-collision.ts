/**
 * storage-collision.ts: what a contract CREATION does at an address that is
 * already occupied, in every state mode, on the engine under test.
 *
 * THE RULE EVERY NODE FOLLOWS is the reference spec's (execution-specs PR #3508:
 * EIP-684 plus the Yellow Paper), decided with the user on 2026-09-28 and
 * recorded in `docs/adr/0014-the-trie-is-derived-from-the-flat-state-not-a-state-manager.md`
 * (evidence: `work/notes/findings/storage-only-creation-collisions-are-not-refused-by-the-reference-spec.md`):
 *
 * - a target with a NON-ZERO NONCE or NON-EMPTY CODE is a collision, refused;
 * - a target holding STORAGE ONLY (nonce 0, no code) is NOT: the creation
 *   SUCCEEDS and the old storage is WIPED. That is not EIP-7610, which asked for
 *   a collision there and which trie mode used to apply (because it ran on
 *   `MerkleStateManager`, whose `storageRoot` was real).
 *
 * The cases are the spike's (`docs/spikes/revm-eip-7610-storage-collision/`):
 * the target always exists with 1 wei, so `storage`, `nonce`, `code` and
 * `empty` differ in exactly one field; "Top" is a deployment transaction and "Inner" a CREATE2
 * from a factory that stores what CREATE2 returned in its slot 0. Init code
 * deploys the single byte `0x42`, so "created" is code `0x42` at the target.
 *
 * ENGINE-PARAMETERISED: ./cut.ts runs it on the default engine and
 * ./cut-revm.ts on revm, both held to test/storage-collision-expected.ts.
 */
import {
	createPublicClient,
	createWalletClient,
	custom,
	getContractAddress,
} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {createNode, type StateMode} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {PK, CHAIN_ID} from './post-state.js';

const account = privateKeyToAccount(PK);
const chain = {
	id: CHAIN_ID,
	name: 'storage-collision',
	nativeCurrency: {name: 'E', symbol: 'E', decimals: 18},
	rpcUrls: {default: {http: []}},
} as const;

/** `MSTORE8(0, 0x42); RETURN(0, 1)`: the deployed code is the byte `0x42`. */
const INIT = '0x604260005360016000f3';
/**
 * `CALLDATACOPY(0, 0, size); r = CREATE2(0, 0, size, salt 0); SSTORE(0, r)`:
 * slot 0 is the created address, or 0 when the creation collided.
 */
const FACTORY_CODE = '0x365f5f375f365f5ff55f5500';
/** The pre-existing code of the `code*` targets: anything but `0x42`. */
const CODE = '0x43';
const FACTORY = '0x00000000000000000000000000000000000fac70';
const SLOT = '0x7';
const WORD7 = '0x' + '00'.repeat(31) + '07';

export const COLLISION_CASES = [
	'storageTop',
	'storageInner',
	'nonceTop',
	'nonceInner',
	'codeTop',
	'codeInner',
	'emptyTop',
	'emptyInner',
] as const;
export type CollisionCase = (typeof COLLISION_CASES)[number];

export interface CollisionOutcome {
	verdict: 'created' | 'collision';
	status: string;
	gasUsed: string;
	targetCode: string;
	targetNonce: string;
	/** The seeded slot after the creation: `0` when wiped (or never seeded). */
	targetSlot7: string;
	/** Inner cases: what CREATE2 returned (`target` or `0`). */
	create2Returned: string | null;
	/** `getStateRoot()` after the creation, trie mode only. */
	root: string | null;
}

async function runCase(
	stateMode: StateMode,
	name: CollisionCase,
	makeEngine: EngineFactory | undefined,
): Promise<CollisionOutcome> {
	const node = await createNode({
		chainId: CHAIN_ID,
		stateMode,
		miningConfig: {type: 'auto'},
		initialBalances: {[account.address]: 10n ** 24n},
		engine: makeEngine ? await makeEngine() : undefined,
	});
	const rq = (method: string, params: unknown[]) =>
		node.request({method, params}) as Promise<any>;
	const transport = custom(
		{request: ({method, params}: any) => rq(method, params)},
		{retryCount: 0},
	);
	const wallet = createWalletClient({account, chain, transport});
	const pub = createPublicClient({chain, transport});
	const inner = name.endsWith('Inner');
	await rq('evm_setCode', [FACTORY, FACTORY_CODE]);
	const target = inner
		? getContractAddress({
				opcode: 'CREATE2',
				from: FACTORY,
				salt: `0x${'00'.repeat(32)}`,
				bytecode: INIT,
			})
		: getContractAddress({
				opcode: 'CREATE',
				from: account.address,
				nonce: BigInt(
					await rq('eth_getTransactionCount', [account.address, 'latest']),
				),
			});
	await rq('evm_setBalance', [target, '0x1']);
	if (name.startsWith('storage'))
		await rq('evm_setStorageAt', [target, SLOT, WORD7]);
	if (name.startsWith('nonce')) await rq('evm_setNonce', [target, '0x1']);
	// Nonce 0, no storage, non-empty code (`0x43`, not the `0x42` a creation
	// would deploy, so "created" stays distinguishable from "left alone").
	if (name.startsWith('code')) await rq('evm_setCode', [target, CODE]);

	const hash = await wallet.sendTransaction(
		inner
			? {to: FACTORY, data: INIT, gas: 300_000n}
			: {data: INIT, gas: 300_000n},
	);
	const receipt = await pub.getTransactionReceipt({hash});
	const slot0 = inner
		? BigInt(await rq('eth_getStorageAt', [FACTORY, '0x0', 'latest']))
		: null;
	const targetCode = String(await rq('eth_getCode', [target, 'latest']));
	const out: CollisionOutcome = {
		verdict: targetCode === '0x42' ? 'created' : 'collision',
		status: receipt.status,
		gasUsed: String(receipt.gasUsed),
		targetCode,
		targetNonce: String(
			await rq('eth_getTransactionCount', [target, 'latest']),
		),
		targetSlot7: BigInt(
			await rq('eth_getStorageAt', [target, SLOT, 'latest']),
		).toString(),
		create2Returned: slot0 === null ? null : slot0 === 0n ? '0' : 'target',
		root: stateMode === 'trie' ? await node.getStateRoot() : null,
	};
	await node.dispose();
	return out;
}

/** Every case in both state modes, on the engine `makeEngine` builds. */
export async function runStorageCollisionChecks(
	params: {makeEngine?: EngineFactory} = {},
): Promise<Record<StateMode, Record<CollisionCase, CollisionOutcome>>> {
	const out = {} as Record<StateMode, Record<CollisionCase, CollisionOutcome>>;
	for (const mode of ['none', 'trie'] as const) {
		out[mode] = {} as Record<CollisionCase, CollisionOutcome>;
		for (const c of COLLISION_CASES)
			out[mode][c] = await runCase(mode, c, params.makeEngine);
	}
	return out;
}
