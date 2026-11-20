/**
 * dev-node-expected.ts: what ./helpers/dev-node-checks.ts must observe, on
 * every engine. Shared by dev-node.spec.ts and revm-dev-node.spec.ts so the two
 * engines are held to the same assertions.
 */
import {expect} from '@playwright/test';

/**
 * anvil's (and Hardhat's) ten default accounts: the published list from
 * `anvil`'s startup banner and Hardhat's documentation, for the mnemonic
 * `test test test test test test test test test test test junk` at
 * `m/44'/60'/0'/0/i`. Written here by hand, not derived, so the package's own
 * derivation is checked against something it did not compute.
 */
export const ANVIL_ACCOUNTS = [
	'0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
	'0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
	'0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
	'0x90F79bf6EB2c4f870365E785982E1f101E93b906',
	'0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
	'0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
	'0x976EA74026E726554dB657fA54763abd0C3a0aa9',
	'0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
	'0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f',
	'0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
].map((a) => a.toLowerCase());

/**
 * The published BIP-44 vector for the `abandon ... about` mnemonic: its first
 * Ethereum account (`m/44'/60'/0'/0/0`), as MetaMask, ethers and viem derive it.
 */
export const ABANDON_ACCOUNT_0 =
	'0x9858EfFD232B4033E47d90003D41EC34EcaEda94'.toLowerCase();

/** The addresses of the two keys in `EXTRA_KEYS`: the secp256k1 generator's and EIP-155's example key's. */
export const EXTRA_KEY_ADDRESSES = [
	'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
	'0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F',
].map((a) => a.toLowerCase());

const TEN_THOUSAND_ETH = String(10_000n * 10n ** 18n);
const FIVE_ETH = String(5n * 10n ** 18n);

export function assertDevNode(c: Record<string, any>, engineId: string) {
	// 1. Defaults.
	expect(c.defaults.engineId).toBe(engineId);
	expect(c.defaults.accounts.map((a: string) => a.toLowerCase())).toEqual(
		ANVIL_ACCOUNTS,
	);
	expect(c.defaults.rawAccounts).toEqual(ANVIL_ACCOUNTS);
	expect(c.defaults.balances).toEqual(
		ANVIL_ACCOUNTS.map(() => TEN_THOUSAND_ETH),
	);

	// 2. Derivation, against the published vectors and viem's derivation.
	const d = c.derivation;
	expect(d.abandonDefault).toHaveLength(10);
	expect(d.abandonDefault[0]).toBe(ABANDON_ACCOUNT_0);
	expect(d.abandonDefault).toEqual(d.viem.abandon0to9);
	expect(d.abandonCount3Index2).toEqual(d.viem.abandon0to9.slice(2, 5));
	expect(d.abandonPath).toEqual(d.viem.abandonPath);
	expect(d.abandonPath[0]).not.toBe(ABANDON_ACCOUNT_0);
	expect(d.count0).toEqual([]);
	expect(d.countShorthand).toEqual(ANVIL_ACCOUNTS.slice(0, 3));
	expect(d.keys).toEqual(EXTRA_KEY_ADDRESSES);
	expect(d.keys).toEqual(d.viem.keys);
	expect(d.refusals.badMnemonic).toContain('accounts.mnemonic');
	expect(d.refusals.badKey).toContain('accounts[0]');
	expect(d.refusals.zeroKey).toContain('accounts[0]');
	expect(d.refusals.badCount).toContain('accounts.count');
	expect(d.refusals.wrapBadKey).toContain('accounts[0]');

	// 3. Funding.
	const f = c.funding;
	expect(f.balance.accounts).toEqual([FIVE_ETH, FIVE_ETH]);
	expect(f.balance.stranger).toBe('7');
	expect(f.unfunded.accounts).toEqual(ANVIL_ACCOUNTS.slice(0, 2));
	expect(f.unfunded.balances).toEqual(['0', '0']);
	expect(f.unfunded.stranger).toBe('7');
	expect(f.callerWins).toEqual(['3', TEN_THOUSAND_ETH]);
	// devAccountBalances: the three abandon accounts at `balance`, the stranger
	// at the caller's own `initialBalances` (which beat `fundAccounts`), and
	// exactly what the dev node holds at genesis.
	expect(f.reported).toEqual({
		[d.viem.abandon0to9[0]]: '11',
		[d.viem.abandon0to9[1]]: '11',
		[d.viem.abandon0to9[2]]: '11',
		'0x00000000000000000000000000000000000000aa': '17',
	});
	expect(f.reportedOnChain).toEqual(['11', '11', '11', '17']);
	expect(f.elsewhereOnChain).toEqual(['11', '11', '11']);
	// The dump's balance (1 wei), not a fresh genesis's 10,000 ETH.
	expect(f.restoredBalances).toEqual({
		first: '1',
		second: TEN_THOUSAND_ETH,
		blockNumber: '1',
	});
	expect(f.wrapFundsNothing.accounts).toEqual(ANVIL_ACCOUNTS);
	expect(f.wrapFundsNothing.balances).toEqual(ANVIL_ACCOUNTS.map(() => '0'));

	// 4. Forwarding: every sampled method answers on the dev node exactly as on
	// the plain node, errors included.
	for (const {method, plain, dev} of c.forwarded) {
		expect(dev, method).toEqual(plain);
	}
	const byMethod = Object.fromEntries(
		c.forwarded.map((r: any) => [r.method, r.dev]),
	);
	expect(byMethod.eth_call).toHaveProperty('resolved');
	expect(byMethod.webevm_noSuchMethod.code).toBe(-32601);
	// The node's own error object: a real `RpcError`, not a copy made here.
	expect(byMethod.webevm_noSuchMethod.isRpcError).toBe(true);
	expect(byMethod.webevm_noSuchMethod.name).toBe('RpcError');
	// An account method the layer does not answer reaches the core's -32601.
	expect(byMethod.eth_signTypedData_v3.code).toBe(-32601);
	// eth_sendTransaction is the layer's own now: the core's -32601 on a plain
	// node, the layer's -32602 (no `from`) on a dev node.
	expect(c.answered.plain.code).toBe(-32601);
	expect(c.answered.dev.code).toBe(-32602);
	expect(c.answered.dev.message).toContain('`from`');
	// So is eth_signTransaction.
	expect(c.answered.signPlain.code).toBe(-32601);
	expect(c.answered.signDev.code).toBe(-32602);
	expect(c.answered.signDev.message).toContain('eth_signTransaction: `from`');
	// The last sample (a malformed address) is refused by the node, whatever
	// shape its error has; the loop above holds the dev node to that shape.
	const malformed = c.forwarded[c.forwarded.length - 1];
	expect(malformed.dev).not.toHaveProperty('resolved');
	expect(typeof malformed.dev.message).toBe('string');
	const m = c.members;
	expect(m.senderMode).toEqual(['recover', 'recover']);
	expect(m.computeStateRoot).toEqual([false, false]);
	expect(m.engineId).toEqual([engineId, engineId]);
	expect(m.getStateRoot[1]).toEqual(m.getStateRoot[0]);
	expect(m.getStateRoot[1].code).toBe(-32004);
	expect(m.mined).toBe(1);
	expect(m.heads).toEqual([1]);
	expect(m.dumpBlockCount).toBe(3);
	expect(c.trusted.senderMode).toBe('trusted');
	// Reached the core's cheat (which refuses the malformed raw transaction),
	// rather than a -32601 from either layer.
	expect(c.trusted.cheat.code).not.toBe(-32601);

	// 5. serveOn and dispose.
	const s = c.served;
	expect(s.servedBefore.accounts).toEqual(ANVIL_ACCOUNTS);
	expect(s.servedBefore.second).toEqual(ANVIL_ACCOUNTS);
	expect(s.servedBefore.chainId).toBe('0x7a69');
	expect(s.servedBefore.error.code).toBe(-32601);
	expect(s.afterClose).toBe('no answer');
	expect(s.afterDispose).toBe('no answer');
	expect(s.innerDisposed).toBe(true);
}
