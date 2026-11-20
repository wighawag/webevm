/**
 * dev-node.ts: the `SlimNode` DECORATOR (`wrapDevNode`) and the constructor that
 * funds its accounts at genesis (`createDevNode`).
 *
 * WHY A DECORATOR, AND WHY THIS PACKAGE. webevm's core holds no keys and answers
 * every account method with a real `-32601` (ADR 0004), and offers impersonation
 * only as a primitive for "a higher layer" (ADR 0002). This is that layer:
 * `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`.
 * It returns a NODE rather than a bare EIP-1193 provider so the same object runs
 * on the main thread, over a `createWorkerNode()` proxy, and inside a worker.
 *
 * IT REACHES THE NODE ONLY THROUGH `SlimNode`'s PUBLIC MEMBERS, so it cannot
 * depend on node internals and the core can change underneath it.
 */
import {serveProvider, type ServedProvider} from '@eip-1193/over-port';
import {
	createNode,
	type NodeOptions,
	type RequestArguments,
	type SlimNode,
} from 'webevm';
import {
	deriveDevAccounts,
	devAccountBalances,
	type DevAccount,
	type DevAccountsOptions,
	type DevFundingOptions,
} from './accounts.js';
import {createImpersonation, IMPERSONATION_METHODS} from './impersonation.js';
import {createTransactionMethods} from './send.js';
import {createMessageSigner} from './sign.js';

/** The impersonation switch, which both constructors take. */
export interface ImpersonationOptions {
	/**
	 * Answer `hardhat_impersonateAccount` / `hardhat_stopImpersonatingAccount`
	 * (and their `anvil_` names), and send from an impersonated address with a
	 * fabricated signature through `evm_sendRawTransactionAs`. Default `false`,
	 * when the four methods answer `-32601` naming this option. Needs a
	 * `senderMode: 'trusted'` node: `createDevNode` creates one, `wrapDevNode`
	 * refuses any other. See ./impersonation.ts.
	 */
	impersonation?: boolean;
}

/** What {@link wrapDevNode} takes: the accounts and the impersonation switch, and nothing that funds. */
export type WrapDevNodeOptions = DevAccountsOptions & ImpersonationOptions;

/** What {@link createDevNode} takes: webevm's options plus the dev accounts, their funding and the impersonation switch. */
export type DevNodeOptions = NodeOptions &
	DevFundingOptions &
	ImpersonationOptions;

/** Why impersonation cannot run on `node`, or `undefined` when it can. */
function impersonationRefusal(senderMode: unknown): string | undefined {
	if (senderMode === 'trusted') return undefined;
	return (
		`@webevm/devnode: the \`impersonation\` option needs a node created with senderMode: 'trusted', ` +
		`since an impersonated address's transactions carry a fabricated signature and are sent through ` +
		`evm_sendRawTransactionAs, and it was given senderMode: '${String(senderMode)}'. ` +
		`Create the node with senderMode: 'trusted' (createDevNode does so when the option is on), or turn the option off.`
	);
}

/**
 * Wrap an existing node with dev accounts. FUNDS NOTHING: genesis is decided
 * when a node is created, so a node created elsewhere is funded by passing
 * `devAccountBalances(options)` as its `initialBalances` there.
 *
 * The result is a `Required<SlimNode>` (the annotation is the mechanism, as on
 * webevm's worker-host proxy: a member added to `SlimNode` later, optional or
 * not, fails to build here instead of reading as `undefined`):
 *
 * - `request` answers `eth_accounts` with the dev accounts, in order, and
 *   `eth_sendTransaction` from one of them (filled, signed with its key and
 *   submitted by the node's sender mode; see ./send.ts), signs for them
 *   (`eth_signTransaction`, ./send.ts; `personal_sign`, `eth_sign` and
 *   `eth_signTypedData_v4`, ./sign.ts), answers the impersonation methods
 *   (./impersonation.ts; `-32601` naming the option while it is off), and
 *   forwards every other method to the node, its result or its error unchanged
 *   (the node's own `-32601` included: the very promise the node returned);
 * - `serveOn` serves THIS `request` on the port, so a served port answers the
 *   account methods too;
 * - `dispose` stops answering on the ports it served, then disposes the node
 *   (whose own `dispose` closes only the ports IT served);
 * - every other member delegates.
 *
 * Throws on an invalid account config (see `deriveDevAccounts`), and at once
 * when `impersonation` is on and the node is not `senderMode: 'trusted'`.
 */
export function wrapDevNode(
	node: SlimNode,
	options: WrapDevNodeOptions = {},
): Required<SlimNode> {
	const accounts = deriveDevAccounts(options.accounts);
	const impersonation = options.impersonation === true;
	if (impersonation) {
		const refusal = impersonationRefusal(node.senderMode);
		if (refusal) throw new Error(refusal);
	}
	return decorate(node, accounts, impersonation);
}

/** The decorator itself, over accounts already derived (and so validated). */
function decorate(
	node: SlimNode,
	accounts: readonly DevAccount[],
	impersonationOn: boolean,
): Required<SlimNode> {
	const addresses = accounts.map((a) => a.address);
	const servedPorts = new Set<ServedProvider>();
	const impersonation = createImpersonation(impersonationOn);
	const transactions = createTransactionMethods(node, accounts, impersonation);
	const signer = createMessageSigner(accounts, impersonation);

	async function request(args: RequestArguments): Promise<unknown> {
		switch (args.method) {
			case 'eth_accounts':
				// A fresh array each time, so a caller mutating its answer cannot
				// change the next one.
				return [...addresses];
			case 'eth_sendTransaction':
				return transactions.sendTransaction(args.params);
			case 'eth_signTransaction':
				return transactions.signTransaction(args.params);
			case 'personal_sign':
				return signer.personalSign(args.params);
			case 'eth_sign':
				return signer.ethSign(args.params);
			case 'eth_signTypedData_v4':
				return signer.signTypedDataV4(args.params);
			default:
				if (IMPERSONATION_METHODS.has(args.method))
					// On the send queue, so a send issued before it sees the set as it was.
					return transactions.inOrder(() =>
						impersonation.request(args.method, args.params),
					);
				return node.request(args);
		}
	}

	const devNode: Required<SlimNode> = {
		request,
		mine: () => node.mine(),
		dumpState: () => node.dumpState(),
		loadState: (state) => node.loadState(state),
		onNewHead: (cb) => node.onNewHead(cb),
		getStateRoot: () => node.getStateRoot(),
		computeStateRoot: node.computeStateRoot,
		senderMode: node.senderMode,
		engine: node.engine,
		async serveOn(port) {
			const server = serveProvider({request}, port);
			servedPorts.add(server);
			return {
				async close() {
					server.close();
					servedPorts.delete(server);
				},
			};
		},
		async dispose() {
			for (const server of servedPorts) server.close();
			servedPorts.clear();
			await node.dispose();
		},
	};
	return devNode;
}

/**
 * Create a webevm node whose dev accounts are FUNDED AT GENESIS, as anvil and
 * Hardhat fund theirs, and return it wrapped (see {@link wrapDevNode}).
 *
 *   const node = await createDevNode(); // anvil's ten accounts, 10,000 ETH each
 *
 * The dev accounts' balances (and `fundAccounts`) are merged into webevm's
 * `initialBalances` (see `devAccountBalances` for the precedence), and the node
 * is created with webevm's `createNode`. Like every `initialBalances`, they
 * apply to a NEW genesis only: a state restored by `loadState` or `persistence`
 * keeps its own balances.
 *
 * With `impersonation: true` the node is created with `senderMode: 'trusted'`,
 * which the option needs; an explicit `senderMode: 'recover'` alongside it is
 * refused before any node is created.
 */
export async function createDevNode(
	options: DevNodeOptions = {},
): Promise<Required<SlimNode>> {
	const {
		accounts,
		balance,
		fund,
		fundAccounts,
		initialBalances,
		impersonation,
		...rest
	} = options;
	const impersonationOn = impersonation === true;
	if (impersonationOn && rest.senderMode !== undefined) {
		const refusal = impersonationRefusal(rest.senderMode);
		if (refusal) throw new Error(refusal);
	}
	// Derive (and so validate) the accounts and their balances BEFORE creating a
	// node, so a bad config throws with nothing left behind to dispose.
	const devAccounts = deriveDevAccounts(accounts);
	const funded = devAccountBalances({
		accounts,
		balance,
		fund,
		fundAccounts,
		initialBalances,
	});
	const node = await createNode({
		...rest,
		...(impersonationOn ? {senderMode: 'trusted' as const} : {}),
		initialBalances: funded,
	});
	return decorate(node, devAccounts, impersonationOn);
}
