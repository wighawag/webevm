/**
 * genesis-cheats-expected.ts — what BOTH engines must report from the custom-genesis
 * and `evm_set*` cheat halves of test/helpers/genesis-cheats-perf.ts, pinned as
 * literals.
 *
 * WHY SHARED. `genesis-cheats-perf.spec.ts` (default `@ethereumjs/evm`, without
 * and with `computeStateRoot`) and `revm-genesis-cheats.spec.ts` (`webevm/revm`,
 * without it) run the SAME two halves and assert THIS object. State stays the node's
 * on either engine (ADR 0010), so a custom genesis and a runtime cheat must produce
 * the same readings whichever EVM is installed; holding the two runs to one set of
 * literals is what says so. These are the values the default-engine spec has always
 * asserted, moved rather than changed.
 *
 * It lives in its own module because Playwright refuses to let one spec file import
 * another.
 */
export const GENESIS_CHEATS = {
	/** (1) a custom genesis: a rich EOA with its own nonce, no code. */
	eoaBalance: (1234n * 10n ** 18n).toString(),
	eoaNonce: '7',
	/** ...and a PRE-DEPLOYED contract whose seeded storage slot 0 is 41... */
	preDeployedNumber: '41',
	/** ...which `increment()` moves to 42, so genesis CODE and STORAGE both reached
	 *  execution rather than merely `eth_getCode`. */
	numberAfterIncrement: '42',
	/** (2) the four runtime cheats, read back through the standard eth_get* calls. */
	cheatBalance: (5n * 10n ** 18n).toString(),
	cheatNonce: '42',
	cheatCode: '0x60016002',
	cheatStorageSlot7: '99',
} as const;
