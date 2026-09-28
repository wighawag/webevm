/**
 * slim-node-checks.spec.ts — in-browser correctness + honesty assertions for the
 * node, run in real Chromium:
 *   - LEGACY (type-0) tx receipt does NOT crash; `effectiveGasPrice` present.
 *   - EIP-1559 receipt has `effectiveGasPrice` too, and the RPC transaction object
 *     carries the 1559 fee fields only where they mean something: present on a
 *     type-2 transaction, ABSENT (not `null`) on a legacy one.
 *   - Account/signing + unknown methods throw a real -32601 (never fake success).
 *   - dump/load persistence round-trips into a fresh node.
 *   - State root: without `computeStateRoot` it throws / zero block root; with
 *     `computeStateRoot: true` the node produces a REAL Merkle-Patricia root that
 *     matches the block header; both agree. (Result labels below: `'none'` is a
 *     node without `computeStateRoot`, `'trie'` one with it.)
 *   - A SELFDESTRUCTED account's storage is gone with and without it.
 *   - Engine seam: an engine that cannot start, cannot serve the node's
 *     configuration, or is not an engine at all fails LOUDLY at construction
 *     (never a silent fallback to the default engine), and an engine handed to
 *     `createWorkerNode` is refused by name rather than by a DataCloneError.
 */
import {test, expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {mountHarness} from 'playwright-browser-harness';

const here = dirname(fileURLToPath(import.meta.url));
const cut = resolve(here, './helpers/cut.ts');

test('node honesty + correctness (receipts, gaps, persistence, state root)', async ({
	page,
}) => {
	const h = await mountHarness(page, {
		cut,
		coi: false,
		nodePolyfills: ['buffer', 'process', 'global'],
	});
	const r = await h.run({phase: 'once', params: {mode: 'slim-node-checks'}});

	console.log('\n[slim-node-checks] errors:', r.errors);
	const c = r.results.slimNodeChecks as Record<string, any>;
	console.log('[slim-node-checks]', JSON.stringify(c, null, 2));

	expect(r.errors).toEqual([]);
	expect(c.legacyReceipt.ok).toBe(true); // legacy receipt does NOT crash
	expect(c.eip1559ReceiptHasEffGasPrice).toBe(true);

	// THE RPC TRANSACTION CARRIES A FEE FIELD ONLY WHERE IT MEANS SOMETHING. A
	// consumer tells the two transaction types apart with `'maxFeePerGas' in tx`,
	// so a key that EXISTS and is `null` on a legacy transaction is not cosmetic:
	// it routes the caller down the 1559 branch, which then dies on `BigInt(null)`
	// nowhere near the cause. geth omits it; so does this node. Asserted on both
	// types from the same node, because omitting it always would pass the legacy
	// half and break every 1559 consumer.
	expect(c.legacyTxFeeFields).toEqual({
		type: '0x0',
		hasMaxFeePerGas: false,
		hasMaxPriorityFeePerGas: false,
		hasGasPrice: true,
	});
	expect(c.eip1559TxFeeFields).toEqual({
		type: '0x2',
		hasMaxFeePerGas: true,
		hasMaxPriorityFeePerGas: true,
		hasGasPrice: true,
	});
	// account/signing methods + unknown methods throw -32601
	expect(c.gap_eth_sendTransaction).toBe('threw:-32601');
	expect(c.gap_eth_accounts).toBe('threw:-32601');
	expect(c.gap_personal_sign).toBe('threw:-32601');
	expect(c.gap_unknown_method).toBe('threw:-32601');
	// persistence round-trip
	expect(c.restoredNumber).toBe(c.number);
	// state root: without `computeStateRoot` there is no root (honest throw /
	// zero block root); `computeStateRoot: true` gives a REAL Merkle-Patricia
	// root in the node + the block header; both agree.
	expect(c.noneModeComputesNoRoot).toBe(true);
	expect(c.noneModeGetStateRootThrows).toBe(true);
	expect(c.noneBlockStateRootIsZero).toBe(true);
	expect(c.trieModeNumber).toBe('3');
	expect(c.trieModeRootIsReal).toBe(true);
	expect(c.trieBlockStateRootMatches).toBe(true);

	// ---- engine seam: the honest edges of `createNode({engine})` ----
	// The failure that matters is a SILENT FALLBACK. Every probe below reports the
	// engine the node CAME UP on, so a fallback would read as
	// `DID_NOT_THROW:@ethereumjs/evm` instead of quietly passing.

	// an engine that fails to initialise: construction fails, naming the engine and
	// the cause the engine itself reported.
	expect(c.engineInitFailure).not.toContain('DID_NOT_THROW');
	expect(c.engineInitFailure).toContain(c.engineInitCause);
	expect(c.engineInitFailure).toContain('test-engine-that-cannot-start');

	// a configuration the engine cannot serve: refused at construction, carrying
	// the engine's own reason...
	expect(c.engineRefusedConfiguration).not.toContain('DID_NOT_THROW');
	expect(c.engineRefusedConfiguration).toContain(
		'test-engine-one-chain cannot serve chain id 1',
	);
	// ...while the SAME engine serves the configuration it supports, so the
	// refusal is about the configuration, not the engine.
	expect(c.engineServedConfiguration).toBe(
		'DID_NOT_THROW:test-engine-one-chain',
	);

	// an object that is not an Engine is refused at construction, not at the
	// first read.
	expect(c.engineNotAnEngine).not.toContain('DID_NOT_THROW');
	expect(c.engineNotAnEngine).toContain('call');

	// HALF AN ENGINE IS REFUSED TOO, both ways it can be half, because the node
	// executes its transactions on the engine it was given and has nothing to fall
	// back to. An engine with only `call` used to be legal and left the node running
	// TWO EVMs; a `transact` that is present but not callable was legal-looking and
	// untested. Both now fail construction, naming the missing operation.
	for (const probe of [
		c.engineWithoutTransact,
		c.engineWithBrokenTransact,
	] as string[]) {
		expect(probe).not.toContain('DID_NOT_THROW');
		expect(probe).toContain('transact');
		expect(probe).toContain('test-engine-one-chain');
		// ...and it says out loud that the default engine is NOT substituted, which is
		// the fallback this contraction deleted.
		expect(probe).toContain('@ethereumjs/evm');
	}
	expect(c.engineWithoutTransact).toContain('got undefined');
	expect(c.engineWithBrokenTransact).toContain('got string');

	// the Worker path refuses an engine by NAME (an engine cannot be
	// structured-cloned into a Worker) rather than surfacing comlink's opaque
	// DataCloneError. The probe reports `threw:<name>:<message>`, so the ERROR
	// TYPE is what distinguishes the two: our own Error, not comlink's
	// DataCloneError DOMException. (The message mentions DataCloneError on
	// purpose, for anyone who got one before this guard existed.)
	expect(c.workerEngine).not.toContain('DID_NOT_THROW');
	expect(c.workerEngine).not.toContain('threw:DataCloneError');
	expect(c.workerEngine).toMatch(
		/^threw:Error:webevm\/worker-client: `engine`/,
	);
	expect(c.workerEngine).toContain('createNode');

	// (7) a CREATE never inherits storage that was already at its address.
	// Upstream `SimpleStateManager.clearStorage()` is an empty no-op that drops its
	// address argument, so without our override (src/state-manager.ts) a fresh
	// Counter deployed onto a seeded address returned 99 here instead of 0 —
	// silently, with a success receipt.
	for (const mode of ['none', 'trie'] as const) {
		expect(BigInt(c[`seededSlot0.${mode}`])).toBe(99n);
	}
	// BOTH MODES follow the reference spec (EIP-684, not EIP-7610): a storage-only
	// target is not a collision, so creation proceeds and the storage is CLEARED.
	// 'trie' used to REJECT it (MerkleStateManager's real storageRoot); it now runs
	// on the same flat state as 'none' (ADR 0014), so the modes agree. The nonce
	// and code collisions are still refused everywhere, in both modes and on both
	// engines: the nonce* and code* cases of helpers/storage-collision.ts, asserted
	// by trie-derived.spec.ts and revm-trie-derived.spec.ts.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[`deployStatus.${mode}`], mode).toBe('success');
		expect(c[`deployLandedOnTarget.${mode}`], mode).toBe(true);
		expect(c[`numberAfterRedeploy.${mode}`], mode).toBe('0');
	}

	// (8) a DESTROYED account takes its storage with it, in BOTH modes. Upstream
	// `SimpleStateManager.deleteAccount` tombstones the account and leaves storage
	// where it was, so without our override (src/state-manager.ts) `'none'` answered
	// `0x2a` for a slot belonging to a contract that no longer exists, while `'trie'`
	// — where the account's storage trie goes with the account — answered `0x0`. That
	// is the same class of upstream gap as (7) and the same fix site; here the two
	// modes AGREE, and that agreement is the assertion.
	for (const mode of ['none', 'trie'] as const) {
		expect(c[`selfdestructStatus.${mode}`]).toBe('success');
		// destroyed, not merely emptied: no code, no balance, beneficiary paid
		expect(c[`selfdestructCode.${mode}`]).toBe('0x');
		expect(BigInt(c[`selfdestructBalance.${mode}`])).toBe(0n);
		expect(BigInt(c[`selfdestructBeneficiary.${mode}`])).toBe(1000n);
		// ...and the slot it wrote before dying reads ZERO
		expect(`${mode}: ${BigInt(c[`selfdestructSlot0.${mode}`])}`).toBe(
			`${mode}: 0`,
		);
	}

	await h.dispose();
});
