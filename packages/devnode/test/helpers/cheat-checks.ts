/**
 * cheat-checks.ts: the battery proving that the core's cheats and snapshots
 * reach the node through a dev node untouched: the `hardhat_` / `anvil_` state
 * cheats, `evm_mine` / `anvil_mine` / `hardhat_mine`, and `evm_snapshot` /
 * `evm_revert` (and their `anvil_` names). The dev node implements none of
 * them; it forwards them (ADR 0017, "Cheat ALIASES are the core's"). Run in
 * Node and in a real browser page by ./cut.ts, and on revm by ./cut-revm.ts.
 *
 * EACH SCRIPT RUNS TWICE: on a dev node and on a BARE node created with the
 * same genesis, each read back through that node's own `request`. The
 * assertions (../cheat-expected.ts) hold the two equal AND pin what the dev
 * node answered, so a forward that silently did nothing cannot pass by matching
 * a bare node that also did nothing.
 *
 * Kept apart from the other batteries so that nothing else in the package
 * depends on the core having these methods.
 *
 * It RETURNS what it observed and asserts nothing itself.
 */
import {createNode, type Engine, type SlimNode} from 'webevm';
import {createDevNode, devAccountBalances} from '../../src/index.js';

type MakeEngine = (() => Promise<Engine>) | undefined;

/** Accounts the state cheats write to, one per dialect, so none overwrites another. */
export const TARGETS = {
	hardhat: '0x00000000000000000000000000000000000000a1',
	anvil: '0x00000000000000000000000000000000000000a2',
} as const;
/** What the state cheats write. */
export const BALANCE = '0x1234';
export const NONCE = '0x7';
/** PUSH1 0x2a PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN: returns 42. */
export const CODE = '0x602a60005260206000f3';
export const SLOT = '0x5';
export const WORD = `0x${'00'.repeat(31)}99`;
export const RECIPIENT = '0x00000000000000000000000000000000000000cc';

type Request = SlimNode['request'];

/** A call's result, or its error's code and message (so a refusal is observed, not thrown). */
async function outcome(p: Promise<unknown>): Promise<unknown> {
	try {
		return {result: await p};
	} catch (e) {
		const err = e as {code?: number; message?: string};
		return {error: {code: err.code, message: err.message}};
	}
}

/** Every read a state cheat could have changed, for one address. */
async function readAccount(request: Request, address: string) {
	return {
		balance: await request({method: 'eth_getBalance', params: [address]}),
		nonce: await request({
			method: 'eth_getTransactionCount',
			params: [address, 'latest'],
		}),
		code: await request({method: 'eth_getCode', params: [address]}),
		storage: await request({
			method: 'eth_getStorageAt',
			params: [address, SLOT, 'latest'],
		}),
		call: await request({
			method: 'eth_call',
			params: [{to: address, data: '0x'}, 'latest'],
		}),
	};
}

/** The four state cheats under one dialect's names, then what they left. */
async function stateCheats(request: Request, dialect: 'hardhat' | 'anvil') {
	const target = TARGETS[dialect];
	const results = {
		setBalance: await outcome(
			request({method: `${dialect}_setBalance`, params: [target, BALANCE]}),
		),
		setNonce: await outcome(
			request({method: `${dialect}_setNonce`, params: [target, NONCE]}),
		),
		setCode: await outcome(
			request({method: `${dialect}_setCode`, params: [target, CODE]}),
		),
		setStorageAt: await outcome(
			request({
				method: `${dialect}_setStorageAt`,
				params: [target, SLOT, WORD],
			}),
		),
	};
	return {results, after: await readAccount(request, target)};
}

/** The three mining methods, each with the head read before and after. */
async function mining(request: Request) {
	const head = () => request({method: 'eth_blockNumber'});
	const run = async (method: string, params: unknown[]) => {
		const before = await head();
		const result = await outcome(request({method, params}));
		return {before, result, after: await head()};
	};
	return {
		evmMine: await run('evm_mine', []),
		anvilMine: await run('anvil_mine', ['0x3']),
		hardhatMine: await run('hardhat_mine', ['0x2']),
	};
}

/**
 * Snapshots, with only what any node has: a state cheat inside the window,
 * and a revert that undoes it. One pair per name, then a consumed id.
 */
async function snapshots(request: Request) {
	const target = TARGETS.hardhat;
	const pair = async (snap: string, revert: string) => {
		const before = await readAccount(request, target);
		const blockBefore = await request({method: 'eth_blockNumber'});
		const id = await request({method: snap});
		await request({method: 'evm_setBalance', params: [target, '0x1']});
		await request({method: 'evm_mine'});
		const reverted = await outcome(request({method: revert, params: [id]}));
		return {
			id,
			reverted,
			restored:
				JSON.stringify(await readAccount(request, target)) ===
				JSON.stringify(before),
			blockBefore,
			blockAfter: await request({method: 'eth_blockNumber'}),
			// Reverting consumed the id.
			again: await outcome(request({method: revert, params: [id]})),
		};
	};
	return {
		evm: await pair('evm_snapshot', 'evm_revert'),
		anvil: await pair('anvil_snapshot', 'anvil_revert'),
	};
}

/** One script on one node: the state cheats in both dialects, mining, snapshots. */
async function script(node: SlimNode) {
	const request = node.request.bind(node);
	return {
		hardhat: await stateCheats(request, 'hardhat'),
		anvil: await stateCheats(request, 'anvil'),
		mining: await mining(request),
		snapshots: await snapshots(request),
	};
}

/**
 * The dev-node-only half: a snapshot taken before a dev account's
 * `eth_sendTransaction` and reverted after it lets the account send again at
 * the earlier nonce, since the layer reads the pending nonce from the node
 * (./send.ts) and so holds nothing a revert would have to restore.
 */
async function sendAcrossARevert(node: SlimNode) {
	const request = node.request.bind(node);
	const [from] = (await request({method: 'eth_accounts'})) as string[];
	const send = () =>
		request({
			method: 'eth_sendTransaction',
			params: [{from, to: RECIPIENT, value: '0x1'}],
		}) as Promise<string>;
	const sent = async (hash: string) => {
		const tx = (await request({
			method: 'eth_getTransactionByHash',
			params: [hash],
		})) as {nonce: string} | null;
		const receipt = (await request({
			method: 'eth_getTransactionReceipt',
			params: [hash],
		})) as {status: string} | null;
		return {nonce: tx?.nonce ?? null, status: receipt?.status ?? null};
	};
	const pendingNonce = () =>
		request({method: 'eth_getTransactionCount', params: [from, 'pending']});
	const recipientBalance = () =>
		request({method: 'eth_getBalance', params: [RECIPIENT]});

	// A first send, so the snapshot is taken at a nonce other than 0.
	const first = await send();
	const id = await request({method: 'evm_snapshot'});
	const nonceAtSnapshot = await pendingNonce();
	const balanceAtSnapshot = await recipientBalance();
	const inWindow = await send();
	const inWindowSent = await sent(inWindow);
	const nonceBeforeRevert = await pendingNonce();
	const reverted = await request({method: 'evm_revert', params: [id]});
	const nonceAfterRevert = await pendingNonce();
	const inWindowAfterRevert = await request({
		method: 'eth_getTransactionByHash',
		params: [inWindow],
	});
	const balanceAfterRevert = await recipientBalance();
	const again = await send();
	return {
		first: await sent(first),
		nonceAtSnapshot,
		balanceAtSnapshot,
		inWindow: {hash: inWindow, ...inWindowSent},
		nonceBeforeRevert,
		reverted,
		nonceAfterRevert,
		inWindowAfterRevert,
		balanceAfterRevert,
		again: {hash: again, ...(await sent(again))},
		nonceAfterAgain: await pendingNonce(),
		recipientAfterAgain: await recipientBalance(),
	};
}

export async function runCheatChecks(makeEngine: MakeEngine) {
	const engine = async () => (makeEngine ? {engine: await makeEngine()} : {});
	const bare = await createNode({
		initialBalances: devAccountBalances(),
		...(await engine()),
	});
	const dev = await createDevNode(await engine());
	try {
		return {
			engineId: dev.engine.id,
			bare: await script(bare),
			dev: await script(dev),
			send: await sendAcrossARevert(dev),
		};
	} finally {
		await bare.dispose();
		await dev.dispose();
	}
}
