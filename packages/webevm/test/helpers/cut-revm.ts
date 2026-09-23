/**
 * cut-revm.ts — a SECOND code-under-test, for `webevm/revm` only.
 *
 * Why not a mode in ./cut.ts like every other library test: this bundle carries
 * the revm `.wasm` as a bundler-resolved asset, which needs its own esbuild
 * asset loader and adds ~1.2 MB to the page. Every other spec shares ./cut.ts
 * and must keep paying nothing for an engine it does not use — the same property
 * the revm subpath itself exists to preserve for consumers.
 *
 * Modes (one per revm spec):
 *   - 'revm-engine'  : the engine itself — same results + same gas as the
 *                      default engine, the node's own state, purity, BLOCKHASH,
 *                      both wasm delivery shapes, the refused state mode
 *   - 'conformance'  : the SHARED differential battery (helpers/conformance.ts)
 *                      run with the revm engine installed, in the one state mode
 *                      it serves
 *   - 'trusted-sender': the SHARED trusted-sender suite (helpers/trusted-sender.ts)
 *                      run with the revm engine installed — a tx submitted through
 *                      the `evm_*As` cheats executes as the CLAIMED sender, even
 *                      when the signature recovers to somebody else
 *   - 'sender-recovery': the OTHER sender mode (helpers/sender-recovery.ts):
 *                      `'recover'` derives the sender with the ENGINE's ecrecover
 *                      when one is installed, and must authenticate identically to
 *                      `tx.getSenderAddress()` — including on the transactions both
 *                      must REFUSE (a malformed signature, a high-`s` one, a wrong
 *                      recovery id), which is where a wrong answer is silent
 *   - 'post-state'   : the SHARED post-state differential (helpers/post-state.ts)
 *                      — five state-shaped transactions (creation, nested
 *                      creation, nested-frame storage, an EIP-161 emptying, a
 *                      selfdestruct) leaving state the default engine's cannot be
 *                      told apart from, read through the node's public surface
 *   - 'fees'         : the SHARED money differential (helpers/fees.ts) — what a
 *                      legacy, EIP-2930, EIP-1559 and storage-clearing-refund
 *                      transaction COSTS, measured on BALANCES (sender charged,
 *                      coinbase credited, base fee burnt) rather than on the
 *                      receipt's `effectiveGasPrice`
 *   - 'access-list' : the SHARED EIP-2930 battery (helpers/access-list.ts): the
 *                      same type-1 transaction WITH its access list and with an
 *                      EMPTY one, so the list is proven CHARGED (2,400 per address,
 *                      1,900 per key) and WARMED (the access inside execution costs
 *                      the warm price), which no cross-engine diff can see
 *   - 'state-roundtrip': the SHARED state round trips (helpers/state-roundtrip.ts)
 *                      — the four `evm_set*` cheats applied BETWEEN two revm
 *                      transactions and observed by the execution of the next, and a
 *                      `dumpState` taken AFTER one, reloaded into a fresh node that
 *                      keeps behaving identically. The two moments a cache spanning
 *                      a transaction would break, and nothing else does
 *   - 'genesis-cheats': the SHARED custom-genesis + `evm_set*` halves
 *                      (helpers/genesis-cheats-perf.ts) in the one state mode this
 *                      engine serves. Its trie-vs-none perf half stays on the
 *                      default engine, being a comparison BETWEEN the state modes
 *   - 'persist-reload': the SHARED IndexedDB persistence flow
 *                      (helpers/persistence-reload.ts) across a REAL page reload,
 *                      with revm executing the transactions whose state is persisted
 *   - 'storage-keys' : the storage-key agreement battery
 *                      (helpers/storage-keys.ts): the node's storage key is PACKED
 *                      and the ASYNC route (`putStorage`, which `@ethereumjs/evm`,
 *                      genesis, `loadState` and the cheats drive) must build the
 *                      SAME key as the SYNCHRONOUS one (`storageAt`, which revm
 *                      drives). Two formats that both work make every cross-route
 *                      read a MISS, which reads as ZERO at identical gas — invisible
 *                      to every other differential in this repo
 *   - 'revm-worker'   : the engine OFF THE MAIN THREAD, i.e. the README's recipe,
 *                      executed. The page drives ./revm-worker.ts (a consumer's
 *                      own worker module, which builds the engine INSIDE the
 *                      Worker) through the ordinary `createWorkerNode()` client,
 *                      and reads the engine identity, the reference gas, a
 *                      committing transaction's post-state and the main thread's
 *                      responsiveness back across the boundary
 *   - 'engine-misuse' : the recipe's one plausible TYPO, on this engine:
 *                      `createEngine: createRevmEngine({wasm})` (the promise) where
 *                      `createEngine: () => createRevmEngine({wasm})` belongs. The
 *                      main thread must be REJECTED with the reason rather than
 *                      left pending forever
 *   - 'concurrency'  : the SHARED concurrency battery (helpers/concurrency.ts) with
 *                      this engine installed. Its read-versus-write scans cannot
 *                      fail here — revm's `call` cannot commit, so it opens no
 *                      checkpoint level — but revm reads AND WRITES the node's
 *                      state through the same stacks, so two overlapping
 *                      TRANSACTIONS interleave exactly as they do on the default
 *                      engine. The half of ADR 0012 no engine-local fix covers
 *   - 'invalid-transactions': the SHARED refusal battery
 *                      (helpers/invalid-transactions.ts) — a replayed nonce, a
 *                      far-future nonce, an unaffordable transaction and a gas
 *                      limit below intrinsic gas, refused in the NODE's own words
 *                      on both engines, with every state reading unmoved
 */
import type {
	CodeUnderTest,
	RunResult,
	Timing,
} from 'playwright-browser-harness/contract';
import {captureEnv} from 'playwright-browser-harness/contract';
import {runRevmEngineChecks} from './revm-engine.js';
import {runRevmConformance} from './revm-conformance.js';
import {runRevmTrustedSender} from './revm-trusted-sender.js';
import {runRevmSenderRecovery} from './revm-sender-recovery.js';
import {runRevmPostState} from './revm-post-state.js';
import {runRevmFees} from './revm-fees.js';
import {runRevmAccessList} from './revm-access-list.js';
import {runRevmInvalidTransactions} from './revm-invalid-transactions.js';
import {runRevmStorageKeys} from './revm-storage-keys.js';
import {runRevmStateRoundTrip} from './revm-state-roundtrip.js';
import {runRevmConcurrency} from './revm-concurrency.js';
import {runRevmGenesisCheats} from './revm-genesis-cheats.js';
import {
	runRevmPersistWrite,
	runRevmPersistRead,
} from './revm-persistence-reload.js';
import {revmWorkerRoundtrip} from './revm-worker-roundtrip.js';
import {driveMisusedEngineWorker, reportEarlySignal} from './engine-misuse.js';

const cut: CodeUnderTest = {
	name: 'webevm/revm',

	async run(ctx): Promise<RunResult> {
		const errors: string[] = [];
		const timings: Timing[] = [];
		const results: Record<string, unknown> = {};

		// The engine itself: results + gas against the default engine, the node's
		// own state, purity, BLOCKHASH, both delivery shapes, the refused mode.
		if (ctx.params.mode === 'revm-engine') {
			try {
				results.revmEngine = await runRevmEngineChecks({
					runtimeWasmUrl: String(ctx.params.runtimeWasmUrl),
				});
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The engine OFF THE MAIN THREAD. The Worker is built from ./revm-worker.ts,
		// which is the file the README's recipe describes: the engine is constructed
		// inside the Worker (it cannot cross the boundary; see src/worker-client.ts's
		// refusal), and the main thread drives the result with unchanged client code.
		if (ctx.params.mode === 'revm-worker') {
			try {
				const r = await revmWorkerRoundtrip(
					String(ctx.params.workerUrl),
					Number(ctx.params.sumTo),
				);
				results.revmWorker = r.results;
				timings.push(...r.timings);
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The recipe MISTYPED: ./revm-misused-engine-worker.ts passes the PROMISE
		// `createRevmEngine()` returned instead of a function that calls it. The
		// consumer must be told, on the thread they wrote it on AND on the thread
		// that awaited a node.
		if (ctx.params.mode === 'engine-misuse') {
			try {
				results.mainThread = await driveMisusedEngineWorker(
					String(ctx.params.workerUrl),
				);
				// The worker's own half, on the PROMISE branch of the message. A plain
				// resolved promise, not a real engine: what is under test is that a
				// thenable is recognised as "you called it instead of passing it", and
				// compiling the wasm a second time here would measure nothing.
				results.early = reportEarlySignal(Promise.resolve({id: 'revm-wasm'}));
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED differential battery, with the revm engine installed. Same
		// steps, same reference, same assertions as `conformance.spec.ts` — only the
		// EVM behind the read path differs.
		if (ctx.params.mode === 'conformance') {
			try {
				results.revmConformance = await runRevmConformance();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED trusted-sender suite, with the revm engine installed. Same
		// differential, same gating, same claimed-sender assertions — only the EVM that
		// executes the transactions differs.
		if (ctx.params.mode === 'trusted-sender') {
			try {
				results.revmTrustedSender = await runRevmTrustedSender();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The OTHER sender mode: `'recover'` with the engine's own ecrecover behind
		// it, diffed against the `tx.getSenderAddress()` it replaces — on the senders
		// it derives AND on the transactions both must refuse.
		if (ctx.params.mode === 'sender-recovery') {
			try {
				results.revmSenderRecovery = await runRevmSenderRecovery();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED post-state differential, with the revm engine installed. Gas
		// equality says nothing about balances, code or storage, so this is the half of
		// the correctness bar the cross-backend gate structurally cannot see.
		if (ctx.params.mode === 'post-state') {
			try {
				results.revmPostState = await runRevmPostState();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED money differential, with the revm engine installed. A receipt can
		// carry the right `effectiveGasPrice` while the wrong amount left the sender,
		// so this one reads BALANCES: what the sender was charged, what the coinbase was
		// credited, and what was burnt.
		if (ctx.params.mode === 'fees') {
			try {
				results.revmFees = await runRevmFees();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED EIP-2930 battery, with the revm engine installed. A dropped access
		// list is invisible to every differential in this repo (both engines then charge
		// the same wrong number), so this one measures the SAME transaction with and
		// without the list and holds the difference to the protocol's own arithmetic.
		if (ctx.params.mode === 'access-list') {
			try {
				results.revmAccessList = await runRevmAccessList();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The storage KEY, on the one engine that reads it through a SECOND route.
		// Nothing else here can fail this: an engine that both writes and reads through
		// the async interface agrees with itself whatever the key format is.
		if (ctx.params.mode === 'storage-keys') {
			try {
				results.revmStorageKeys = await runRevmStorageKeys();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED refusal battery, with the revm engine installed. What a node
		// REFUSES must be the same on both engines, and so must what it leaves behind
		// when it refuses: a half-committed rejection is the worst outcome available
		// on this path and only a state reading catches it.
		if (ctx.params.mode === 'invalid-transactions') {
			try {
				results.revmInvalidTransactions = await runRevmInvalidTransactions();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED state round trips, with the revm engine installed. Every other
		// differential in this repo lives inside ONE transaction and would pass unchanged
		// for an engine that cached state between them; a cheat applied BETWEEN two
		// transactions and a dump taken AFTER one are the two moments that would not.
		if (ctx.params.mode === 'state-roundtrip') {
			try {
				results.revmStateRoundTrip = await runRevmStateRoundTrip();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED concurrency battery with revm installed. What it carries HERE is
		// write-versus-write and the dirty read: this engine cannot commit from a
		// `call`, so it is the transaction path and the node's own dispatcher that
		// two overlapping requests meet on.
		if (ctx.params.mode === 'concurrency') {
			try {
				results.revmConcurrency = await runRevmConcurrency();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED custom-genesis + cheat halves, with the revm engine installed. Both
		// write the node's state with no transaction to announce them, so they are what an
		// engine holding its own copy of state would execute AGAINST the wrong version of.
		if (ctx.params.mode === 'genesis-cheats') {
			try {
				results.revmGenesisCheats = await runRevmGenesisCheats();
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		// The SHARED persistence flow, with the revm engine installed. phase 'write'
		// builds + persists; the test reloads the page (wiping JS state); phase 'read'
		// creates a fresh revm-backed node that auto-loads from IndexedDB — which is the
		// harshest reader of a dump taken after a revm transaction, since nothing else
		// survives the reload.
		if (ctx.params.mode === 'persist-reload') {
			try {
				if (ctx.phase === 'write') {
					results.write = await runRevmPersistWrite();
				} else {
					results.read = await runRevmPersistRead(String(ctx.params.address));
				}
			} catch (e) {
				errors.push(String((e as Error)?.stack ?? (e as Error)?.message ?? e));
			}
			return {results, timings, errors, env: captureEnv()};
		}

		return {
			results: {},
			timings: [],
			errors: [`unknown mode: ${String(ctx.params.mode)}`],
			env: captureEnv(),
		};
	},
};

export default cut;
