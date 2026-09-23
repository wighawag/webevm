/**
 * concurrency-expected.ts — what BOTH engines must report from the concurrency
 * battery (test/helpers/concurrency.ts).
 *
 * WHY IT IS ONE SHARED ASSERTION AND NOT A TABLE OF LITERALS, unlike
 * ./state-roundtrip-expected.ts beside it. What that suite pins are VALUES an
 * engine could only have read from live state (a cheated slot, cheated code), so
 * the literals are the evidence. What this suite pins is the ABSENCE of an
 * interleaving, which has the same shape on every scan and on every engine: no
 * corrupt offset, one post-state, a clean control — plus, and this is the half
 * that keeps the file honest, a non-zero count of offsets that really did overlap.
 * Restating twenty identical `toEqual([])`s per engine would make the two copies
 * drift and would hide the one asymmetry that IS real (below).
 *
 * THE ONE ASYMMETRY, stated rather than papered over: scans 1-3 put an `eth_call`
 * in flight, and on `webevm/revm` those cannot fail however the node dispatches,
 * because that engine's `call` is structurally incapable of committing and
 * therefore opens no checkpoint level to be mis-popped (ADR 0005/0006). They are
 * still run there — a read has to stay pure and a transaction has to survive one,
 * on every engine — but the scans that CARRY the claim on revm are 4 (two
 * transactions, no read anywhere), 5 (a non-executing read is dirty
 * mid-transaction) and 6 (the lock does not wait for itself), because revm reads
 * and writes the node's state through the same stacks (ADR 0010). That is why the
 * fix is at `request` in the node rather than inside either engine.
 *
 * It lives in its own module because Playwright refuses to let one spec file
 * import another.
 */
import type {ConcurrencyReport, ScanReport} from './helpers/concurrency.js';
// ONE definition, shared with the battery rather than copied: a copy here would
// drift silently, since the assertion below is built entirely from this value.
import {MIN_OVERLAPPING} from './helpers/scan-constants.js';

/** `expect`, taken as a parameter so this module imports no test runner. */
type Expect = (actual: unknown) => {
	toBe(expected: unknown): void;
	toEqual(expected: unknown): void;
	toBeGreaterThan(expected: number): void;
};

/** Every scan: no corrupt offset, a clean control, and a sweep that still works. */
function assertScan(expect: Expect, name: string, scan: ScanReport) {
	// The OFFSETS are asserted, not the count, so a failure names where it
	// happened instead of saying how often.
	expect(`${name}: ${scan.corruptOffsets.join(',')}`).toBe(`${name}: `);
	expect(`${name}: ${scan.pattern}`).toBe(
		`${name}: ${'.'.repeat(scan.offsets)}`,
	);
	// The same scenario with nothing in flight, which must be clean whatever the
	// dispatcher does: it is what separates "the fix is broken" from "the fixture
	// is broken".
	expect(`${name} control clean: ${scan.controlClean}`).toBe(
		`${name} control clean: true`,
	);
	// THE TWO ANTI-VACUITY GUARDS, which are what make the assertions above worth
	// anything: several offsets really did issue their second request while the
	// first was still running, and `afterTicks` still ADVANCES (a far probe found
	// the first already settled). Without the second, an `afterTicks` that
	// regressed to a no-op would collapse every offset into a repeat of offset 0,
	// report a healthy overlap count, and test one interleaving while claiming to
	// test the whole range.
	// THE OVERLAP IS ASSERTED AS A PREFIX, not as a count, because a count cannot
	// say whether the sweep covered the offsets that matter. Corruption appears at
	// the LOW offsets on the faster engine (revm's write-versus-write failed at
	// 0-2 with the fix removed) and from 9 on the default one, and what overlaps
	// is always a run starting at 0: at zero ticks the first request cannot have
	// settled, since it needs at least one microtask to. So requiring the first
	// MIN_OVERLAPPING offsets to be present is what guarantees the window is
	// inside the sweep — measured as 0-9 on revm in chromium (10 of 32, the rest
	// of the sweep running after settlement) and 0-31 on the default engine.
	const window = Array.from({length: MIN_OVERLAPPING}, (_, i) => i);
	const covered = window.filter((d) => scan.overlappingOffsets.includes(d));
	expect(`${name} overlapped offsets ${covered.join(',')}`).toBe(
		`${name} overlapped offsets ${window.join(',')}`,
	);
	expect(`${name} crosses the boundary: ${scan.crossesTheBoundary}`).toBe(
		`${name} crosses the boundary: true`,
	);
}

export function assertConcurrencyReport(c: ConcurrencyReport, expect: Expect) {
	// 1. A READ-ONLY `eth_call` OVERLAPPING A TRANSACTION. The transaction
	// reported success, carried its one log and mined its block while its write
	// was missing — so in this environment a receipt that is not reverted used to
	// be no evidence that the state had moved.
	assertScan(expect, 'readVsWrite', c.readVsWrite);

	// 1b. THE SAME WITH NO CONTRACT AT ALL: a plain transfer, whose only state
	// change is the sender's nonce. Losing it does not damage one transaction, it
	// stops the ACCOUNT: every later transaction from it is refused as "nonce too
	// high", which this node does not queue.
	assertScan(expect, 'transferNonce', c.transferNonce);

	// 2. TORN STATE — the case that makes this more than "a transaction is
	// sometimes lost". The EVM checkpoints per MESSAGE FRAME, so an overlapping
	// read's level can land between an inner frame's checkpoint and its commit and
	// cut the transaction's writes at a frame boundary. Exactly ONE post-state may
	// appear, and it is the whole transaction: a tally with a `TORN ...` key in it
	// is a state no execution of that transaction could produce.
	assertScan(expect, 'tornState', c.tornState);
	// ...and the tally, which is the evidence rather than the verdict: exactly one
	// post-state may appear across the sweep, and it is the whole transaction.
	expect(Object.keys(c.tornState.tally)).toEqual(['both frames written']);
	expect(c.tornState.tally['both frames written']).toBe(c.tornState.offsets);

	// 3. A READ THAT WRITES. Point the overlapping `eth_call` at a contract that
	// SSTOREs and the transaction's own `commit()` used to pop the CALL's level
	// into committed state: the counter answered 2 after a single increment (or 0,
	// the transaction's write going the other way). Exactly 1 is the claim.
	assertScan(expect, 'callCommitsItsOwnWrite', c.callCommitsItsOwnWrite);

	// 4. IT IS NOT ABOUT READS, which is the argument for serialising at `request`
	// rather than around `engine.call`: two transactions from two senders lose a
	// write the same way, both reporting success and both holding a receipt, and
	// they used to be handed the same block number as well.
	assertScan(expect, 'writeVsWrite', c.writeVsWrite);

	// 5. THE SCOPE DECISION, MEASURED. A read that never touches the EVM never
	// checkpoints and so can never corrupt anything, but it walks the live stack
	// including UNCOMMITTED levels: mid-transaction it reported a debited balance
	// and an advanced nonce while `eth_blockNumber` still named the previous
	// block. Every reading must now agree with the block it claims to be from.
	assertScan(expect, 'dirtyRead', c.dirtyRead);

	// 6. THE LOCK MUST NOT WAIT FOR ITSELF — the failure mode a serialisation
	// point introduces, and a worse one than the bug if it ships, because a hung
	// node says nothing at all. Every path that re-enters the node from outside
	// (`mine`, `dumpState`, `loadState`, the sync send, an `onNewHead` subscriber
	// calling back from inside the emit, a persistence hook running while the lock
	// is held) had to settle inside its deadline.
	expect(c.reentrancy.deadlocked).toEqual([]);
	// A path that THREW is a broken fixture, not a deadlock, and is reported apart
	// so the two diagnoses cannot be confused for each other.
	expect(c.reentrancy.failed).toEqual([]);
	expect(Object.keys(c.reentrancy.completed).sort()).toEqual([
		'dumpState-during-tx',
		'interval-mining-under-load',
		'loadState-during-tx',
		'mine-during-submit',
		'onNewHead-calls-back',
		'persistence-hook',
		'rejection-does-not-poison-the-queue',
		'request-during-a-slow-save',
		'sendRawTransactionSync-with-call',
		'twelve-at-once',
	]);

	// WHAT EACH OF THESE CARRIES, stated rather than implied, because they are not
	// all the same kind of check and presenting them as one set overstates the
	// weaker half. THREE prove the serialisation property itself and would fail if
	// it were removed: `dumpState-during-tx` (a snapshot from inside a transaction
	// is a state the node was never in), `sendRawTransactionSync-with-call`, and
	// `twelve-at-once` (six transactions from ONE sender, pre-signed with
	// consecutive nonces, so any reordering or lost write surfaces as `nonce too
	// high`). THREE prove the things a serialisation point can BREAK and which
	// nothing else here would catch: no deadlock on `mine`/`loadState`, the
	// ordering of a re-entrant `onNewHead` subscriber, and that a refused request
	// does not poison the queue. The rest are the new failure modes this design
	// introduces and must therefore own: the loud refusal of a re-entrant
	// persistence hook, and a coalesced interval timer.
	expect(c.reentrancy.completed['mine-during-submit']).toBe(
		'counter=1 block=3',
	);
	// The dump is a snapshot of a SETTLED state: it carries the counter iff it
	// carries the block that wrote it. Taken from inside the transaction it
	// carried an incremented counter in a two-block chain, which is a state the
	// node was never in.
	expect(c.reentrancy.completed['dumpState-during-tx']).toBe(
		'dumpedCounter=1 blocks=3 live=1 snapshotAgrees=true',
	);
	expect(c.reentrancy.completed['loadState-during-tx']).toBe('counter=1');
	expect(c.reentrancy.completed['sendRawTransactionSync-with-call']).toBe(
		'status=0x1 logs=1 counter=1',
	);
	// The subscriber's own request saw the block it had just been told about, AND
	// it resolved after the transaction's own request rather than in the middle of
	// it. The order is the load-bearing half: `latestNumber` is updated before the
	// emit loop, so `readBack=2` alone would prove only that nothing deadlocked.
	expect(c.reentrancy.completed['onNewHead-calls-back']).toBe(
		'head=2 readBack=2 order=transaction,callbackRead',
	);
	expect(c.reentrancy.completed['persistence-hook']).toBe('saves=2 counter=1');
	// EVERY ONE OF FOUR POLLS DURING A SLOW SAVE IS ANSWERED. This is the check
	// that exists because of a bug the rest of the suite missed: an attempt to make
	// the re-entrancy rule enforceable refused requests from ANY caller while the
	// hook's I/O was in flight, telling an innocent poller it had caused a
	// deadlock. `outcomes=answered` (one distinct outcome, and that outcome) is the
	// property; `saves` proves the window was real rather than instantaneous.
	expect(c.reentrancy.completed['request-during-a-slow-save']).toBe(
		'polls=4 outcomes=answered saves=2 counter=1',
	);
	// Interval mining under load: the transaction's write survives a timer that is
	// firing far faster than the work in flight, and every block the chain claims
	// resolves. How MANY blocks the timer produced is reported by the helper and
	// deliberately not asserted — that is wall-clock dependent and would flake.
	expect(c.reentrancy.completed['interval-mining-under-load']).toBe(
		'counter=1 blocksResolve=true',
	);
	// A refused transaction is refused and the queue behind it keeps running: the
	// chain's tail only ever holds a FULFILLED promise, so one bad transaction
	// cannot reject every request queued behind it.
	expect(c.reentrancy.completed['rejection-does-not-poison-the-queue']).toBe(
		'bad=refused counter=1 laterRequestAnswered=2',
	);
	// Twelve requests issued at once, six of them transactions from ONE sender:
	// all answered, all six increments landed, and the sender's nonce moved by
	// exactly six (2 deployments + 6). Every lost write here shows up twice — as a
	// missing increment and as a `nonce too high` refusal of the next one.
	expect(c.reentrancy.completed['twelve-at-once']).toBe(
		'answered=12 counter=6 nonce=8',
	);
}
