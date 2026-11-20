#!/usr/bin/env node
/**
 * forge-load-allocs.mjs: a MANUAL check that forge really loads what `toAllocs`
 * exports. NOT run in CI (forge is not installed there): run it by hand after a
 * change to the export, with forge on the PATH, and record the result.
 *
 *   pnpm build && node scripts/forge-load-allocs.mjs [--keep]
 *
 * It does what rocketh did by hand with forge 1.7.1: deploy a contract whose
 * constructor stores a value on a `createDevNode()` chain, export the chain with
 * `toAllocs(await node.dumpState())`, then run a real `forge test` that calls
 * `vm.loadAllocs` on the file and checks the contract's code, nonce and slot,
 * a call to it, and the dev accounts' balances. The Foundry project is written
 * to a temporary directory (removed afterwards unless `--keep`); it needs no
 * forge-std, only a solc forge can find or download.
 *
 * Exits with forge's status.
 */
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateKeyToAccount} from 'viem/accounts';
import {createDevNode, toAllocs} from '../dist/index.js';

// anvil's account 0, the dev node's default deployer.
const DEPLOYER_KEY =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Runtime: return slot 0. Init: SSTORE(0, 0x2a), then return the runtime.
const RUNTIME = '60005460005260206000f3';
const INIT = `0x602a600055600b6011600039600b6000f3${RUNTIME}`;

const node = await createDevNode();
const deployer = privateKeyToAccount(DEPLOYER_KEY);
const [, other] = await node.request({method: 'eth_accounts'});
const raw = await deployer.signTransaction({
	chainId: Number(await node.request({method: 'eth_chainId'})),
	type: 'eip1559',
	nonce: 0,
	gas: 200_000n,
	maxFeePerGas: 10n ** 10n,
	maxPriorityFeePerGas: 1n,
	data: INIT,
});
const hash = await node.request({
	method: 'eth_sendRawTransaction',
	params: [raw],
});
const {contractAddress} = await node.request({
	method: 'eth_getTransactionReceipt',
	params: [hash],
});
const allocs = toAllocs(await node.dumpState());
await node.dispose();

const dir = mkdtempSync(join(tmpdir(), 'webevm-devnode-forge-'));
mkdirSync(join(dir, 'src'));
mkdirSync(join(dir, 'test'));
writeFileSync(join(dir, 'allocs.json'), JSON.stringify(allocs, null, 2));
writeFileSync(
	join(dir, 'foundry.toml'),
	'[profile.default]\nsrc = "src"\ntest = "test"\nfs_permissions = [{access = "read", path = "./"}]\n',
);
// Solidity wants EIP-55 checksummed address literals.
const {getAddress} = await import('viem');
const c = getAddress(contractAddress);
const d = getAddress(deployer.address);
const o = getAddress(other);
writeFileSync(
	join(dir, 'test', 'Allocs.t.sol'),
	`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface Vm {
    function loadAllocs(string calldata pathToAllocsJson) external;
    function load(address target, bytes32 slot) external view returns (bytes32);
    function getNonce(address account) external view returns (uint64);
}

contract AllocsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function setUp() public {
        vm.loadAllocs("allocs.json");
    }

    function test_theDeploymentIsLoaded() public view {
        address c = ${c};
        require(keccak256(c.code) == keccak256(hex"${RUNTIME}"), "code");
        require(vm.getNonce(c) == 1, "contract nonce");
        require(vm.load(c, bytes32(0)) == bytes32(uint256(42)), "slot 0");
        (bool ok, bytes memory out) = c.staticcall("");
        require(ok && abi.decode(out, (uint256)) == 42, "call");
    }

    function test_theDevAccountsAreLoaded() public view {
        require(vm.getNonce(${d}) == 1, "deployer nonce");
        require(${d}.balance == ${BigInt(allocs[deployer.address.toLowerCase()].balance)}, "deployer balance");
        require(${o}.balance == 10000 ether, "dev account 1 balance");
    }
}
`,
);

console.log(`[forge-load-allocs] project: ${dir}`);
const forge = spawnSync('forge', ['test', '-vv'], {cwd: dir, stdio: 'inherit'});
if (!process.argv.includes('--keep'))
	rmSync(dir, {recursive: true, force: true});
if (forge.error) {
	console.error(
		`[forge-load-allocs] could not run forge: ${forge.error.message}`,
	);
	process.exit(1);
}
process.exit(forge.status ?? 1);
