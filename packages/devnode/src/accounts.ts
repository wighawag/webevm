/**
 * accounts.ts: the DEV ACCOUNTS, derived from a mnemonic or given as private
 * keys, and the genesis balances they are funded with.
 *
 * THE DEFAULT IS anvil's and Hardhat's: the standard test mnemonic, path
 * `m/44'/60'/0'/0/i`, ten accounts, 10,000 ETH each, so an index-declared
 * account (rocketh's `deployer: 0`) resolves to the same address here as there.
 *
 * ADDRESSES ARE LOWERCASE HEX, which is what webevm writes in every address it
 * returns (receipts, logs, blocks), so a dev account read from `eth_accounts`
 * compares equal to the same account read from a receipt's `from`. anvil returns
 * EIP-55 checksummed addresses and Hardhat lowercase ones; clients compare
 * case-insensitively (viem normalises), so lowercase costs nobody anything and
 * keeps one form across this node's whole surface. (Alternative: EIP-55, as
 * anvil; rejected because a dev account would then be spelled differently in
 * `eth_accounts` and in every receipt.)
 *
 * DECISIONS made here (task `devnode-package-dev-accounts-funded-at-genesis`),
 * each user-visible and each reversible before 1.0:
 *
 * - `accounts` ALSO TAKES A NUMBER, shorthand for `{count}` on the default
 *   mnemonic (anvil's `--accounts N`), because webevm's own worker-host JSDoc
 *   already shows `createDevNode({...options, accounts: 10})`. Alternative: the
 *   object form only.
 * - PRECEDENCE, lowest first: `balance`, then `fundAccounts`, then the caller's
 *   `initialBalances` (the task fixes only the last). `fundAccounts` beats
 *   `balance` because it names one address, `balance` all of them.
 * - `fund: false` turns off ONLY the dev accounts' `balance`: `fundAccounts` and
 *   `initialBalances` still apply, being explicit per-address requests.
 *   Alternative: `fund: false` meaning "no funding at all", which would make
 *   `fundAccounts` silently do nothing.
 * - A BAD CONFIG THROWS a plain `Error` naming the option (`accounts.mnemonic`,
 *   `accounts[i]`, `accounts.count`, `accounts.initialIndex`, `balance`), from
 *   `createDevNode` before any node exists and from `wrapDevNode` synchronously.
 *   The worker task turns this into a value that rejects `createWorkerNode()`.
 */
import {HDKey} from '@scure/bip32';
import {mnemonicToSeedSync, validateMnemonic} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {keccak_256} from '@noble/hashes/sha3.js';
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js';

/** anvil's and Hardhat's default mnemonic. */
export const DEFAULT_MNEMONIC =
	'test test test test test test test test test test test junk';
/** The BIP-44 Ethereum path the account index is appended to. */
export const DEFAULT_DERIVATION_PATH = "m/44'/60'/0'/0";
/** How many accounts a mnemonic yields by default (anvil's `--accounts`). */
export const DEFAULT_ACCOUNT_COUNT = 10;
/** Each dev account's genesis balance by default: 10,000 ETH, in wei. */
export const DEFAULT_BALANCE = 10_000n * 10n ** 18n;

/**
 * Accounts derived from a mnemonic, as Hardhat's `accounts: {mnemonic, path,
 * initialIndex, count}` and anvil's `--mnemonic` / `--derivation-path` /
 * `--accounts` describe them. Account `i` is at `${path}/${initialIndex + i}`.
 */
export interface MnemonicAccounts {
	/** A BIP-39 English mnemonic. Default: {@link DEFAULT_MNEMONIC}. */
	mnemonic?: string;
	/** How many accounts, a non-negative integer. Default 10. */
	count?: number;
	/**
	 * The path the account index is appended to. Default `m/44'/60'/0'/0`
	 * (a trailing `/`, anvil's spelling, is accepted too).
	 */
	path?: string;
	/** The index of the first account. Default 0. */
	initialIndex?: number;
}

/**
 * The dev accounts: a {@link MnemonicAccounts} config, a NUMBER (shorthand for
 * `{count}` on the default mnemonic, as anvil's `--accounts N`), or a list of
 * 32-byte hex private keys (Hardhat's `accounts: [...]`), in that order.
 */
export type DevAccountsConfig = MnemonicAccounts | number | readonly string[];

/** A dev account: its lowercase address and the key the layer holds for it. */
export interface DevAccount {
	readonly address: string;
	readonly privateKey: Uint8Array;
}

/** The account options both `createDevNode` and `wrapDevNode` take. */
export interface DevAccountsOptions {
	/** The dev accounts. Default: anvil's ten. */
	accounts?: DevAccountsConfig;
}

/** What decides the genesis balances `createDevNode` funds. */
export interface DevFundingOptions extends DevAccountsOptions {
	/** Each dev account's genesis balance, in wei. Default 10,000 ETH. */
	balance?: bigint;
	/**
	 * Whether the dev accounts are funded at all. Default `true`. `false` funds
	 * no dev account; {@link fundAccounts} and `initialBalances` still apply,
	 * being explicit per-address requests.
	 */
	fund?: boolean;
	/**
	 * Extra addresses to fund at genesis, address to balance in wei (anvil's
	 * `--fund-accounts`). Wins over {@link balance} for a dev account it names.
	 */
	fundAccounts?: Record<string, bigint>;
	/**
	 * webevm's own option: an entry here wins over both of the above for the
	 * same address (compared case-insensitively).
	 */
	initialBalances?: Record<string, bigint>;
}

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** The address of a secp256k1 private key, lowercase. */
function addressOf(privateKey: Uint8Array): string {
	const publicKey = secp256k1.getPublicKey(privateKey, false);
	return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(
			`@webevm/devnode: \`${name}\` must be a non-negative integer (received ${String(value)}).`,
		);
	}
	return value;
}

/**
 * The dev accounts a config describes, in order. Throws, naming the option, on
 * an invalid mnemonic, private key, count or index: a dev node with the wrong
 * accounts would answer with plausible addresses nobody asked for.
 */
export function deriveDevAccounts(
	config: DevAccountsConfig = {},
): DevAccount[] {
	if (Array.isArray(config)) {
		return (config as readonly unknown[]).map((key, i) => {
			if (typeof key !== 'string' || !PRIVATE_KEY.test(key)) {
				throw new Error(
					`@webevm/devnode: \`accounts[${i}]\` must be a 0x-prefixed 32-byte hex private key.`,
				);
			}
			const privateKey = hexToBytes(key.slice(2));
			if (!secp256k1.utils.isValidSecretKey(privateKey)) {
				throw new Error(
					`@webevm/devnode: \`accounts[${i}]\` is not a valid secp256k1 private key (zero, or not below the curve order).`,
				);
			}
			return {address: addressOf(privateKey), privateKey};
		});
	}
	const options: MnemonicAccounts =
		typeof config === 'number' ? {count: config} : (config as MnemonicAccounts);
	const mnemonic = options.mnemonic ?? DEFAULT_MNEMONIC;
	const count = nonNegativeInteger(
		options.count ?? DEFAULT_ACCOUNT_COUNT,
		typeof config === 'number' ? 'accounts' : 'accounts.count',
	);
	const initialIndex = nonNegativeInteger(
		options.initialIndex ?? 0,
		'accounts.initialIndex',
	);
	const path = (options.path ?? DEFAULT_DERIVATION_PATH).replace(/\/$/, '');
	if (typeof mnemonic !== 'string' || !validateMnemonic(mnemonic, wordlist)) {
		throw new Error(
			'@webevm/devnode: `accounts.mnemonic` is not a valid BIP-39 English mnemonic.',
		);
	}
	const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
	const accounts: DevAccount[] = [];
	for (let i = 0; i < count; i++) {
		const privateKey = root.derive(`${path}/${initialIndex + i}`).privateKey;
		if (!privateKey) {
			throw new Error(
				`@webevm/devnode: \`accounts.path\` ${path} derived no private key.`,
			);
		}
		accounts.push({address: addressOf(privateKey), privateKey});
	}
	return accounts;
}

/**
 * The `initialBalances` the same options would fund at genesis, for a node
 * created elsewhere (a `createWorkerNode()` whose keys stay on this thread):
 *
 *   const worker = await createWorkerNode({worker, initialBalances: devAccountBalances({accounts})});
 *   const node = wrapDevNode(worker, {accounts});
 *
 * Precedence, lowest first: each dev account's `balance` (unless `fund` is
 * `false`), then `fundAccounts`, then the caller's own `initialBalances`. Keys
 * are lowercase, so two spellings of one address cannot both reach genesis.
 */
export function devAccountBalances(
	options: DevFundingOptions = {},
): Record<string, bigint> {
	const balances: Record<string, bigint> = {};
	if (options.fund !== false) {
		const balance = options.balance ?? DEFAULT_BALANCE;
		if (typeof balance !== 'bigint' || balance < 0n) {
			throw new Error(
				'@webevm/devnode: `balance` must be a non-negative bigint, in wei.',
			);
		}
		for (const {address} of deriveDevAccounts(options.accounts)) {
			balances[address] = balance;
		}
	}
	for (const extra of [options.fundAccounts, options.initialBalances]) {
		for (const [address, balance] of Object.entries(extra ?? {})) {
			balances[address.toLowerCase()] = balance;
		}
	}
	return balances;
}
