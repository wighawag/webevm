/**
 * concurrency.ts — TWO EXECUTIONS AT ONCE MUST NOT DESTROY EACH OTHER'S STATE.
 *
 * The node's state manager is a STACK of checkpoint levels shared by reads and
 * transactions alike: `commit()` merges the top level down, `revert()` throws it
 * away, and neither knows who opened it. `engine.transact` checkpoints and
 * commits; the default engine's `engine.call` checkpoints and reverts, which is
 * what makes an `eth_call` pure and is a requirement of that EVM (see
 * `src/engine.ts`). Both are `async`, `@ethereumjs/evm` yields to the microtask
 * queue while it interprets, and before `createNode` serialised its public
 * surface nothing held a lock — so a read arriving mid-transaction popped the
 * level the transaction had just committed into, and the write was gone. ADR 0012.
 *
 * ## The harness is a DETERMINISTIC TICK-OFFSET SCAN, and that is the point
 *
 * A test that races two requests and hopes they overlap is worthless here: it
 * passes on the run where they happened not to, which is most of them. So the
 * second request is issued after an exact number of microtask ticks and the whole
 * offset range is swept, one fresh node per offset. Every offset is reported as a
 * character in a `pattern` string (`.` clean, `X` corrupt), so a failure names the
 * offsets it happened at instead of saying "sometimes".
 *
 * ## The two guards that stop a scan going quietly vacuous
 *
 * A scan proves nothing unless the second request really was issued while the
 * first was still executing, and a change that made requests settle before the
 * scan's ticks elapsed would leave every assertion below passing while testing
 * NOTHING. So each scan carries TWO measurements ABOUT ITSELF, and the specs
 * assert both:
 *
 *  - `issuedWhilePending` — how many offsets issued the second request while the
 *    first had not settled. It must clear a FLOOR ({@link MIN_OVERLAPPING}), not
 *    merely be non-zero: on a fast engine much of a sweep falls outside the window
 *    (revm in chromium overlaps 10 offsets of 32, against 32 of 32 for the default
 *    engine), and `> 0` would still pass if that collapsed to one.
 *  - `crossesTheBoundary` — one extra probe at {@link BOUNDARY_TICKS}, far beyond
 *    the sweep, which must find the first request ALREADY SETTLED. This is the
 *    guard `issuedWhilePending` cannot be: if `afterTicks` ever regressed to a
 *    no-op, every offset would collapse into a repeat of offset 0, the overlap
 *    count would read a healthy 32, and only this probe would notice.
 *
 * Be precise about what the pair does and does not establish. It is NOT "the
 * sweep starts inside the window and ends outside it" — on the default engine all
 * 32 offsets overlap, so the sweep never leaves the window at all, and the probe
 * sits 4096 ticks away rather than at offset 31. What they establish is that
 * several offsets genuinely land inside the window and that `afterTicks` still
 * ADVANCES, which is what a collapsed or clamped sweep would break.
 *
 * ## What each scan reproduces
 *
 * 1. {@link ConcurrencyReport.readVsWrite} — a READ-ONLY `eth_call` overlapping a
 *    transaction: the transaction reports success, emits its log, mines its block,
 *    and its write is missing.
 * 1b. {@link ConcurrencyReport.transferNonce} — the same with NO contract at all:
 *    what a plain transfer loses is the sender's NONCE, so every later transaction
 *    from that account is refused as "nonce too high" and the account stops.
 * 2. {@link ConcurrencyReport.tornState} — the read against a transaction that
 *    writes its own slot and then CALLs a contract which writes its own. The EVM
 *    checkpoints per MESSAGE FRAME, so the read's level can land between an inner
 *    frame's checkpoint and its commit: `a=1 b=0` is a state no execution of that
 *    transaction could produce.
 * 3. {@link ConcurrencyReport.callCommitsItsOwnWrite} — a READ THAT WRITES: point
 *    the overlapping `eth_call` at a contract that SSTOREs and the transaction's
 *    `commit()` pops the CALL's level into committed state.
 * 4. {@link ConcurrencyReport.writeVsWrite} — IT IS NOT ABOUT READS. Two
 *    transactions from two senders lose a write the same way, both reporting
 *    success and both holding a receipt.
 * 5. {@link ConcurrencyReport.dirtyRead} — the scope question, MEASURED rather than
 *    assumed: a read that never touches the EVM never checkpoints and so can never
 *    corrupt anything, but it walks the live stack including UNCOMMITTED levels, so
 *    mid-transaction it reports state no block contains. That is the argument for
 *    the lock being at `request` rather than around the executing methods only.
 * 6. {@link ConcurrencyReport.reentrancy} — the other half of a serialisation
 *    point, which is that it must not wait for itself: `mine`, `dumpState`,
 *    `loadState`, `eth_sendRawTransactionSync`, an `onNewHead` subscriber calling
 *    BACK into the node from inside the emit, and a persistence hook that runs
 *    while the lock is held. Each is raced against a deadline, so a deadlock fails
 *    with a name rather than hanging until playwright's own timeout.
 *
 * ENGINE-PARAMETERISED, like the conformance battery: {@link runConcurrencyChecks}
 * takes an optional engine factory, so the same implementation runs on the default
 * `@ethereumjs/evm` (`concurrency.spec.ts`) and on `webevm/revm`
 * (`revm-concurrency.spec.ts`). Running both is not symmetry for its own sake:
 * revm's `call` is structurally incapable of committing and needs no checkpoint,
 * so scans 1-3 cannot fail there — but revm reads and writes the node's state
 * through the SAME stacks (ADR 0005/0010), so 4, 5 and 6 can, and a fix that only
 * covered the read path would have been half a fix.
 */
import {createNode, type SlimNode} from '../../src/index.js';
import type {NodeOptions, SerializedState} from '../../src/types.js';
import {countingEngines, type EngineFactory} from './conformance.js';
// The guards' two numbers, shared with ../concurrency-expected.ts rather than
// copied into it: see that module for why a copy would drift unnoticed.
import {BOUNDARY_TICKS, MIN_OVERLAPPING} from './scan-constants.js';
import {privateKeyToAccount} from 'viem/accounts';

const CHAIN_ID = 31337;
const GENESIS_BALANCE = 10n ** 24n;
const MAX_FEE = 2_000_000_000n;
const MAX_PRIORITY_FEE = 1_000_000_000n;
const BURN = '0x00000000000000000000000000000000000000b0';

/** Two genesis-funded senders: the second is what makes scan 4 write-versus-write. */
const senderA = privateKeyToAccount(
	'0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const senderB = privateKeyToAccount(
	'0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

/**
 * HAND-ASSEMBLED, because the point is to make the window the scan aims at as
 * SMALL and as legible as possible: solc output would put a dispatcher, a calldata
 * check and a memory prologue between the call and the SSTORE, which is more
 * places for an offset to land and nothing gained. Each runtime below is one
 * statement.
 *
 * The init code is the standard `codecopy` preamble — push the runtime's length
 * and its offset within the init code (always 12, the preamble's own length), copy
 * it into memory, return it.
 */
function deployable(runtime: string): string {
	const body = runtime.replace(/^0x/, '');
	const len = body.length / 2;
	if (len > 255) throw new Error('runtime too long for this preamble');
	const push = `60${len.toString(16).padStart(2, '0')}`;
	return `0x${push}600c600039${push}6000f3${body}`;
}

/** `sstore(0, sload(0) + 1); log0(0, 0)` — a counter that also emits a log. */
const WRITER = deployable('0x60005460010160005560006000a000');
/** `sload(0); pop` — a READ and nothing else: it cannot write, at any offset. */
const READER = deployable('0x6000545000');
/** `sstore(0, 1)` — the INNER frame of the torn-state scan. */
const INNER = deployable('0x600160005500');
/**
 * `sstore(0, 1)` then `call(gas, inner, 0, 0, 0, 0, 0)` — writes its OWN slot and
 * then opens a second message frame that writes the inner contract's. Two frames,
 * two writes, and therefore a boundary an overlapping read can land in the middle
 * of.
 */
function outerCalling(inner: string): string {
	return deployable(
		'0x6001600055' +
			'60006000600060006000' +
			'73' +
			inner.slice(2) +
			'5af15000',
	);
}

/**
 * Resolve exactly `n` microtask ticks from now, then run `fn`.
 *
 * TICKS, NOT TIMERS. `setTimeout` lands between macrotasks, i.e. AFTER an
 * execution that never yields to the task queue has finished, so a timer-based
 * harness would mostly miss the window it is trying to hit. `@ethereumjs/evm`
 * yields to the MICROTASK queue while it interprets, so a chain of already-
 * resolved promises is what places a request inside another one's execution.
 */
function afterTicks<T>(n: number, fn: () => Promise<T> | T): Promise<T> {
	let p: Promise<unknown> = Promise.resolve();
	for (let i = 0; i < n; i++) p = p.then(() => {});
	return p.then(fn) as Promise<T>;
}

/**
 * The marker a timed-out path is reported under. It is a distinct CLASS rather
 * than a message match because the two outcomes mean opposite things: a hang is
 * the defect a serialisation point can introduce, while a thrown error is a
 * broken fixture, and reporting the second as the first sends the next reader
 * hunting for a deadlock that is not there.
 */
class DeadlineExceeded extends Error {}

/** Reject after `ms`, so a DEADLOCK is a named failure rather than a hung spec. */
function withDeadline<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new DeadlineExceeded(
						`${label}: did not settle within ${ms} ms — the node's serialisation point is waiting for itself`,
					),
				),
			ms,
		);
	});
	// The timer is CLEARED on the winning path: a battery that left one armed per
	// check would keep the page alive for the full deadline after it had finished.
	return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Which run of a scan a scenario is being asked for. */
type Phase = 'sweep' | 'control' | 'boundary';

/** One scan's worth of outcome. */
export interface ScanReport {
	/** Tick offsets swept, as `0..offsets-1`. */
	offsets: number;
	/** One character per offset: `.` clean, `X` corrupt. */
	pattern: string;
	/** The offsets that came back corrupt, so a failure names them. */
	corruptOffsets: number[];
	/**
	 * How many offsets issued the second request while the first was STILL
	 * PENDING. Must clear {@link MIN_OVERLAPPING}; see the module header for why
	 * `> 0` is not enough.
	 */
	issuedWhilePending: number;
	/**
	 * WHICH offsets those were, which is the part the count cannot say. A scan is
	 * only meaningful over the offsets where the two requests really met, so this
	 * is what says the sweep covers the offsets corruption actually appears at
	 * (0-2 for revm, 9-31 for the default engine, both measured with the fix
	 * removed). It must start at 0: at zero ticks the first request cannot have
	 * settled, because it needs at least one microtask to.
	 */
	overlappingOffsets: number[];
	/** What went wrong, at the first few corrupt offsets. */
	detail: string[];
	/** The same scenario with NOTHING in flight: the control, and always clean. */
	controlClean: boolean;
	/**
	 * At {@link BOUNDARY_TICKS} the first request had ALREADY SETTLED, i.e. the
	 * sweep's ticks really do advance relative to execution and the sweep ends
	 * outside the window it starts inside. False means the harness has gone blind.
	 */
	crossesTheBoundary: boolean;
}

export interface ConcurrencyReport {
	engineId: string;
	transactionsByEngine: Record<string, number> | null;
	/** 1. a read-only `eth_call` overlapping a transaction. */
	readVsWrite: ScanReport;
	/** 1b. the same with a plain TRANSFER: what is lost is the sender's nonce. */
	transferNonce: ScanReport;
	/**
	 * 2. the transaction's writes cut at a message-frame boundary, plus every
	 * distinct `(outer, inner)` post-state the SWEEP produced, counted.
	 */
	tornState: ScanReport & {tally: Record<string, number>};
	/** 3. the overlapping `eth_call` writes, and its write is COMMITTED. */
	callCommitsItsOwnWrite: ScanReport;
	/** 4. two transactions, and no read anywhere. */
	writeVsWrite: ScanReport;
	/** 5. a non-executing read is DIRTY mid-transaction. */
	dirtyRead: ScanReport;
	/** 6. the serialisation point does not wait for itself. */
	reentrancy: {
		/** Each path that had to complete, and what it produced. */
		completed: Record<string, string>;
		/** Any path that did not settle inside its deadline: a real hang. */
		deadlocked: string[];
		/**
		 * Any path that THREW. Kept apart from `deadlocked` because a broken
		 * fixture and a node waiting for itself are opposite diagnoses, and the
		 * first used to be reported as the second.
		 */
		failed: string[];
	};
}

// ---------------------------------------------------------------- node plumbing

interface Harness {
	node: SlimNode;
	sign(
		account: typeof senderA,
		to: string | null,
		data: string,
		value?: bigint,
	): Promise<string>;
	/** `contractAddress` off a deployment's receipt — never a derived address. */
	deploy(account: typeof senderA, initCode: string): Promise<string>;
	slot0(address: string): Promise<bigint>;
	blockNumber(): Promise<number>;
	nonceOf(address: string): Promise<bigint>;
}

async function harness(
	makeEngine: EngineFactory | undefined,
	// TYPED, not `Record<string, unknown>`: a misspelt `miningConfig` would
	// silently leave a check running on AUTO mining, and the check would still
	// "pass" while testing a scenario nobody wrote.
	options: Partial<NodeOptions> = {},
): Promise<Harness> {
	const node = await createNode({
		chainId: CHAIN_ID,
		initialBalances: {
			[senderA.address]: GENESIS_BALANCE,
			[senderB.address]: GENESIS_BALANCE,
		},
		...(makeEngine ? {engine: await makeEngine()} : {}),
		...options,
	});
	const nonces = new Map<string, number>();
	async function sign(
		account: typeof senderA,
		to: string | null,
		data: string,
		value = 0n,
	): Promise<string> {
		const nonce = nonces.get(account.address) ?? 0;
		nonces.set(account.address, nonce + 1);
		return account.signTransaction({
			chainId: CHAIN_ID,
			nonce,
			...(to ? {to: to as `0x${string}`} : {}),
			data: data as `0x${string}`,
			value,
			gas: 500_000n,
			maxFeePerGas: MAX_FEE,
			maxPriorityFeePerGas: MAX_PRIORITY_FEE,
			type: 'eip1559',
		});
	}
	return {
		node,
		sign,
		async deploy(account, initCode) {
			const raw = await sign(account, null, initCode);
			const hash = await node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const read = async () =>
				(await node.request({
					method: 'eth_getTransactionReceipt',
					params: [hash],
				})) as {contractAddress: string | null; status: string} | null;
			// SETUP, NOT SUBJECT MATTER: the manual-mining harnesses below need their
			// fixtures deployed before the scenario starts, so a submit that only
			// queued is mined here rather than each caller remembering to.
			const receipt = (await read()) ?? (await node.mine(), await read());
			if (receipt?.status !== '0x1' || !receipt.contractAddress) {
				throw new Error(`deployment failed: ${JSON.stringify(receipt)}`);
			}
			return receipt.contractAddress;
		},
		async slot0(address) {
			return BigInt(
				(await node.request({
					method: 'eth_getStorageAt',
					params: [address, '0x0', 'latest'],
				})) as string,
			);
		},
		async blockNumber() {
			return Number(
				(await node.request({method: 'eth_blockNumber', params: []})) as string,
			);
		},
		async nonceOf(address) {
			return BigInt(
				(await node.request({
					method: 'eth_getTransactionCount',
					params: [address, 'latest'],
				})) as string,
			);
		},
	};
}

/** What a transaction's receipt says, in the three fields every scan checks. */
async function receiptOf(
	node: SlimNode,
	hash: unknown,
): Promise<{status: string; logs: number; blockNumber: number} | null> {
	if (typeof hash !== 'string' || !hash.startsWith('0x')) return null;
	const r = (await node.request({
		method: 'eth_getTransactionReceipt',
		params: [hash],
	})) as {status: string; logs: unknown[]; blockNumber: string} | null;
	if (!r) return null;
	return {
		status: r.status,
		logs: r.logs.length,
		blockNumber: Number(r.blockNumber),
	};
}

/**
 * Track a request's own settlement, so a scan can report whether the second
 * request really was issued while the first was still running.
 */
interface Tracked {
	promise: Promise<unknown>;
	settled(): boolean;
}
function track(p: Promise<unknown>): Tracked {
	let done = false;
	return {
		promise: p.then(
			(v) => {
				done = true;
				return v;
			},
			(e: Error) => {
				done = true;
				return `ERROR: ${e.message}`;
			},
		),
		settled: () => done,
	};
}

/**
 * The scan driver, and the ONE place a scenario is run, so that every scan gets
 * the same three phases and none can quietly skip one:
 *
 *  - the SWEEP, `offsets` tick offsets with a fresh node each;
 *  - the CONTROL (`d === null`), the same scenario with nothing in flight at all.
 *    It is what separates "the fix is broken" from "the fixture is broken": a scan
 *    that fails at every offset AND in the control is telling you about itself;
 *  - the BOUNDARY probe, one run at {@link BOUNDARY_TICKS}, which must find the
 *    first request already settled. See the module header.
 */
async function scan(
	offsets: number,
	runOffset: (
		d: number | null,
		observe: (pendingAtIssue: boolean) => void,
		phase: Phase,
	) => Promise<string | null>,
): Promise<ScanReport> {
	let pattern = '';
	const corruptOffsets: number[] = [];
	const overlappingOffsets: number[] = [];
	const detail: string[] = [];
	for (let d = 0; d < offsets; d++) {
		let pending = false;
		const failure = await runOffset(
			d,
			(p) => {
				pending = p;
			},
			'sweep',
		);
		if (pending) overlappingOffsets.push(d);
		pattern += failure === null ? '.' : 'X';
		if (failure !== null) {
			corruptOffsets.push(d);
			if (detail.length < 6) detail.push(`d=${d}: ${failure}`);
		}
	}
	const control = await runOffset(null, () => {}, 'control');
	let pendingAtBoundary = true;
	await runOffset(
		BOUNDARY_TICKS,
		(p) => {
			pendingAtBoundary = p;
		},
		'boundary',
	);
	return {
		offsets,
		pattern,
		corruptOffsets,
		issuedWhilePending: overlappingOffsets.length,
		overlappingOffsets,
		detail,
		controlClean: control === null,
		crossesTheBoundary: !pendingAtBoundary,
	};
}

// ------------------------------------------------------------------- the scans

/**
 * 1 + 3. ONE transaction against the writer, ONE `eth_call` in flight.
 *
 * `target: 'reader'` points the call at a contract that only SLOADs, so the only
 * thing it can do to the transaction is destroy it. `target: 'writer'` points it
 * at the SSTOREing contract, so the call's OWN write sits in the level the
 * transaction commits and the counter answers 2 — a read that wrote.
 *
 * The expectation is the same either way and is the whole claim: after ONE
 * increment the counter reads exactly ONE, the receipt says success, it carries
 * its ONE log, and exactly one block was mined.
 */
function readVsWriteScan(
	makeEngine: EngineFactory | undefined,
	offsets: number,
	target: 'reader' | 'writer',
): Promise<ScanReport> {
	return scan(offsets, async (d, observe) => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const reader = await h.deploy(senderA, READER);
			const before = await h.blockNumber();
			const raw = await h.sign(senderA, writer, '0x');
			const tx = track(
				h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
			);
			const callP =
				d === null
					? Promise.resolve(null)
					: afterTicks(d, () => {
							observe(!tx.settled());
							return h.node
								.request({
									method: 'eth_call',
									params: [
										{to: target === 'reader' ? reader : writer, data: '0x'},
										'latest',
									],
								})
								.catch(() => null);
						});
			const [hash] = await Promise.all([tx.promise, callP]);
			if (typeof hash !== 'string' || !hash.startsWith('0x'))
				return `the transaction was refused: ${String(hash)}`;
			const receipt = await receiptOf(h.node, hash);
			const slot = await h.slot0(writer);
			const after = await h.blockNumber();
			if (receipt === null) return 'the transaction has no receipt';
			if (receipt.status !== '0x1') return `status ${receipt.status}`;
			if (receipt.logs !== 1) return `${receipt.logs} logs, expected 1`;
			if (after !== before + 1)
				return `block ${before} -> ${after}, expected exactly one block mined`;
			if (slot !== 1n)
				return `counter is ${slot} after ONE increment${
					slot === 0n
						? " (the transaction's write was LOST)"
						: " (the eth_call's own write was COMMITTED)"
				}`;
			return null;
		} finally {
			await h.node.dispose();
		}
	});
}

/**
 * 1b. THE SAME DEFECT WITH NO CONTRACT AT ALL: a plain transfer, whose only state
 * change is the sender's nonce and the two balances.
 *
 * It earns a scan of its own because of what it costs downstream. A lost nonce
 * makes every LATER transaction from that account unsendable — refused as "nonce
 * too high" rather than queued, this node having no mempool — so one interleaving
 * stops the ACCOUNT rather than damaging one transaction. The check is therefore
 * not only the nonce reading but a SECOND transfer, which is what a client does
 * next and what used to be refused.
 */
function transferNonceScan(
	makeEngine: EngineFactory | undefined,
	offsets: number,
): Promise<ScanReport> {
	return scan(offsets, async (d, observe) => {
		const h = await harness(makeEngine);
		try {
			const reader = await h.deploy(senderA, READER);
			const nonceBefore = await h.nonceOf(senderA.address);
			const raw = await h.sign(senderA, BURN, '0x', 1n);
			const tx = track(
				h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
			);
			const callP =
				d === null
					? Promise.resolve(null)
					: afterTicks(d, () => {
							observe(!tx.settled());
							return h.node
								.request({
									method: 'eth_call',
									params: [{to: reader, data: '0x'}, 'latest'],
								})
								.catch(() => null);
						});
			await Promise.all([tx.promise, callP]);
			const nonceAfter = await h.nonceOf(senderA.address);
			if (nonceAfter !== nonceBefore + 1n)
				return `nonce ${nonceBefore} -> ${nonceAfter}, expected ${nonceBefore + 1n}: the transfer's only state change was LOST`;
			const next = await h.sign(senderA, BURN, '0x', 1n);
			try {
				await h.node.request({
					method: 'eth_sendRawTransaction',
					params: [next],
				});
			} catch (e) {
				return `the NEXT transaction from that sender was refused: ${(e as Error).message}`;
			}
			return null;
		} finally {
			await h.node.dispose();
		}
	});
}

/**
 * 2. TORN STATE. The transaction writes its own slot and then CALLs a contract
 * that writes its own, so there are two message frames and the EVM checkpoints
 * per frame. The overlapping read's level can land BETWEEN an inner frame's
 * checkpoint and its commit, and what comes out is neither the whole transaction
 * nor none of it.
 *
 * TALLIED rather than pass/failed, because WHICH torn state appears is the
 * evidence: `a=1 b=0` and `a=0 b=1` are both states no execution of this
 * transaction could produce, and their presence is what separates "a transaction
 * is sometimes lost whole" from "a transaction's writes are cut at an arbitrary
 * frame boundary". The specs assert the tally has exactly one key.
 */
async function tornStateScan(
	makeEngine: EngineFactory | undefined,
	offsets: number,
): Promise<ConcurrencyReport['tornState']> {
	// The tally counts the SWEEP only. The control and the boundary probe are
	// different scenarios (nothing in flight, and nothing left in flight), so
	// folding them in would inflate the clean count by two and make the tally a
	// statement about the harness rather than about the sweep.
	const tally: Record<string, number> = {};
	const report = await scan(offsets, async (d, observe, phase) => {
		const h = await harness(makeEngine);
		try {
			const inner = await h.deploy(senderA, INNER);
			const outer = await h.deploy(senderA, outerCalling(inner));
			const reader = await h.deploy(senderA, READER);
			const raw = await h.sign(senderA, outer, '0x');
			const tx = track(
				h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
			);
			const callP =
				d === null
					? Promise.resolve(null)
					: afterTicks(d, () => {
							observe(!tx.settled());
							return h.node
								.request({
									method: 'eth_call',
									params: [{to: reader, data: '0x'}, 'latest'],
								})
								.catch(() => null);
						});
			await Promise.all([tx.promise, callP]);
			const a = await h.slot0(outer);
			const b = await h.slot0(inner);
			const whole = a === 1n && b === 1n;
			const key = whole ? 'both frames written' : `TORN outer=${a} inner=${b}`;
			if (phase === 'sweep') tally[key] = (tally[key] ?? 0) + 1;
			return whole ? null : key;
		} finally {
			await h.node.dispose();
		}
	});
	return {...report, tally};
}

/**
 * 4. TWO TRANSACTIONS, NO READ ANYWHERE — which is why a lock around the read
 * path would have been half a fix, and why this one is run on both engines.
 *
 * Two senders increment the same counter, the second delayed by `d` ticks. Both
 * must be accepted, both must hold a success receipt, the counter must reach 2,
 * and TWO blocks must exist: each auto-mined block takes its number from
 * `latestNumber + 1` read at the start of execution, so two overlapping
 * transactions were handed the same number and the second block overwrote the
 * first.
 */
function writeVsWriteScan(
	makeEngine: EngineFactory | undefined,
	offsets: number,
): Promise<ScanReport> {
	return scan(offsets, async (d, observe) => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const before = await h.blockNumber();
			const rawA = await h.sign(senderA, writer, '0x');
			const rawB = await h.sign(senderB, writer, '0x');
			const first = track(
				h.node.request({method: 'eth_sendRawTransaction', params: [rawA]}),
			);
			const secondP =
				d === null
					? Promise.resolve(null)
					: afterTicks(d, () => {
							observe(!first.settled());
							return h.node
								.request({method: 'eth_sendRawTransaction', params: [rawB]})
								.catch((e: Error) => `ERROR: ${e.message}`);
						});
			const [a, b] = await Promise.all([first.promise, secondP]);
			const expected = d === null ? 1 : 2;
			for (const [label, hash] of [
				['first', a],
				['second', b],
			] as const) {
				if (hash === null) continue;
				if (typeof hash !== 'string' || !hash.startsWith('0x'))
					return `the ${label} transaction was refused: ${String(hash)}`;
				const r = await receiptOf(h.node, hash);
				if (r === null) return `the ${label} transaction has no receipt`;
				if (r.status !== '0x1')
					return `the ${label} transaction reverted (${r.status})`;
			}
			const slot = await h.slot0(writer);
			if (slot !== BigInt(expected))
				return `counter is ${slot} after ${expected} increment(s), and every transaction reported SUCCESS`;
			const after = await h.blockNumber();
			if (after !== before + expected)
				return `block ${before} -> ${after}, expected ${expected} block(s): two transactions were given the same block number`;
			return null;
		} finally {
			await h.node.dispose();
		}
	});
}

/**
 * 5. IS A NON-EXECUTING READ SAFE? Measured, not assumed, because it is the
 * argument for putting the lock at `request` rather than around the methods that
 * execute.
 *
 * `eth_getBalance` and `eth_getTransactionCount` never touch the EVM and never
 * checkpoint, so they cannot corrupt anything. But they walk the live stack
 * INCLUDING uncommitted levels, so mid-transaction they report state no block
 * contains. The check is CONSISTENCY rather than a fixed value: the sender's
 * balance and nonce have moved if and only if `eth_blockNumber` says the block
 * they moved in exists. Anything else is a reading from a block that has not
 * happened — and, before the fix, one an overlapping `eth_call` could then
 * destroy.
 */
function dirtyReadScan(
	makeEngine: EngineFactory | undefined,
	offsets: number,
): Promise<ScanReport> {
	return scan(offsets, async (d, observe) => {
		const h = await harness(makeEngine);
		try {
			const balanceBefore = (await h.node.request({
				method: 'eth_getBalance',
				params: [senderA.address, 'latest'],
			})) as string;
			const nonceBefore = await h.nonceOf(senderA.address);
			const blockBefore = await h.blockNumber();
			const raw = await h.sign(senderA, BURN, '0x', 1n);
			const tx = track(
				h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
			);
			let mid: {balance: string; nonce: bigint; block: number} | undefined;
			const readP =
				d === null
					? Promise.resolve()
					: afterTicks(d, async () => {
							observe(!tx.settled());
							mid = {
								balance: (await h.node.request({
									method: 'eth_getBalance',
									params: [senderA.address, 'latest'],
								})) as string,
								nonce: await h.nonceOf(senderA.address),
								block: await h.blockNumber(),
							};
						});
			await Promise.all([tx.promise, readP]);
			// The CONTROL takes no mid-flight reading, so there is nothing to be
			// inconsistent: what it proves is that the fixture itself works.
			if (mid === undefined) {
				return (await h.nonceOf(senderA.address)) === nonceBefore + 1n
					? null
					: 'the control transfer did not land';
			}
			const stateMoved =
				mid.balance !== balanceBefore || mid.nonce !== nonceBefore;
			const blockMoved = mid.block !== blockBefore;
			if (stateMoved === blockMoved) return null;
			return `balance ${balanceBefore} -> ${mid.balance} and nonce ${nonceBefore} -> ${mid.nonce}, but eth_blockNumber still says ${mid.block}: a reading from a block that does not exist`;
		} finally {
			await h.node.dispose();
		}
	});
}

/**
 * 6. THE SERIALISATION POINT MUST NOT WAIT FOR ITSELF, which is the half a lock
 * gets wrong. Nothing inside the node re-enters a serialised entry point — the
 * internal `request`, `mineBlock`, `dumpState`, `loadState` and `currentStateRoot`
 * are all called directly, and only the returned object's members are wrapped —
 * but control DOES leave the node twice while the lock is held, and both times it
 * leaves into a CONSUMER's code. Those two are the last checks here.
 *
 * Every path is raced against a deadline, so a deadlock is a named entry in
 * `deadlocked` rather than a spec that hangs until playwright's own timeout and
 * then says nothing about which path did it.
 */
async function reentrancyChecks(
	makeEngine: EngineFactory | undefined,
): Promise<ConcurrencyReport['reentrancy']> {
	const completed: Record<string, string> = {};
	const deadlocked: string[] = [];
	const failed: string[] = [];
	const DEADLINE = 20_000;
	async function check(label: string, run: () => Promise<string>) {
		try {
			completed[label] = await withDeadline(label, DEADLINE, run());
		} catch (e) {
			// A HANG AND A THROW ARE DIFFERENT DIAGNOSES. Only the deadline means the
			// node is waiting for itself; anything else is this file's own fixture
			// breaking, and reporting it as a deadlock sends the next reader looking
			// for one that is not there.
			if (e instanceof DeadlineExceeded) deadlocked.push((e as Error).message);
			else failed.push(`${label}: ${(e as Error).message}`);
		}
	}

	// `mine()` concurrent with a submit. Both are PUBLIC entry points that take
	// the lock themselves, and `mine` reaches `mineBlock` + `persistIfNeeded`
	// (hence the internal `dumpState`) without passing through a wrapper.
	await check('mine-during-submit', async () => {
		const h = await harness(makeEngine, {miningConfig: {type: 'manual'}});
		try {
			const writer = await h.deploy(senderA, WRITER);
			await h.node.mine();
			const raw = await h.sign(senderA, writer, '0x');
			const txP = h.node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const mineP = afterTicks(4, () => h.node.mine());
			await Promise.all([txP, mineP]);
			return `counter=${await h.slot0(writer)} block=${await h.blockNumber()}`;
		} finally {
			await h.node.dispose();
		}
	});

	// `dumpState()` concurrent with a transaction. The dump must be a SNAPSHOT of
	// a settled state — taken wholly before the transaction or wholly after it,
	// never from the middle — so what it reports agrees with the live node.
	await check('dumpState-during-tx', async () => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const raw = await h.sign(senderA, writer, '0x');
			const txP = h.node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const dumpP = afterTicks(6, () => h.node.dumpState());
			const [, dump] = (await Promise.all([txP, dumpP])) as [
				unknown,
				SerializedState,
			];
			const slots = dump.storage[writer.toLowerCase()] ?? {};
			const dumped = Object.values(slots)[0] ?? '0x0';
			const blocks = dump.blocks.length;
			// The dump carries the counter iff it carries the block that wrote it.
			const agrees =
				(BigInt(dumped) === 1n && blocks === 3) ||
				(BigInt(dumped) === 0n && blocks === 2);
			return `dumpedCounter=${BigInt(dumped)} blocks=${blocks} live=${await h.slot0(writer)} snapshotAgrees=${agrees}`;
		} finally {
			await h.node.dispose();
		}
	});

	// `loadState()` concurrent with a transaction: a WRITE straight into state
	// from outside the EVM, which is the other direction.
	await check('loadState-during-tx', async () => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const snapshot = await h.node.dumpState();
			const raw = await h.sign(senderA, writer, '0x');
			const txP = h.node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const loadP = afterTicks(6, () => h.node.loadState(snapshot));
			await Promise.all([txP, loadP]);
			return `counter=${await h.slot0(writer)}`;
		} finally {
			await h.node.dispose();
		}
	});

	// `eth_sendRawTransactionSync` AWAITS MINING INSIDE THE CALL, so it holds the
	// lock across submit AND mine and an overlapping read waits for the whole
	// block rather than for the transaction. It must still answer with its
	// receipt — the fast path stays one round trip, it just stops being a window.
	await check('sendRawTransactionSync-with-call', async () => {
		const h = await harness(makeEngine, {miningConfig: {type: 'manual'}});
		try {
			const writer = await h.deploy(senderA, WRITER);
			const reader = await h.deploy(senderA, READER);
			await h.node.mine();
			const raw = await h.sign(senderA, writer, '0x');
			const syncP = h.node.request({
				method: 'eth_sendRawTransactionSync',
				params: [raw],
			});
			const callP = afterTicks(4, () =>
				h.node.request({
					method: 'eth_call',
					params: [{to: reader, data: '0x'}, 'latest'],
				}),
			);
			const [receipt] = (await Promise.all([syncP, callP])) as [
				{status: string; logs: unknown[]} | null,
				unknown,
			];
			return `status=${receipt?.status} logs=${receipt?.logs.length} counter=${await h.slot0(writer)}`;
		} finally {
			await h.node.dispose();
		}
	});

	// A newHeads SUBSCRIBER THAT CALLS BACK INTO THE NODE, which is exactly what a
	// game loop does: refetch on every new head. The callback is invoked from
	// inside `executeAndMine`, i.e. WHILE THE CHAIN IS HELD. It is emitted without
	// being awaited, so the request it issues QUEUES behind the transaction.
	//
	// THE ASSERTION IS THE ORDER, not the value. `latestNumber` is already updated
	// by `storeBlock` BEFORE the emit loop runs, so the callback's
	// `eth_blockNumber` answers 2 whether it was queued or served immediately — a
	// check on the number alone would prove only that nothing deadlocked. What
	// distinguishes the two is WHEN it resolves: after the transaction's own
	// request, because it went to the back of the chain.
	await check('onNewHead-calls-back', async () => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const order: string[] = [];
			let resolveRead: (v: string) => void = () => {};
			const readFromCallback = new Promise<string>((r) => {
				resolveRead = r;
			});
			const off = h.node.onNewHead((head) => {
				void h.node
					.request({method: 'eth_blockNumber', params: []})
					.then((n) => {
						order.push('callbackRead');
						resolveRead(`head=${head.number} readBack=${Number(n as string)}`);
					});
			});
			const raw = await h.sign(senderA, writer, '0x');
			await h.node
				.request({method: 'eth_sendRawTransaction', params: [raw]})
				.then(() => order.push('transaction'));
			const out = await readFromCallback;
			off();
			return `${out} order=${order.join(',')}`;
		} finally {
			await h.node.dispose();
		}
	});

	// A PERSISTENCE HOOK ALSO RUNS INSIDE THE LOCK, because the dump it is handed
	// must be a snapshot of a settled state and because saves have to stay
	// ORDERED. The hook here does what a real one does (await its I/O) and the
	// node must come back. A hook that called back into the node would deadlock:
	// that is the one rule this arrangement imposes on a consumer, and it is
	// stated in ADR 0012 rather than left to be discovered.
	await check('persistence-hook', async () => {
		const saved: number[] = [];
		const h = await harness(makeEngine, {
			persistence: {
				load: async () => null,
				save: async (state: SerializedState) => {
					await Promise.resolve();
					saved.push(state.blocks.length);
				},
			},
		});
		try {
			const writer = await h.deploy(senderA, WRITER);
			const raw = await h.sign(senderA, writer, '0x');
			const txP = h.node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const readP = afterTicks(5, () =>
				h.node.request({
					method: 'eth_call',
					params: [{to: writer, data: '0x'}, 'latest'],
				}),
			);
			await Promise.all([txP, readP]);
			return `saves=${saved.length} counter=${await h.slot0(writer)}`;
		} finally {
			await h.node.dispose();
		}
	});

	// A REQUEST THAT ARRIVES WHILE A SLOW SAVE IS IN FLIGHT MUST BE ANSWERED.
	//
	// This one exists because of a bug this suite did NOT catch. An earlier version
	// of the fix tried to make the re-entrancy rule above enforceable, by raising a
	// flag around the awaited `save()` and refusing any request issued while it was
	// set. It cannot work: the flag is held across the hook's I/O, and JavaScript
	// gives the node no way to tell a request from the hook's own stack from one
	// issued by anybody else in that window. A plain `setInterval` poller that had
	// never heard of persistence got four rejections off a 20 ms save, each saying
	// it had caused a deadlock.
	//
	// So the property is stated from the POLLER's side, which is the side a
	// consumer is on: a request issued from an ordinary timer during a save that
	// awaits real asynchronous I/O is served, correctly, with no refusal anywhere.
	// The save must also have completed by then, since it is awaited inside the
	// request that triggered it.
	await check('request-during-a-slow-save', async () => {
		let saves = 0;
		const h = await harness(makeEngine, {
			persistence: {
				load: async () => null,
				// A MACROTASK, deliberately: this is what an IndexedDB write or a
				// network round trip looks like, and it is what opens the window.
				save: async () => {
					await new Promise((r) => setTimeout(r, 20));
					saves++;
				},
			},
		});
		try {
			const writer = await h.deploy(senderA, WRITER);
			const raw = await h.sign(senderA, writer, '0x');
			const outcomes: string[] = [];
			const polled: Promise<void>[] = [];
			for (let i = 0; i < 4; i++) {
				polled.push(
					new Promise<void>((done) => {
						setTimeout(
							() => {
								h.node.request({method: 'eth_blockNumber', params: []}).then(
									() => {
										outcomes.push('answered');
										done();
									},
									(e: Error) => {
										outcomes.push(`REFUSED(${e.message.slice(0, 40)})`);
										done();
									},
								);
							},
							5 + i * 5,
						);
					}),
				);
			}
			await h.node.request({method: 'eth_sendRawTransaction', params: [raw]});
			await Promise.all(polled);
			const distinct = [...new Set(outcomes)].join('|');
			return `polls=${outcomes.length} outcomes=${distinct} saves=${saves} counter=${await h.slot0(writer)}`;
		} finally {
			await h.node.dispose();
		}
	});

	// INTERVAL MINING IS A CONCURRENCY SOURCE THE CONSUMER NEVER SEES: the timer
	// fires whenever the event loop reaches it, which before the serialisation
	// point meant in the middle of whatever was executing. With a period this far
	// below the work in flight the ticks also have to COALESCE, or they pile up and
	// drain as a burst of empty blocks.
	//
	// WHAT IS ASSERTED IS DETERMINISTIC: the transaction's write survives, and
	// every block the chain claims to have is resolvable. How MANY blocks a timer
	// produced in a given wall-clock window is not, so it is reported and not
	// asserted — a count pinned here would be a flake on a loaded CI runner.
	await check('interval-mining-under-load', async () => {
		const h = await harness(makeEngine, {
			miningConfig: {type: 'interval', intervalMs: 1},
		});
		try {
			const writer = await h.deploy(senderA, WRITER);
			const raw = await h.sign(senderA, writer, '0x');
			const txP = h.node.request({
				method: 'eth_sendRawTransaction',
				params: [raw],
			});
			const callP = afterTicks(8, () =>
				h.node.request({
					method: 'eth_call',
					params: [{to: writer, data: '0x'}, 'latest'],
				}),
			);
			await Promise.all([txP, callP]);
			await h.node.mine();
			// STOP THE TIMER BEFORE COUNTING. It is still firing every millisecond, so
			// a block scan taken while it runs is a race against a moving height AND
			// queues behind every arriving mine — on a loaded runner that can push this
			// check past its deadline and report a SLOW MACHINE as a deadlock, which is
			// the one diagnosis this file must not get wrong. `dispose` stops the timer
			// and leaves the node answering.
			await h.node.dispose();
			const height = await h.blockNumber();
			let resolvable = true;
			for (let n = 0; n <= height; n++) {
				const b = (await h.node.request({
					method: 'eth_getBlockByNumber',
					params: ['0x' + n.toString(16), false],
				})) as {number: string} | null;
				if (b === null) resolvable = false;
			}
			return `counter=${await h.slot0(writer)} blocksResolve=${resolvable}`;
		} finally {
			// Idempotent: `dispose` above already ran on the success path.
			await h.node.dispose();
		}
	});

	// A FAILING REQUEST MUST NOT TAKE THE QUEUE WITH IT. The chain's tail is only
	// ever a promise that FULFILS, so a rejected request cannot reject everything
	// queued behind it and turn one bad transaction into a dead node.
	await check('rejection-does-not-poison-the-queue', async () => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const raw = await h.sign(senderA, writer, '0x');
			// A replayed nonce: refused by the node, in flight beside a good one.
			const replay = await senderB.signTransaction({
				chainId: CHAIN_ID,
				nonce: 99,
				to: writer as `0x${string}`,
				value: 0n,
				gas: 500_000n,
				maxFeePerGas: MAX_FEE,
				maxPriorityFeePerGas: MAX_PRIORITY_FEE,
				type: 'eip1559',
			});
			const badP = h.node
				.request({method: 'eth_sendRawTransaction', params: [replay]})
				.then(
					() => 'unexpectedly accepted',
					(e: Error) =>
						e.message.includes('nonce too high') ? 'refused' : e.message,
				);
			const goodP = afterTicks(2, () =>
				h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
			);
			const [bad] = await Promise.all([badP, goodP]);
			const later = await h.node.request({
				method: 'eth_blockNumber',
				params: [],
			});
			return `bad=${bad} counter=${await h.slot0(writer)} laterRequestAnswered=${Number(later as string)}`;
		} finally {
			await h.node.dispose();
		}
	});

	// THE QUEUE IS FIFO AND IT DRAINS. Twelve requests issued at once, mixing
	// executing and non-executing methods, must all answer and the six increments
	// among them must all land — the general form of scans 1-4.
	await check('twelve-at-once', async () => {
		const h = await harness(makeEngine);
		try {
			const writer = await h.deploy(senderA, WRITER);
			const reader = await h.deploy(senderA, READER);
			const raws = [];
			for (let i = 0; i < 6; i++)
				raws.push(await h.sign(senderA, writer, '0x'));
			const inFlight: Promise<unknown>[] = [];
			for (const raw of raws) {
				inFlight.push(
					h.node.request({method: 'eth_sendRawTransaction', params: [raw]}),
				);
				inFlight.push(
					h.node.request({
						method: 'eth_call',
						params: [{to: reader, data: '0x'}, 'latest'],
					}),
				);
			}
			const out = await Promise.all(inFlight);
			return `answered=${out.length} counter=${await h.slot0(writer)} nonce=${await h.nonceOf(senderA.address)}`;
		} finally {
			await h.node.dispose();
		}
	});

	return {completed, deadlocked, failed};
}

/**
 * Run the whole battery. `offsets` is how wide each scan sweeps: with the
 * serialisation point removed, the corruption window opens around tick 9 on the
 * default engine (node AND chromium alike) and at tick 0 on revm, so 32 is
 * comfortably past the start on either runtime while staying inside a browser
 * test's budget. A window that MOVED cannot go unnoticed, because every scan
 * reports both of the guards described in the module header.
 */
export async function runConcurrencyChecks(options?: {
	makeEngine?: EngineFactory;
	offsets?: number;
}): Promise<ConcurrencyReport> {
	const offsets = options?.offsets ?? 32;
	const transactionsByEngine: Record<string, number> = {};
	// WHICH EVM ACTUALLY RAN THIS, counted at the seam rather than read off
	// `node.engine.id`: a suite whose transactions had quietly gone back to the
	// default engine would pass every assertion while measuring nothing.
	const makeEngine = options?.makeEngine
		? countingEngines(options.makeEngine, transactionsByEngine)
		: undefined;

	const probe = await harness(makeEngine);
	const engineId = probe.node.engine.id;
	await probe.node.dispose();

	return {
		engineId,
		transactionsByEngine: options?.makeEngine ? transactionsByEngine : null,
		readVsWrite: await readVsWriteScan(makeEngine, offsets, 'reader'),
		transferNonce: await transferNonceScan(makeEngine, offsets),
		tornState: await tornStateScan(makeEngine, offsets),
		callCommitsItsOwnWrite: await readVsWriteScan(
			makeEngine,
			offsets,
			'writer',
		),
		writeVsWrite: await writeVsWriteScan(makeEngine, offsets),
		dirtyRead: await dirtyReadScan(makeEngine, offsets),
		reentrancy: await reentrancyChecks(makeEngine),
	};
}
