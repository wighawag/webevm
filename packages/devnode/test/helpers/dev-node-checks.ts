/**
 * dev-node-checks.ts: the battery for `@webevm/devnode`'s first slice (dev
 * accounts, funded at genesis, everything else forwarded), run in a real browser
 * page by ./cut.ts (default engine) and ./cut-revm.ts (`webevm/revm`).
 *
 * THROUGH THE PUBLIC SURFACE ONLY: a dev node is created with the package's
 * exports, driven with viem (or with raw EIP-1193 `request` where the question is
 * what the wire carries, an error's `code` for instance), and every answer is
 * read back over RPC. Nothing here reaches into the package's internals.
 *
 * It RETURNS what it observed (bigints as decimal strings, so the harness can
 * carry them as JSON) and asserts nothing itself: the spec holds the expected
 * values (../dev-node-expected.ts), the same assertions for both engines.
 */
import {
	createPublicClient,
	createWalletClient,
	custom,
	type EIP1193Provider,
} from 'viem';
import {mnemonicToAccount, privateKeyToAccount} from 'viem/accounts';
import {providerOverPort} from '@eip-1193/over-port';
import {createNode, RpcError, type Engine, type SlimNode} from 'webevm';
import {
	createDevNode,
	devAccountBalances,
	wrapDevNode,
} from '../../src/index.js';

/** A provider over a port, typed loosely: the far end serves any method. */
type Consumer = {
	request(args: {method: string; params?: unknown[]}): Promise<unknown>;
	close(): void;
};

type MakeEngine = (() => Promise<Engine>) | undefined;

/** A mnemonic other than the default, with a published address for index 0. */
export const ABANDON_MNEMONIC =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Two private keys that are not dev accounts by default. */
export const EXTRA_KEYS = [
	'0x0000000000000000000000000000000000000000000000000000000000000001',
	'0x4646464646464646464646464646464646464646464646464646464646464646',
] as const;

/** An address that is no dev account, funded through `fundAccounts`. */
export const FUNDED_STRANGER = '0x00000000000000000000000000000000000000aa';

function clients(node: {request: SlimNode['request']}) {
	const transport = custom(node as unknown as EIP1193Provider);
	return {
		wallet: createWalletClient({transport}),
		public: createPublicClient({transport}),
	};
}

async function balancesAtGenesis(
	node: SlimNode,
	addresses: readonly string[],
): Promise<string[]> {
	const {public: pub} = clients(node);
	return Promise.all(
		addresses.map(async (address) =>
			String(
				await pub.getBalance({
					address: address as `0x${string}`,
					blockNumber: 0n,
				}),
			),
		),
	);
}

/** What a rejected request carried: its code, message and data, or 'resolved'. */
async function outcome(p: Promise<unknown>): Promise<unknown> {
	try {
		return {resolved: await p};
	} catch (e) {
		const err = e as {code?: unknown; message?: unknown; data?: unknown};
		return {
			code: err.code,
			message: err.message,
			data: err.data,
			name: (e as Error)?.name,
			isRpcError: e instanceof RpcError,
		};
	}
}

async function thrown(f: () => unknown): Promise<string> {
	try {
		await f();
		return 'did not throw';
	} catch (e) {
		return String((e as Error).message);
	}
}

export async function runDevNodeChecks(makeEngine: MakeEngine) {
	const engine = async () => (makeEngine ? {engine: await makeEngine()} : {});

	// 1. DEFAULTS: anvil's ten accounts, 10,000 ETH each at block 0.
	const defaultNode = await createDevNode({...(await engine())});
	const {wallet} = clients(defaultNode);
	const defaults = {
		engineId: defaultNode.engine.id,
		accounts: await wallet.getAddresses(),
		rawAccounts: await defaultNode.request({method: 'eth_accounts'}),
		balances: [] as string[],
	};
	defaults.balances = await balancesAtGenesis(defaultNode, defaults.accounts);
	await defaultNode.dispose();

	// 2. DERIVATION: a mnemonic (with count, path and initialIndex) and a key list,
	// each checked against an independent derivation (viem's) in the spec.
	const viewOf = async (accounts: Parameters<typeof createDevNode>[0]) => {
		const node = await createDevNode({...accounts, ...(await engine())});
		const list = (await node.request({method: 'eth_accounts'})) as string[];
		await node.dispose();
		return list;
	};
	const derivation = {
		abandonDefault: await viewOf({accounts: {mnemonic: ABANDON_MNEMONIC}}),
		abandonCount3Index2: await viewOf({
			accounts: {mnemonic: ABANDON_MNEMONIC, count: 3, initialIndex: 2},
		}),
		abandonPath: await viewOf({
			accounts: {mnemonic: ABANDON_MNEMONIC, count: 2, path: "m/44'/60'/1'/0"},
		}),
		count0: await viewOf({accounts: {count: 0}}),
		countShorthand: await viewOf({accounts: 3}),
		keys: await viewOf({accounts: [...EXTRA_KEYS]}),
		viem: {
			abandon0to9: Array.from({length: 10}, (_, i) =>
				mnemonicToAccount(ABANDON_MNEMONIC, {
					path: `m/44'/60'/0'/0/${i}`,
				}).address.toLowerCase(),
			),
			abandonPath: [0, 1].map((i) =>
				mnemonicToAccount(ABANDON_MNEMONIC, {
					path: `m/44'/60'/1'/0/${i}`,
				}).address.toLowerCase(),
			),
			keys: EXTRA_KEYS.map((k) => privateKeyToAccount(k).address.toLowerCase()),
		},
		refusals: {
			badMnemonic: await thrown(() =>
				createDevNode({accounts: {mnemonic: 'not a real mnemonic at all'}}),
			),
			badKey: await thrown(() => createDevNode({accounts: ['0x1234']})),
			zeroKey: await thrown(() =>
				createDevNode({
					accounts: [
						'0x0000000000000000000000000000000000000000000000000000000000000000',
					],
				}),
			),
			badCount: await thrown(() => createDevNode({accounts: {count: -1}})),
			wrapBadKey: await (async () => {
				const node = await createNode();
				const message = await thrown(() =>
					wrapDevNode(node, {accounts: ['nope']}),
				);
				await node.dispose();
				return message;
			})(),
		},
	};

	// 3. FUNDING: `balance`, `fundAccounts`, `fund: false`, a caller's own
	// `initialBalances` winning, `devAccountBalances` agreeing with what is
	// funded, and a restored state keeping its own balances.
	const fiveEth = 5n * 10n ** 18n;
	const balanceNode = await createDevNode({
		accounts: 2,
		balance: fiveEth,
		fundAccounts: {[FUNDED_STRANGER]: 7n},
		...(await engine()),
	});
	const balanceAccounts = (await balanceNode.request({
		method: 'eth_accounts',
	})) as string[];
	const balance = {
		accounts: await balancesAtGenesis(balanceNode, balanceAccounts),
		stranger: (await balancesAtGenesis(balanceNode, [FUNDED_STRANGER]))[0],
	};
	await balanceNode.dispose();

	const unfundedNode = await createDevNode({
		accounts: 2,
		fund: false,
		fundAccounts: {[FUNDED_STRANGER]: 7n},
		...(await engine()),
	});
	const unfundedAccounts = (await unfundedNode.request({
		method: 'eth_accounts',
	})) as string[];
	const unfunded = {
		accounts: unfundedAccounts,
		balances: await balancesAtGenesis(unfundedNode, unfundedAccounts),
		stranger: (await balancesAtGenesis(unfundedNode, [FUNDED_STRANGER]))[0],
	};
	await unfundedNode.dispose();

	// The caller's own entry wins, written with a different case than the dev
	// node's own key, so the precedence cannot hinge on string identity.
	const callerNode = await createDevNode({
		accounts: 2,
		initialBalances: {'0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266': 3n},
		...(await engine()),
	});
	const callerAccounts = (await callerNode.request({
		method: 'eth_accounts',
	})) as string[];
	const callerWins = await balancesAtGenesis(callerNode, callerAccounts);
	await callerNode.dispose();

	const sameOptions = {
		accounts: {mnemonic: ABANDON_MNEMONIC, count: 3},
		balance: 11n,
		fundAccounts: {[FUNDED_STRANGER]: 13n},
		initialBalances: {[FUNDED_STRANGER]: 17n},
	};
	const reported = devAccountBalances(sameOptions);
	const reportedNode = await createDevNode({
		...sameOptions,
		...(await engine()),
	});
	const reportedOnChain = await balancesAtGenesis(
		reportedNode,
		Object.keys(reported),
	);
	await reportedNode.dispose();
	// ...and the same map, handed to a node created ELSEWHERE, funds it the same.
	const elsewhere = wrapDevNode(
		await createNode({initialBalances: reported, ...(await engine())}),
		{accounts: sameOptions.accounts},
	);
	const elsewhereOnChain = await balancesAtGenesis(
		elsewhere,
		(await elsewhere.request({method: 'eth_accounts'})) as string[],
	);
	await elsewhere.dispose();

	// A dump of a funded chain, whose first account has since been changed,
	// loaded into a new dev node: the dump's balance, not a fresh genesis's.
	const source = await createDevNode({...(await engine())});
	const [first, second] = (await source.request({
		method: 'eth_accounts',
	})) as string[];
	await source.request({method: 'evm_setBalance', params: [first, '0x1']});
	await source.mine();
	const dump = await source.dumpState();
	await source.dispose();
	const restored = await createDevNode({...(await engine())});
	await restored.loadState(dump);
	const {public: restoredPub} = clients(restored);
	const restoredBalances = {
		first: String(
			await restoredPub.getBalance({address: first as `0x${string}`}),
		),
		second: String(
			await restoredPub.getBalance({address: second as `0x${string}`}),
		),
		blockNumber: String(await restoredPub.getBlockNumber()),
	};
	await restored.dispose();

	// wrapDevNode on an existing node funds nothing.
	const plainForWrap = await createNode({...(await engine())});
	const wrapped = wrapDevNode(plainForWrap);
	const wrappedAccounts = (await wrapped.request({
		method: 'eth_accounts',
	})) as string[];
	const wrapFundsNothing = {
		accounts: wrappedAccounts,
		balances: await balancesAtGenesis(wrapped, wrappedAccounts),
	};
	await wrapped.dispose();

	const funding = {
		balance,
		unfunded,
		callerWins,
		reported: Object.fromEntries(
			Object.entries(reported).map(([k, v]) => [k, String(v)]),
		),
		reportedOnChain,
		elsewhereOnChain,
		restoredBalances,
		wrapFundsNothing,
	};

	// 4. FORWARDING: what the layer does not implement reaches the node
	// unchanged. The same requests against a plain node and a dev node over the
	// same options, compared answer for answer and error for error.
	const plain = await createNode({...(await engine())});
	const dev = await createDevNode({fund: false, ...(await engine())});
	const sample = [
		{
			method: 'eth_call',
			params: [
				{
					to: '0x0000000000000000000000000000000000000004',
					data: '0x1234',
				},
				'latest',
			],
		},
		{method: 'eth_chainId'},
		{
			method: 'evm_setBalance',
			params: ['0x00000000000000000000000000000000000000bb', '0x10'],
		},
		{
			method: 'eth_getBalance',
			params: ['0x00000000000000000000000000000000000000bb', 'latest'],
		},
		{method: 'webevm_noSuchMethod', params: []},
		{method: 'eth_signTypedData_v3', params: []},
		{method: 'eth_getBlockByNumber', params: ['0x99', false]},
		{method: 'eth_getBalance', params: ['not an address', 'latest']},
	];
	const forwarded: {method: string; plain: unknown; dev: unknown}[] = [];
	for (const args of sample) {
		forwarded.push({
			method: args.method,
			plain: await outcome(plain.request(args)),
			dev: await outcome(dev.request(args)),
		});
	}
	// Methods the layer ANSWERS rather than forwards: the core refuses
	// `eth_sendTransaction` and `eth_signTransaction` with -32601, the layer with
	// its own refusal of a request with no `from` (the batteries are
	// ./send-checks.ts and ./sign-checks.ts).
	const answered = {
		plain: await outcome(
			plain.request({method: 'eth_sendTransaction', params: [{}]}),
		),
		dev: await outcome(
			dev.request({method: 'eth_sendTransaction', params: [{}]}),
		),
		signPlain: await outcome(
			plain.request({method: 'eth_signTransaction', params: [{}]}),
		),
		signDev: await outcome(
			dev.request({method: 'eth_signTransaction', params: [{}]}),
		),
	};
	// Every other member delegates.
	const members = {
		senderMode: [plain.senderMode, dev.senderMode],
		computeStateRoot: [plain.computeStateRoot, dev.computeStateRoot],
		engineId: [plain.engine.id, dev.engine.id],
		getStateRoot: [
			await outcome(plain.getStateRoot()),
			await outcome(dev.getStateRoot()),
		],
		heads: [] as number[],
		mined: 0,
		dumpBlockCount: 0,
	};
	const unsubscribe = dev.onNewHead((h) => members.heads.push(h.number));
	members.mined = (await dev.mine()).blockNumber;
	unsubscribe();
	await dev.mine();
	members.dumpBlockCount = (await dev.dumpState()).blocks.length;
	await plain.dispose();
	await dev.dispose();

	// The trusted-sender cheat the core gates on `senderMode` is forwarded too.
	const trustedDev = await createDevNode({
		senderMode: 'trusted',
		...(await engine()),
	});
	const trusted = {
		senderMode: trustedDev.senderMode,
		cheat: await outcome(
			trustedDev.request({
				method: 'evm_sendRawTransactionAs',
				params: ['0x00', '0x00000000000000000000000000000000000000bb'],
			}),
		),
	};
	await trustedDev.dispose();

	// 5. serveOn: a served port answers the layer's methods, and stops answering
	// after `dispose()`, which also disposes the inner node.
	const inner = await createNode({...(await engine())});
	let innerDisposed = false;
	const servedNode = wrapDevNode({
		...inner,
		async dispose() {
			innerDisposed = true;
			return inner.dispose();
		},
	});
	const channel = new MessageChannel();
	await servedNode.serveOn(channel.port1);
	const consumer = providerOverPort(channel.port2) as unknown as Consumer;
	const timeout = (ms: number) =>
		new Promise((resolve) => setTimeout(() => resolve('no answer'), ms));
	const second2 = new MessageChannel();
	const handle = await servedNode.serveOn(second2.port1);
	const consumer2 = providerOverPort(second2.port2) as unknown as Consumer;
	const servedBefore = {
		accounts: await consumer.request({method: 'eth_accounts'}),
		chainId: await consumer.request({method: 'eth_chainId'}),
		error: await outcome(consumer.request({method: 'webevm_noSuchMethod'})),
		second: await consumer2.request({method: 'eth_accounts'}),
	};
	await handle.close();
	const afterClose = await Promise.race([
		consumer2.request({method: 'eth_accounts'}),
		timeout(500),
	]);
	await servedNode.dispose();
	const afterDispose = await Promise.race([
		consumer.request({method: 'eth_accounts'}),
		timeout(500),
	]);
	consumer.close();
	consumer2.close();
	const served = {servedBefore, afterClose, afterDispose, innerDisposed};

	return {
		defaults,
		derivation,
		funding,
		forwarded,
		answered,
		members,
		trusted,
		served,
	};
}
