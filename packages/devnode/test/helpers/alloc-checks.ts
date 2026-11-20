/**
 * alloc-checks.ts: the battery for `toAllocs`, the alloc export for forge's
 * `vm.loadAllocs`. It runs IN NODE (../alloc.spec.ts calls it directly, as a CLI
 * such as rocketh would) and in a real browser page (./cut.ts, mode 'alloc').
 *
 * THE CASE rocketh proved by hand with forge 1.7.1: a contract whose constructor
 * stores a value, deployed from a dev account. It is deployed twice, on a
 * `'recover'` node with a real signature and on a `'trusted'` node with a
 * FABRICATED one (signed by a key that is not the sender's), since the alloc
 * carries state only and must not care how the chain got there.
 *
 * It RETURNS what it observed and asserts nothing itself: the expected values
 * are in ../alloc-expected.ts.
 */
import {getContractAddress, type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import type {SerializedState, SlimNode} from 'webevm';
import {createDevNode, toAllocs} from '../../src/index.js';

/** anvil's account 0: the dev node's default first account and its key. */
export const DEPLOYER_KEY =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
/** A key that is NOT the deployer's, to fabricate a signature with. */
const STRANGER_KEY =
	'0x4646464646464646464646464646464646464646464646464646464646464646' as const;

/**
 * The contract's runtime code: return slot 0
 * (`PUSH1 0 SLOAD PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN`).
 */
export const RUNTIME_CODE = '0x60005460005260206000f3';
/**
 * Its init code: `SSTORE(0, 0x2a)`, then copy the 11-byte runtime (at offset
 * 0x11) to memory and return it.
 */
export const INIT_CODE =
	'0x602a600055600b6011600039600b6000f3' + RUNTIME_CODE.slice(2);

async function deploy(node: SlimNode, mode: 'recover' | 'trusted') {
	const deployer = privateKeyToAccount(DEPLOYER_KEY);
	const signer =
		mode === 'recover' ? deployer : privateKeyToAccount(STRANGER_KEY);
	const chainId = Number(await node.request({method: 'eth_chainId'}));
	const raw = await signer.signTransaction({
		chainId,
		type: 'eip1559',
		nonce: 0,
		gas: 200_000n,
		maxFeePerGas: 10n ** 10n,
		maxPriorityFeePerGas: 1n,
		data: INIT_CODE as Hex,
	});
	const hash = (await node.request(
		mode === 'recover'
			? {method: 'eth_sendRawTransaction', params: [raw]}
			: {
					method: 'evm_sendRawTransactionAs',
					params: [raw, deployer.address.toLowerCase()],
				},
	)) as string;
	const receipt = (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	})) as {
		status: string;
		contractAddress: string;
		gasUsed: string;
		effectiveGasPrice: string;
	};
	const balance = await node.request({
		method: 'eth_getBalance',
		params: [deployer.address, 'latest'],
	});
	return {
		status: receipt.status,
		contractAddress: receipt.contractAddress,
		expectedContractAddress: getContractAddress({
			from: deployer.address,
			nonce: 0n,
		}).toLowerCase(),
		deployerBalance: balance as string,
		gasUsed: receipt.gasUsed,
		effectiveGasPrice: receipt.effectiveGasPrice,
	};
}

/** Every address a dump holds anything for, lowercase and sorted. */
function dumpAddresses(dump: SerializedState): string[] {
	return [
		...new Set(
			[
				...Object.keys(dump.accounts),
				...Object.keys(dump.code),
				...Object.keys(dump.storage),
			].map((a) => a.toLowerCase()),
		),
	].sort();
}

export async function runAllocChecks() {
	const out: Record<string, unknown> = {};
	for (const mode of ['recover', 'trusted'] as const) {
		const node = await createDevNode({senderMode: mode});
		const accounts = (await node.request({method: 'eth_accounts'})) as string[];
		const deployed = await deploy(node, mode);
		const dump = await node.dumpState();
		const allocs = toAllocs(dump);
		// A PERSISTED dump is JSON (IndexedDB, a file): the export reads it the same.
		const persisted = toAllocs(JSON.parse(JSON.stringify(dump)));
		// ...and a dump LOADED into a fresh node and dumped again exports the same.
		const reloaded = await createDevNode({senderMode: mode, fund: false});
		await reloaded.loadState(dump);
		const reloadedAllocs = toAllocs(await reloaded.dumpState());
		await reloaded.dispose();
		await node.dispose();
		out[mode] = {
			accounts,
			deployed,
			allocs,
			persistedEqual: JSON.stringify(persisted) === JSON.stringify(allocs),
			reloadedEqual: JSON.stringify(reloadedAllocs) === JSON.stringify(allocs),
			dumpAddresses: dumpAddresses(dump),
			allocAddresses: Object.keys(allocs).sort(),
			// The export is plain JSON: what a CLI writes to a file for forge.
			roundTrips:
				JSON.stringify(JSON.parse(JSON.stringify(allocs))) ===
				JSON.stringify(allocs),
		};
	}
	return out;
}
