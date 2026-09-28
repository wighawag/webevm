/**
 * post-state.ts — the POST-STATE differential: the same signed transactions on a
 * node running the engine under test and on a node running the default
 * `@ethereumjs/vm` one, with everything a consumer can observe about the state
 * they left behind diffed through the node's PUBLIC surface.
 *
 * WHY IT IS NOT THE GAS BAR AGAIN. The cross-backend gate in
 * `packages/benchmarks` proves the two engines charge the same gas, and gas
 * equality says NOTHING about balances, code or storage: an engine that charged
 * every transaction correctly and committed the wrong account changes passes it
 * completely. This file is the other half — a chain built on `webevm/revm`
 * has to be the SAME CHAIN as one built on `@ethereumjs/vm`, and the only way to
 * see that is to diff the state.
 *
 * WHY THROUGH `eth_getBalance` / `eth_getCode` / `eth_getStorageAt` /
 * `dumpState`, and never through the state manager: an assertion that reaches
 * into `accountStack` or `storageOverlays` tests OUR OWN BOOKKEEPING, which is
 * the thing most likely to be wrong in the same way on both sides of the diff.
 * These four are what a consumer actually has.
 *
 * ## The five state shapes, and why these five
 *
 * A value transfer (`revm-executes-the-first-transaction-with-commit`) touches
 * two balances and a nonce. Everything below it in the write half — the storage
 * clear, the code write, the account REMOVAL — is untouched by it, so this
 * battery is built out of the shapes that reach them:
 *
 *   1. **a CREATION**, whose account arrives at the host with its storage
 *      CLEARED FIRST (so a fresh contract can never inherit a previous life at
 *      its address) and then written and code-deposited, all in one frame;
 *   2. **a NESTED CREATION**, which additionally decides what the receipt's
 *      `contractAddress` is: the binding's outcome has no created-address field,
 *      so it is derived from the account changes, and "the entry flagged created"
 *      is ambiguous the moment there is more than one (see `createdAddressOf` in
 *      src/revm.ts). The child here also deploys CODE from inside a sub-frame;
 *   3. **STORAGE WRITTEN THROUGH NESTED CALL FRAMES**, which is where a host that
 *      wrote at the wrong checkpoint depth loses the inner frame's slots;
 *   4. **AN ACCOUNT EMPTIED TO NOTHING**, deleted under EIP-161 — the case a host
 *      that re-derives the rule instead of applying the binding's `deleted` flag
 *      gets subtly wrong;
 *   5. **A SELFDESTRUCT**, in BOTH of its EIP-6780 halves: a contract destroyed
 *      in the transaction that created it (removed, with its storage), and one
 *      created EARLIER (NOT removed — only its balance moves). The second half is
 *      not decoration: a host that deleted on every `SELFDESTRUCT` would produce
 *      a completely plausible wrong chain, and only a case where the engine says
 *      "not deleted" can catch it.
 *
 * ## The disappearing coinbase is CORRECT
 *
 * Every transaction here pays a ZERO priority fee, so the coinbase is credited
 * nothing, stays touched-and-empty, and is DELETED under EIP-161 — on both
 * engines. It therefore never appears in `dumpState` and `eth_getBalance` answers
 * zero for it. That looks alarming in a state diff and it is the single case here
 * most likely to be mistaken for a bug, which is why it is asserted rather than
 * avoided: see `coinbase*` below and the assertions in
 * `test/revm-post-state.spec.ts`.
 *
 * ## `dumpState` is compared STRUCTURALLY, never byte for byte
 *
 * A serialised dump's key order is INSERTION order, which is each engine's WRITE
 * order: revm hands its account changes over sorted by address, while
 * `@ethereumjs/vm` writes them in touch order. So a byte comparison of two
 * CORRECT dumps fails as soon as one transaction creates two accounts — which
 * shape 2 does, on purpose. What must match is the CONTENT: the same accounts,
 * the same code, the same slots, the same values.
 *
 * ENGINE-PARAMETERISED, like the conformance battery and the trusted-sender
 * suite: {@link runPostStateChecks} takes an engine factory for the node UNDER
 * TEST and always builds its REFERENCE node on the default engine, so the diff is
 * against `@ethereumjs/vm` itself rather than against a remembered number. The
 * absolute numbers are pinned separately, in ./post-state-expected.ts, because
 * two engines can agree on a state neither should have produced.
 */
import {createNode, type SlimNode} from '../../src/index.js';
import type {EngineFactory} from './conformance.js';
import {privateKeyToAccount} from 'viem/accounts';

export const PK =
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;
const account = privateKeyToAccount(PK);

/** The node's own default base fee, restated so the transactions can be signed. */
export const BASE_FEE = 1_000_000_000n;
/**
 * A distinctive block coinbase, so "the coinbase" is never confused with the zero
 * address (which is also the node's default `from` for a read).
 */
export const COINBASE = '0x00000000000000000000000000000000c0173a5e';
/** A pinned block timestamp, so the two chains cannot drift on `Date.now()`. */
export const TIMESTAMP = 1_700_000_000n;

// --- the bytecode fixtures ------------------------------------------------
// Hand-written rather than compiled, because each one has to reach ONE write
// callback and nothing else; a Solidity contract would drag its own dispatcher,
// memory layout and metadata hash through every assertion. Every byte is spelled
// out at its constant. The ones ./change-set.ts replays are EXPORTED, so the
// change-set differential runs the same shapes rather than a second copy of them.

/**
 * Runtime: `PUSH1 00, SLOAD, PUSH1 00, MSTORE, PUSH1 20, PUSH1 00, RETURN` —
 * returns storage slot 0. 11 bytes.
 */
const RUNTIME_RETURNS_SLOT0 = '60005460005260206000f3';
/** The same, for slot 1. 11 bytes. */
const RUNTIME_RETURNS_SLOT1 = '60015460005260206000f3';

/**
 * SHAPE 1 — init code that writes storage AND deploys code, in one frame:
 * `PUSH1 2a, PUSH1 00, SSTORE` (slot 0 = 42), then
 * `PUSH1 0b, PUSH1 11, PUSH1 00, CODECOPY, PUSH1 0b, PUSH1 00, RETURN` (copy the
 * 11 runtime bytes sitting at offset 0x11 and return them). 17 bytes of init.
 */
export const CREATE_INIT = `602a600055600b6011600039600b6000f3${RUNTIME_RETURNS_SLOT0}`;

/**
 * The CHILD of shape 2, as init code: `PUSH6 <6 runtime bytes>, PUSH1 00, MSTORE,
 * PUSH1 06, PUSH1 1a, RETURN` — `MSTORE` right-aligns in its 32-byte word, so the
 * six bytes land at offset 26 (0x1a). Its runtime is `PUSH1 01, PUSH1 00, SSTORE,
 * STOP`, which is never executed here; what matters is that CODE was deployed
 * from inside a sub-frame. 15 bytes.
 */
const CHILD_INIT = '656001600055006000526006601af3';

/**
 * SHAPE 2 — init code that performs a NESTED CREATION and remembers the address:
 * `PUSH15 <child init>, PUSH1 00, MSTORE` (right-aligned, so the child's 15 bytes
 * start at offset 0x11), `PUSH1 0f, PUSH1 11, PUSH1 00, CREATE`, `PUSH1 01,
 * SSTORE` (slot 1 = the child's address), then the same copy-and-return tail as
 * shape 1 with the runtime at offset 0x29. 41 bytes of init.
 *
 * TWO accounts are created by this ONE transaction, which is exactly what makes a
 * byte comparison of `dumpState` fail on a correct implementation, and what makes
 * "the entry flagged created" ambiguous for the receipt's `contractAddress`.
 */
export const NESTED_CREATE_INIT =
	`6e${CHILD_INIT}600052600f60116000f0600155600b6029600039600b6000f3` +
	RUNTIME_RETURNS_SLOT1;

/** SHAPE 3 — the INNER callee: `PUSH1 63, PUSH1 07, SSTORE, STOP` (slot 7 = 0x63). */
export const INNER_ADDR = '0x0000000000000000000000000000000000001111';
export const INNER_CODE = '0x60636007550000';
/**
 * SHAPE 3 — the OUTER caller: `PUSH1 01, PUSH1 00, SSTORE` (its own slot 0), then
 * `PUSH1 00` five times (retLength, retOffset, argsLength, argsOffset, value),
 * `PUSH20 <inner>`, `GAS`, `CALL`, `STOP`. Two frames, one slot each.
 */
export const OUTER_ADDR = '0x0000000000000000000000000000000000002222';
export const OUTER_CODE = `0x60016000556000600060006000600073${INNER_ADDR.slice(2)}5af100`;

/** SHAPE 4 — an account that EXISTS and is empty: balance 0, nonce 0, no code. */
export const EMPTY_ACCOUNT = '0x0000000000000000000000000000000000003333';

/**
 * SHAPE 5a — init code that writes storage and then DESTROYS ITSELF in the same
 * transaction: `PUSH1 2a, PUSH1 00, SSTORE`, `PUSH20 <beneficiary>,
 * SELFDESTRUCT`. Under EIP-6780 (Cancun) only a contract created in the SAME
 * transaction is really removed, which is why this one dies in its constructor.
 * It deploys no code, so what is left to observe is the account and its storage.
 */
export const SD_BENEFICIARY = '0x0000000000000000000000000000000000004444';
export const SELFDESTRUCT_INIT = `602a60005573${SD_BENEFICIARY.slice(2)}ff`;

/**
 * SHAPE 5b — the OTHER half of EIP-6780: a contract created in an EARLIER
 * transaction, whose `SELFDESTRUCT` moves its balance and removes NOTHING. Init
 * code: `PUSH1 63, PUSH1 09, SSTORE` (slot 9 = 0x63, so it has storage to keep),
 * then `PUSH22 <runtime>, PUSH1 00, MSTORE, PUSH1 16, PUSH1 0a, RETURN`. Its
 * runtime is `PUSH20 <beneficiary2>, SELFDESTRUCT`.
 */
const SD2_BENEFICIARY = '0x0000000000000000000000000000000000005555';
const SURVIVOR_RUNTIME = `73${SD2_BENEFICIARY.slice(2)}ff`;
export const SURVIVOR_INIT = `606360095575${SURVIVOR_RUNTIME}6000526016600af3`;

/** Genesis-funded, and the only sender in this battery. */
const SENDER = account.address;

interface Ctx {
	label: string;
	node: SlimNode;
}

async function buildNode(makeEngine?: EngineFactory): Promise<SlimNode> {
	return createNode({
		chainId: CHAIN_ID,
		miningConfig: {type: 'auto'},
		initialBalances: {[SENDER]: GENESIS_BALANCE},
		// Pinned so the two chains are the same chain in every respect the state can
		// see, and so the coinbase is a distinctive address rather than the zero one.
		blockEnv: {coinbase: COINBASE, timestamp: TIMESTAMP},
		engine: makeEngine ? await makeEngine() : undefined,
	});
}

/**
 * One signed transaction, sent to BOTH nodes as the SAME BYTES.
 *
 * Signing once and submitting the identical raw payload to each node removes the
 * last way the two chains could differ for a reason that is not the engine.
 *
 * THE GAS LIMIT IS EXPLICIT ON EVERY SHAPE, and that is not tidiness: an
 * `eth_estimateGas` figure is exact for the TOP frame, and EIP-150's 63/64 rule
 * then starves a sub-call by the 1/64 the top frame keeps. Measured here: shape 3
 * ran with an estimate, the inner `SSTORE` ran OUT OF GAS, the outer frame
 * ignored the failed `CALL` and the receipt still said `success` with the inner
 * slot unwritten — identically on both engines, so the diff was green while the
 * shape under test never happened.
 */
async function sendToBoth(
	nodes: Ctx[],
	nonce: number,
	tx: {
		to?: `0x${string}`;
		data?: `0x${string}`;
		value?: bigint;
		gas: bigint;
	},
): Promise<Record<string, any>> {
	const raw = await account.signTransaction({
		chainId: CHAIN_ID,
		type: 'eip1559',
		nonce,
		gas: tx.gas,
		maxFeePerGas: BASE_FEE,
		// ZERO TIP, on every transaction in this battery: it is what leaves the
		// coinbase touched-and-empty, and therefore DELETED under EIP-161.
		maxPriorityFeePerGas: 0n,
		...(tx.to !== undefined ? {to: tx.to} : {}),
		...(tx.data !== undefined ? {data: tx.data} : {}),
		...(tx.value !== undefined ? {value: tx.value} : {}),
	} as any);
	const receipts: Record<string, any> = {};
	for (const {label, node} of nodes) {
		receipts[label] = await node.request({
			method: 'eth_sendRawTransactionSync',
			params: [raw],
		});
	}
	return receipts;
}

/** Everything one node says about one address, through the public surface. */
async function readAccount(
	node: SlimNode,
	address: string,
	slots: string[],
): Promise<Record<string, string>> {
	const out: Record<string, string> = {
		balance: String(
			await node.request({
				method: 'eth_getBalance',
				params: [address, 'latest'],
			}),
		),
		nonce: String(
			await node.request({
				method: 'eth_getTransactionCount',
				params: [address, 'latest'],
			}),
		),
		code: String(
			await node.request({method: 'eth_getCode', params: [address, 'latest']}),
		),
	};
	for (const slot of slots) {
		out[`slot${slot}`] = String(
			await node.request({
				method: 'eth_getStorageAt',
				params: [address, slot, 'latest'],
			}),
		);
	}
	return out;
}

/**
 * A `dumpState` reduced to what a STRUCTURAL comparison is about: the same
 * accounts, the same code, the same slots, the same values, with every key order
 * removed by sorting.
 *
 * EXPORTED because it is the ONE definition of "two dumps are the same dump" in
 * this repo, and a second copy of it would be a second opinion. ./state-roundtrip.ts
 * compares a dump against the node it was RELOADED into with it, for the same
 * reason this file compares one across engines: key order follows write order and
 * is not part of the state.
 */
export function structuralDump(dump: any): {
	accounts: [string, string][];
	code: [string, string][];
	storage: [string, [string, string][]][];
} {
	const sorted = <T>(o: Record<string, T>): [string, T][] =>
		Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return {
		accounts: sorted(dump.accounts),
		code: sorted(dump.code),
		storage: sorted(dump.storage).map(
			([addr, slots]) =>
				[addr, sorted(slots as Record<string, string>)] as [
					string,
					[string, string][],
				],
		),
	};
}

export interface PostStateReport {
	referenceEngineId: string;
	engineId: string;
	/** Every `where/field` the two nodes disagreed about. Empty = the same chain. */
	mismatches: string[];
	/** What the node UNDER TEST reports, for the absolute assertions. */
	readings: Record<string, Record<string, string>>;
	receipts: Record<string, Record<string, string | null>>;
	dumpStructurallyEqual: boolean;
	dumpJsonIdentical: boolean;
	dumpAccountOrder: {reference: string[]; underTest: string[]};
	nestedCreateAccountCount: number;
	coinbaseInDump: {reference: boolean; underTest: boolean};
}

export async function runPostStateChecks(params: {
	makeEngine: EngineFactory;
}): Promise<PostStateReport> {
	const reference = await buildNode();
	const underTest = await buildNode(params.makeEngine);
	const nodes: Ctx[] = [
		{label: 'reference', node: reference},
		{label: 'underTest', node: underTest},
	];

	const mismatches: string[] = [];
	const readings: Record<string, Record<string, string>> = {};
	const receipts: Record<string, Record<string, string | null>> = {};

	/** Read one address on BOTH nodes, diff it, and keep what the engine said. */
	const diffAccount = async (
		where: string,
		address: string,
		slots: string[] = [],
	) => {
		const ref = await readAccount(reference, address, slots);
		const cut = await readAccount(underTest, address, slots);
		for (const field of Object.keys(ref)) {
			if (ref[field] !== cut[field])
				mismatches.push(
					`${where}.${field}: reference=${ref[field]} underTest=${cut[field]}`,
				);
		}
		readings[where] = cut;
	};

	/** The receipt fields this battery is about, diffed and kept. */
	const diffReceipt = (where: string, r: Record<string, any>) => {
		const fields = [
			'status',
			'contractAddress',
			'gasUsed',
			'effectiveGasPrice',
		];
		const kept: Record<string, string | null> = {};
		for (const f of fields) {
			const ref = r.reference?.[f] ?? null;
			const cut = r.underTest?.[f] ?? null;
			if (String(ref) !== String(cut))
				mismatches.push(
					`${where}.receipt.${f}: reference=${String(ref)} underTest=${String(cut)}`,
				);
			kept[f] = cut === null ? null : String(cut);
		}
		receipts[where] = kept;
		return r.underTest;
	};

	// ---- the fixtures both chains start from -------------------------------
	// Placed with the `evm_set*` cheats rather than deployed, so the shapes below
	// each contain exactly ONE transaction and the diff attributes cleanly.
	for (const {node} of nodes) {
		await node.request({
			method: 'evm_setCode',
			params: [INNER_ADDR, INNER_CODE],
		});
		await node.request({
			method: 'evm_setCode',
			params: [OUTER_ADDR, OUTER_CODE],
		});
		// An account that EXISTS and is empty. Shape 4 is about it being REMOVED, so
		// it has to be there first, and that is asserted rather than assumed.
		await node.request({
			method: 'evm_setBalance',
			params: [EMPTY_ACCOUNT, '0x0'],
		});
	}
	const emptyBefore = {
		reference:
			(await reference.dumpState()).accounts[EMPTY_ACCOUNT] !== undefined,
		underTest:
			(await underTest.dumpState()).accounts[EMPTY_ACCOUNT] !== undefined,
	};
	if (!emptyBefore.reference || !emptyBefore.underTest)
		mismatches.push(
			`setup: the empty account was not in state before shape 4 ` +
				`(reference=${emptyBefore.reference} underTest=${emptyBefore.underTest}), ` +
				`so its removal proves nothing`,
		);

	// ---- SHAPE 1: a CREATION that writes storage and deploys code ----------
	const created = diffReceipt(
		'creation',
		await sendToBoth(nodes, 0, {
			data: `0x${CREATE_INIT}`,
			gas: 200_000n,
		}),
	);
	await diffAccount('creation', created.contractAddress, ['0x0']);

	// ---- SHAPE 2: a NESTED CREATION ----------------------------------------
	// The receipt's `contractAddress` must name the TOP-LEVEL creation, on both
	// engines. revm reports no created address at all; src/revm.ts derives it from
	// the account changes, and with TWO entries flagged `created` the only thing
	// that disambiguates is `keccak(rlp(sender, nonce))`. A derivation that simply
	// took the first flagged entry would land on the CHILD here.
	const nested = diffReceipt(
		'nestedCreation',
		await sendToBoth(nodes, 1, {
			data: `0x${NESTED_CREATE_INIT}`,
			gas: 300_000n,
		}),
	);
	await diffAccount('nestedCreation', nested.contractAddress, ['0x1']);
	// Slot 1 holds the child's address, which is how the test finds an address
	// nothing told it: the CHILD is not named in any receipt.
	const childSlot = String(
		await underTest.request({
			method: 'eth_getStorageAt',
			params: [nested.contractAddress, '0x1', 'latest'],
		}),
	);
	const childAddress = `0x${childSlot.slice(-40)}`;
	await diffAccount('nestedCreationChild', childAddress);
	readings.nestedCreation.childAddress = childAddress;
	readings.nestedCreation.topLevelAddress = String(nested.contractAddress);

	// ---- SHAPE 3: storage written through NESTED CALL FRAMES ---------------
	diffReceipt(
		'nestedFrames',
		await sendToBoth(nodes, 2, {
			to: OUTER_ADDR as `0x${string}`,
			data: '0x',
			gas: 200_000n,
		}),
	);
	await diffAccount('nestedFramesOuter', OUTER_ADDR, ['0x0']);
	await diffAccount('nestedFramesInner', INNER_ADDR, ['0x7']);

	// ---- SHAPE 4: an account EMPTIED TO NOTHING, removed under EIP-161 -----
	diffReceipt(
		'emptiedAccount',
		await sendToBoth(nodes, 3, {
			to: EMPTY_ACCOUNT as `0x${string}`,
			value: 0n,
			gas: 100_000n,
		}),
	);
	await diffAccount('emptiedAccount', EMPTY_ACCOUNT);
	const emptyAfter = {
		reference:
			(await reference.dumpState()).accounts[EMPTY_ACCOUNT] !== undefined,
		underTest:
			(await underTest.dumpState()).accounts[EMPTY_ACCOUNT] !== undefined,
	};
	if (emptyAfter.reference !== emptyAfter.underTest)
		mismatches.push(
			`emptiedAccount.inDump: reference=${emptyAfter.reference} ` +
				`underTest=${emptyAfter.underTest}`,
		);
	readings.emptiedAccount.inDumpBefore = String(emptyBefore.underTest);
	readings.emptiedAccount.inDumpAfter = String(emptyAfter.underTest);

	// ---- SHAPE 5a: a SELFDESTRUCT that really removes the account ----------
	const destroyed = diffReceipt(
		'selfdestruct',
		await sendToBoth(nodes, 4, {
			data: `0x${SELFDESTRUCT_INIT}`,
			value: 1000n,
			gas: 200_000n,
		}),
	);
	await diffAccount('selfdestruct', destroyed.contractAddress, ['0x0']);
	await diffAccount('selfdestructBeneficiary', SD_BENEFICIARY);
	const destroyedAfter = {
		reference:
			(await reference.dumpState()).accounts[
				String(destroyed.contractAddress).toLowerCase()
			] !== undefined,
		underTest:
			(await underTest.dumpState()).accounts[
				String(destroyed.contractAddress).toLowerCase()
			] !== undefined,
	};
	if (destroyedAfter.reference !== destroyedAfter.underTest)
		mismatches.push(
			`selfdestruct.inDump: reference=${destroyedAfter.reference} ` +
				`underTest=${destroyedAfter.underTest}`,
		);
	readings.selfdestruct.inDumpAfter = String(destroyedAfter.underTest);

	// ---- SHAPE 5b: the EIP-6780 half that must NOT be removed --------------
	const survivor = diffReceipt(
		'survivorDeploy',
		await sendToBoth(nodes, 5, {
			data: `0x${SURVIVOR_INIT}`,
			value: 777n,
			gas: 200_000n,
		}),
	);
	await diffAccount('survivorBeforeKill', survivor.contractAddress, ['0x9']);
	diffReceipt(
		'survivorKill',
		await sendToBoth(nodes, 6, {
			to: survivor.contractAddress as `0x${string}`,
			data: '0x',
			gas: 200_000n,
		}),
	);
	// Created in an EARLIER transaction, so EIP-6780 moves its balance and removes
	// NOTHING: the code and the storage are still there afterwards. A host that
	// deleted on every `SELFDESTRUCT` would fail HERE and nowhere else.
	await diffAccount('survivorAfterKill', survivor.contractAddress, ['0x9']);
	await diffAccount('survivorBeneficiary', SD2_BENEFICIARY);

	// ---- the sender, and THE DISAPPEARING COINBASE -------------------------
	await diffAccount('sender', SENDER);
	// EXPECTED, ON BOTH ENGINES, AND NOT A BUG. Every transaction above paid a
	// ZERO priority fee, so the coinbase was credited nothing; it ends each
	// transaction touched-and-empty and EIP-161 deletes it. `@ethereumjs/vm` does
	// exactly the same thing. Anyone reading a state diff and finding the block's
	// own beneficiary missing should stop here rather than "fixing" it.
	await diffAccount('coinbase', COINBASE);
	const refDump = await reference.dumpState();
	const cutDump = await underTest.dumpState();
	const coinbaseInDump = {
		reference: refDump.accounts[COINBASE.toLowerCase()] !== undefined,
		underTest: cutDump.accounts[COINBASE.toLowerCase()] !== undefined,
	};
	if (coinbaseInDump.reference !== coinbaseInDump.underTest)
		mismatches.push(
			`coinbase.inDump: reference=${coinbaseInDump.reference} ` +
				`underTest=${coinbaseInDump.underTest}`,
		);

	// ---- `dumpState`, compared STRUCTURALLY --------------------------------
	const refStructural = JSON.stringify(structuralDump(refDump));
	const cutStructural = JSON.stringify(structuralDump(cutDump));
	if (refStructural !== cutStructural)
		mismatches.push(
			`dumpState: the two dumps differ in CONTENT.\n  reference=${refStructural}\n  underTest=${cutStructural}`,
		);

	const report: PostStateReport = {
		referenceEngineId: reference.engine.id,
		engineId: underTest.engine.id,
		mismatches,
		readings,
		receipts,
		dumpStructurallyEqual: refStructural === cutStructural,
		// Reported, NOT asserted. Key order follows each engine's write order, so
		// this is expected to be false the moment a transaction creates two
		// accounts — it is the REASON the comparison above is structural, and it
		// would still be a correct implementation if it ever became true.
		dumpJsonIdentical:
			JSON.stringify({
				accounts: refDump.accounts,
				code: refDump.code,
				storage: refDump.storage,
			}) ===
			JSON.stringify({
				accounts: cutDump.accounts,
				code: cutDump.code,
				storage: cutDump.storage,
			}),
		dumpAccountOrder: {
			reference: Object.keys(refDump.accounts),
			underTest: Object.keys(cutDump.accounts),
		},
		// The precondition that makes the structural comparison load-bearing: ONE
		// transaction created TWO accounts (the nested creation and its child).
		nestedCreateAccountCount: [
			String(nested.contractAddress).toLowerCase(),
			childAddress.toLowerCase(),
		].filter((a) => cutDump.accounts[a] !== undefined).length,
		coinbaseInDump,
	};

	await reference.dispose();
	await underTest.dispose();
	return report;
}
