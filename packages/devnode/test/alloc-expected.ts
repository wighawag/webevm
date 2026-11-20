/**
 * alloc-expected.ts: what ./helpers/alloc-checks.ts must observe, wherever it
 * runs (Node or a browser page). Shared by both tests in ./alloc.spec.ts.
 */
import {expect} from '@playwright/test';
import {ANVIL_ACCOUNTS} from './dev-node-expected.js';
import {RUNTIME_CODE} from './helpers/alloc-checks.js';

const TEN_THOUSAND_ETH = 10_000n * 10n ** 18n;
const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const WORD = /^0x[0-9a-f]{64}$/;
const ZERO_WORD = `0x${'00'.repeat(32)}`;

export function assertAllocs(c: Record<string, any>) {
	for (const mode of ['recover', 'trusted']) {
		const r = c[mode];
		expect(r, mode).toBeTruthy();
		expect(r.accounts).toEqual(ANVIL_ACCOUNTS);
		expect(r.deployed.status).toBe('0x1');
		expect(r.deployed.contractAddress).toBe(r.deployed.expectedContractAddress);

		const allocs = r.allocs as Record<string, any>;
		const contract = r.deployed.contractAddress as string;
		const deployer = ANVIL_ACCOUNTS[0];

		// THE CASE rocketh proved: the contract, its nonce (EIP-161: 1), balance,
		// code, and the slot its constructor stored, key and value padded to 32 bytes.
		expect(allocs[contract]).toEqual({
			nonce: '0x1',
			balance: '0x0',
			code: RUNTIME_CODE,
			storage: {[ZERO_WORD]: `0x${'00'.repeat(31)}2a`},
		});

		// The deployer: nonce 1, its genesis balance less the fee it paid.
		const spent =
			BigInt(r.deployed.gasUsed) * BigInt(r.deployed.effectiveGasPrice);
		expect(spent > 0n).toBe(true);
		expect(allocs[deployer]).toEqual({
			nonce: '0x1',
			balance: `0x${(TEN_THOUSAND_ETH - spent).toString(16)}`,
			code: '0x',
			storage: {},
		});
		expect(allocs[deployer].balance).toBe(r.deployed.deployerBalance);

		// THE DEV ACCOUNTS' GENESIS BALANCES are in the export.
		for (const account of ANVIL_ACCOUNTS.slice(1)) {
			expect(allocs[account], account).toEqual({
				nonce: '0x0',
				balance: `0x${TEN_THOUSAND_ETH.toString(16)}`,
				code: '0x',
				storage: {},
			});
		}

		// EVERY account the dump holds is exported, and nothing else; every entry
		// has exactly the four fields, in forge's forms.
		expect(r.allocAddresses).toEqual(r.dumpAddresses);
		for (const [address, entry] of Object.entries(allocs)) {
			expect(address).toMatch(/^0x[0-9a-f]{40}$/);
			expect(Object.keys(entry).sort()).toEqual([
				'balance',
				'code',
				'nonce',
				'storage',
			]);
			expect(entry.nonce).toMatch(QUANTITY);
			expect(entry.balance).toMatch(QUANTITY);
			expect(entry.code).toMatch(/^0x([0-9a-f]{2})*$/);
			for (const [slot, value] of Object.entries(entry.storage)) {
				expect(slot).toMatch(WORD);
				expect(value).toMatch(WORD);
			}
		}

		// A persisted (JSON) dump and a reloaded one export the same alloc.
		expect(r.persistedEqual).toBe(true);
		expect(r.reloadedEqual).toBe(true);
		expect(r.roundTrips).toBe(true);
	}
	// The fabricated signature changes nothing the alloc carries.
	expect(c.trusted.allocs[c.trusted.deployed.contractAddress]).toEqual(
		c.recover.allocs[c.recover.deployed.contractAddress],
	);
}
