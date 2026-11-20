/**
 * @webevm/devnode: dev accounts for webevm, as a `SlimNode` decorator funded at
 * genesis. See `docs/adr/0017-dev-accounts-live-in-webevm-devnode-a-slimnode-decorator-funded-at-genesis.md`.
 */
export {createDevNode, wrapDevNode} from './dev-node.js';
export type {DevNodeOptions, WrapDevNodeOptions} from './dev-node.js';
export {
	devAccountBalances,
	DEFAULT_ACCOUNT_COUNT,
	DEFAULT_BALANCE,
	DEFAULT_DERIVATION_PATH,
	DEFAULT_MNEMONIC,
} from './accounts.js';
export type {
	DevAccountsConfig,
	DevAccountsOptions,
	DevFundingOptions,
	MnemonicAccounts,
} from './accounts.js';
